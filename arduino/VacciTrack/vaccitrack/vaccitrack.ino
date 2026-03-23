/*
 * VacciTrack — Arduino Firmware v2.0
 * Hardware : Arduino Uno/Nano + DHT11 + 16x2 I2C LCD + Buzzer + 3 LEDs
 * Wiring   :
 *   DHT11 DATA  → D7
 *   Buzzer      → D8
 *   LED Red     → D3  (DANGER)
 *   LED Yellow  → D4  (WARNING)
 *   LED Green   → D5  (SAFE)
 *   LCD SDA     → A4  | SCL → A5  (I2C)
 *
 * Serial protocol (9600 baud, JSON lines):
 *   TX → {"temp":5.2,"hum":62.0}
 *   TX → {"error":"sensor_failed"}
 *   RX ← {"min":2,"max":8,"warn":12}   (optional config from server)
 */

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>

// ── Pin definitions ────────────────────────────────────────────
#define DHTPIN        7
#define DHTTYPE       DHT11
#define BUZZER_PIN    8
#define LED_RED       3
#define LED_YELLOW    4
#define LED_GREEN     5

// ── Thresholds (updated by server via serial) ──────────────────
float SAFE_MIN  =  2.0;
float SAFE_MAX  =  8.0;
float WARN_MAX  = 12.0;

// ── Timing ────────────────────────────────────────────────────
#define READ_INTERVAL   3000   // ms between readings
#define WARN_BUZZ_EVERY 4000   // ms between warning beeps
#define DANGER_BUZZ_MS  350    // danger alternating beep period
#define LED_BLINK_MS    600    // WARNING LED blink period

// ── State ─────────────────────────────────────────────────────
unsigned long lastReadTime  = 0;
unsigned long lastBuzzTime  = 0;
unsigned long lastBlinkTime = 0;
bool          ledBlinkState = false;
bool          buzzToggle    = false;

uint8_t       errorCount    = 0;
uint16_t      readingCount  = 0;
String        currentState  = "UNKNOWN";
float         sumTemp       = 0, sumHum = 0;

// ── Custom LCD chars ───────────────────────────────────────────
byte degreeChar[8] = { 0b00110,0b01001,0b01001,0b00110,0b00000,0b00000,0b00000,0b00000 };
byte heartChar[8]  = { 0b00000,0b01010,0b11111,0b11111,0b01110,0b00100,0b00000,0b00000 };
byte warnChar[8]   = { 0b00100,0b01110,0b01110,0b11111,0b11111,0b00100,0b00000,0b00000 };

LiquidCrystal_I2C lcd(0x27, 16, 2);
DHT dht(DHTPIN, DHTTYPE, 16);

// ── Helpers ────────────────────────────────────────────────────
void setLEDs(bool r, bool y, bool g) {
  digitalWrite(LED_RED,    r ? HIGH : LOW);
  digitalWrite(LED_YELLOW, y ? HIGH : LOW);
  digitalWrite(LED_GREEN,  g ? HIGH : LOW);
}

void selfTest() {
  // Cycle LEDs
  int leds[] = {LED_GREEN, LED_YELLOW, LED_RED};
  for (int i = 0; i < 3; i++) {
    digitalWrite(leds[i], HIGH);
    tone(BUZZER_PIN, 800 + i * 400, 120);
    delay(220);
    digitalWrite(leds[i], LOW);
  }
  noTone(BUZZER_PIN);
}

// ── LCD update ────────────────────────────────────────────────
// temp    = adjusted temperature (raw - 22), used for all logic
// rawTemp = actual sensor reading, shown on LCD for reference
void updateLCD(float temp, float rawTemp, String state) {
  // Row 0: T: adjusted°C  A: actual°C
  lcd.setCursor(0, 0);
  lcd.print("T:");
  if (temp >= 0 && temp < 10) lcd.print(" ");
  lcd.print(temp, 1);
  lcd.write(byte(0));   // degree symbol
  lcd.print("C A:");
  lcd.print(rawTemp, 1);
  lcd.write(byte(0));
  lcd.print("  ");

  // Row 1: Status + reading counter
  lcd.setCursor(0, 1);
  if (state == "SAFE") {
    lcd.write(byte(1));   // heart
    lcd.print(" SAFE ");
    lcd.print("#");
    lcd.print(readingCount);
    lcd.print("     ");
  } else if (state == "WARNING") {
    lcd.write(byte(2));   // warn
    lcd.print(" WARNING!   ");
  } else if (state == "DANGER") {
    lcd.print("\x7e VACCINE DMG! ");   // → arrow
  } else {
    lcd.print("Initializing... ");
  }
}

// ── Non-blocking buzzer ───────────────────────────────────────
void handleBuzzer(String state) {
  unsigned long now = millis();
  if (state == "SAFE") {
    noTone(BUZZER_PIN);
  } else if (state == "WARNING") {
    if (now - lastBuzzTime >= WARN_BUZZ_EVERY) {
      tone(BUZZER_PIN, 1200, 200);
      lastBuzzTime = now;
    }
  } else if (state == "DANGER") {
    if (now - lastBuzzTime >= DANGER_BUZZ_MS) {
      buzzToggle = !buzzToggle;
      tone(BUZZER_PIN, buzzToggle ? 2800 : 1600, DANGER_BUZZ_MS - 20);
      lastBuzzTime = now;
    }
  }
}

// ── Non-blocking WARNING LED blink ────────────────────────────
void handleLEDs(String state) {
  if (state == "SAFE") {
    setLEDs(false, false, true);
  } else if (state == "DANGER") {
    setLEDs(true, false, false);
  } else if (state == "WARNING") {
    unsigned long now = millis();
    if (now - lastBlinkTime >= LED_BLINK_MS) {
      ledBlinkState = !ledBlinkState;
      setLEDs(false, ledBlinkState, false);
      lastBlinkTime = now;
    }
  } else {
    setLEDs(false, false, false);
  }
}

// ── Serial config receiver ────────────────────────────────────
// Accepts: {"min":2,"max":8,"warn":12}
void checkSerialInput() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (!line.startsWith("{")) return;

  // Simple key scanner — avoids heavy JSON lib
  auto extractFloat = [&](const char* key) -> float {
    int idx = line.indexOf(key);
    if (idx == -1) return -999;
    idx += strlen(key);
    while (idx < (int)line.length() && !isDigit(line[idx]) && line[idx] != '-') idx++;
    return line.substring(idx).toFloat();
  };

  float mn = extractFloat("\"min\":");
  float mx = extractFloat("\"max\":");
  float wn = extractFloat("\"warn\":");

  bool changed = false;
  if (mn != -999) { SAFE_MIN = mn; changed = true; }
  if (mx != -999) { SAFE_MAX = mx; changed = true; }
  if (wn != -999) { WARN_MAX = wn; changed = true; }

  if (changed) {
    Serial.println("{\"config\":\"ok\"}");
    // Brief LCD confirmation
    lcd.setCursor(0, 1);
    lcd.print("Config updated! ");
    delay(800);
  }
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(9600);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_RED,    OUTPUT);
  pinMode(LED_YELLOW, OUTPUT);
  pinMode(LED_GREEN,  OUTPUT);
  setLEDs(false, false, false);
  noTone(BUZZER_PIN);

  lcd.init();
  lcd.backlight();
  lcd.createChar(0, degreeChar);
  lcd.createChar(1, heartChar);
  lcd.createChar(2, warnChar);

  // Splash screen
  lcd.setCursor(0, 0); lcd.print("  \x7e VacciTrack  ");
  lcd.setCursor(0, 1); lcd.print("   v2.0  PHC    ");
  delay(1500);

  // Self-test
  lcd.setCursor(0, 1); lcd.print("  Self-test...  ");
  selfTest();
  delay(500);

  // Start sensor
  dht.begin();
  lcd.setCursor(0, 1); lcd.print(" Sensor warmup  ");
  delay(2000);
  lcd.clear();
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  checkSerialInput();
  handleBuzzer(currentState);
  handleLEDs(currentState);

  if (now - lastReadTime < READ_INTERVAL) return;
  lastReadTime = now;

  // Average 3 samples for accuracy
  sumTemp = 0; sumHum = 0;
  uint8_t good = 0;
  for (uint8_t i = 0; i < 3; i++) {
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t) && !isnan(h)) {
      sumTemp += t; sumHum += h; good++;
    }
    delay(100);
  }

  if (good == 0) {
    errorCount++;
    // Show error on LCD
    lcd.setCursor(0, 0); lcd.print("Sensor Error!   ");
    lcd.setCursor(0, 1); lcd.print("Retries: ");
    lcd.print(errorCount);
    lcd.print("       ");
    Serial.println("{\"error\":\"sensor_failed\"}");
    setLEDs(false, false, false);
    noTone(BUZZER_PIN);
    return;
  }

  errorCount = 0;
  float rawTemp = sumTemp / good;   // actual DHT11 reading
  float temp    = rawTemp - 22.0;   // adjusted value used for all logic
  float hum     = sumHum  / good;
  readingCount++;

  // Determine state using ADJUSTED temperature
  if      (temp >= SAFE_MIN && temp <= SAFE_MAX) currentState = "SAFE";
  else if (temp > SAFE_MAX  && temp <= WARN_MAX) currentState = "WARNING";
  else                                            currentState = "DANGER";

  // Also flag if temp too cold (below min)
  if (temp < SAFE_MIN) currentState = "WARNING";

  // LCD: show adjusted temp + actual raw temp (instead of humidity)
  updateLCD(temp, rawTemp, currentState);

  // JSON to server: send adjusted temp + humidity
  Serial.print("{\"temp\":");
  Serial.print(temp, 1);
  Serial.print(",\"hum\":");
  Serial.print(hum, 1);
  Serial.println("}");
}