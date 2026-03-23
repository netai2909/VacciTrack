const express = require('express');
const cors = require('cors');
const { SerialPort, ReadlineParser } = require('serialport');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// ── SETUP & CONSTANTS ────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const DB_DIR  = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

const CLOUD_URL = 'https://vaccitrack-cloud.onrender.com/api/data';
const SERIAL_PORT = 'COM5';

const VACCINES = {
  "Polio OPV": { min: 2, max: 8, warn: 12, heatCategory: "A", degreeMinBudget: 600, info: "Highly heat sensitive." },
  "Measles MMR": { min: 2, max: 8, warn: 12, heatCategory: "A", degreeMinBudget: 600, info: "Live attenuated vaccine." },
  "BCG": { min: 2, max: 8, warn: 12, heatCategory: "A", degreeMinBudget: 600, info: "Protect from light and heat." },
  "Varicella": { min: 2, max: 8, warn: 12, heatCategory: "A", degreeMinBudget: 600, info: "Store frozen or refrigerated." },
  "Rotavirus": { min: 2, max: 8, warn: 12, heatCategory: "B", degreeMinBudget: 2000, info: "Moderately sensitive." },
  "PCV": { min: 2, max: 8, warn: 12, heatCategory: "B", degreeMinBudget: 2000, info: "Pneumococcal vaccine." },
  "IPV": { min: 2, max: 8, warn: 12, heatCategory: "B", degreeMinBudget: 2000, info: "Inactivated polio." },
  "HPV": { min: 2, max: 8, warn: 12, heatCategory: "B", degreeMinBudget: 2000, info: "Cervical cancer prevention." },
  "Hepatitis B": { min: 2, max: 8, warn: 12, heatCategory: "C", degreeMinBudget: 4500, info: "Avoid freezing! Freeze-sensitive." },
  "DPT": { min: 2, max: 8, warn: 12, heatCategory: "C", degreeMinBudget: 4500, info: "Avoid freezing! Freeze-sensitive." },
  "Tetanus TT": { min: 2, max: 8, warn: 12, heatCategory: "C", degreeMinBudget: 4500, info: "Most stable to heat, avoid freezing." },
  "Pentavalent": { min: 2, max: 8, warn: 12, heatCategory: "C", degreeMinBudget: 4500, info: "Avoid freezing! Freeze-sensitive." }
};

let sqlDb;

async function initDB() {
  sqlDb = await open({
    filename: path.join(DB_DIR, 'local.db'),
    driver: sqlite3.Database
  });
  await sqlDb.exec(`PRAGMA journal_mode = WAL`);
  await sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS local_readings (
      unique_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      sensor_data TEXT NOT NULL,
      sync_status TEXT DEFAULT 'pending'
    )
  `);
  console.log('Local Edge SQLite DB initialized.');
  
  connectSerial();
  server.listen(3000, '0.0.0.0', () => console.log('\n[Edge Server] Running at http://localhost:3000\n'));
}

// ── LEGACY JSON CONFIG (for local ease) ──────────────────────────────────────
const CONFIG_PATH = path.join(DB_DIR, 'config.json');
function defaultDB() {
  const vaccineExposure = {};
  Object.keys(VACCINES).forEach(n => vaccineExposure[n] = { damage: 0, potency: 100 });
  return { selectedVaccines: Object.keys(VACCINES), vaccineExposure, alerts: [] };
}
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultDB(), null, 2));
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}
function saveConfig(data) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2)); }

// ── POTENCY CALCULATION ──────────────────────────────────────────────────────
function computePotency(name, temp, intervalMins, currentDamage) {
  const v = VACCINES[name];
  if (!v || temp <= v.max) return { damage: currentDamage, potency: Math.max(0, 100 - currentDamage) };
  const overshoot   = temp - v.max;
  const damageAdded = (overshoot * intervalMins) / v.degreeMinBudget * 100;
  const newDamage   = Math.min(100, currentDamage + damageAdded);
  return { damage: newDamage, potency: Math.max(0, 100 - newDamage) };
}

// ── SERIAL PORT LISTENER ─────────────────────────────────────────────────────
let arduinoPort = null, serialConnected = false;
let lastAlertState = '', lastAlertTime = 0, lastReadingTime = null;

function connectSerial() {
  try {
    arduinoPort = new SerialPort({ path: SERIAL_PORT, baudRate: 9600 });
    const parser = arduinoPort.pipe(new ReadlineParser({ delimiter: '\n' }));

    arduinoPort.on('open', () => {
      serialConnected = true;
      console.log('Arduino connected on', SERIAL_PORT);
      const db = loadConfig();
      const v  = VACCINES[db.selectedVaccines?.[0]] ?? VACCINES['Polio OPV'];
      setTimeout(() => {
        const msg = JSON.stringify({ min: v.min, max: v.max, warn: v.warn });
        arduinoPort.write(msg + '\n', err => { if (!err) console.log('Sent config to Arduino:', msg); });
      }, 3000);
    });
    arduinoPort.on('error', err => { serialConnected = false; console.error('Serial error:', err.message); });
    arduinoPort.on('close', () => { serialConnected = false; console.log('Arduino disconnected. Retrying in 5s...'); setTimeout(connectSerial, 5000); });

    parser.on('data', async line => {
      try {
        const raw = line.trim();
        if (!raw.startsWith('{')) return;
        const data = JSON.parse(raw);
        if (data.config) return;
        if (data.error)  { io.emit('sensor_error', { timestamp: new Date().toISOString() }); return; }

        const { temp, hum } = data;
        if (temp === undefined) return;

        const now = new Date();
        const timestamp = now.toISOString();
        const intervalMins = lastReadingTime ? (now - lastReadingTime) / 60000 : 1;
        lastReadingTime = now;

        const config = loadConfig();
        const vaccineStates = {};

        // Compute per-vaccine states + update potency
        Object.keys(VACCINES).forEach(name => {
          const v = VACCINES[name];
          let state = 'SAFE';
          if (temp > v.warn)      state = 'DANGER';
          else if (temp > v.max)  state = 'WARNING';
          else if (temp < v.min)  state = 'WARNING';

          const prev   = config.vaccineExposure[name] ?? { damage: 0, potency: 100 };
          const result = computePotency(name, temp, intervalMins, prev.damage);
          config.vaccineExposure[name] = result;
          vaccineStates[name] = { state, potency: +result.potency.toFixed(1), temp, hum };
        });

        const overallState = Object.values(vaccineStates).some(v => v.state === 'DANGER')  ? 'DANGER'
                           : Object.values(vaccineStates).some(v => v.state === 'WARNING') ? 'WARNING'
                           : 'SAFE';

        // Alerts logic
        const nowMs = Date.now();
        const shouldAlert = (overallState === 'WARNING' || overallState === 'DANGER') &&
                            (overallState !== lastAlertState || nowMs - lastAlertTime > 60000);
        if (shouldAlert) {
          lastAlertState = overallState;
          lastAlertTime  = nowMs;
          const affected = Object.entries(vaccineStates).filter(([,v]) => v.state !== 'SAFE').map(([n]) => n).join(', ');
          const alert = {
            temp, hum, state: overallState, timestamp,
            message: overallState === 'DANGER' ? `DAMAGED! ${temp}°C — Do NOT use: ${affected}` : `WARNING! ${temp}°C — Check fridge: ${affected}`
          };
          config.alerts.unshift(alert);
          if (config.alerts.length > 100) config.alerts.pop();
          io.emit('alert', alert);
        }
        if (overallState === 'SAFE') lastAlertState = '';

        saveConfig(config);

        // Save to SQLite asynchronously
        const sensorDataObj = {
          temp, hum, state: overallState, timestamp,
          vaccineStates, vaccineExposure: config.vaccineExposure,
          alerts: config.alerts.slice(0, 10)
        };
        const unique_id = uuidv4();
        
        await sqlDb.run(
          `INSERT INTO local_readings (unique_id, timestamp, sensor_data, sync_status) VALUES (?, ?, ?, 'pending')`,
          [unique_id, timestamp, JSON.stringify(sensorDataObj)]
        );

        // Push locally straight to any local dashboards (offline viewing)
        io.emit('reading', { ...sensorDataObj });
        process.stdout.write(`\r${overallState} | ${temp}°C | ${hum}% (Saved locally)   `);

      } catch (e) { console.error('Parse error:', e); }
    });

  } catch (err) {
    console.error('Cannot open port:', err.message);
    setTimeout(connectSerial, 5000);
  }
}

// ── BACKGROUND SYNC WORKER ───────────────────────────────────────────────────
let isSyncing = false;
setInterval(async () => {
  if (isSyncing || !sqlDb) return;
  isSyncing = true;
  
  try {
    const pending = await sqlDb.all(`SELECT * FROM local_readings WHERE sync_status = 'pending' ORDER BY timestamp ASC LIMIT 50`);
    if (pending.length === 0) { isSyncing = false; return; }

    const records = pending.map(row => ({
      unique_id: row.unique_id,
      timestamp: row.timestamp,
      sensor_data: JSON.parse(row.sensor_data)
    }));
    
    // POST to Cloud Backend
    const resp = await axios.post(CLOUD_URL, records, { timeout: 10000 });
    
    if (resp.data.success) {
      // Mark as synced locally
      await sqlDb.exec('BEGIN TRANSACTION');
      const stmt = await sqlDb.prepare(`UPDATE local_readings SET sync_status = 'synced' WHERE unique_id = ?`);
      for (const r of pending) {
        await stmt.run(r.unique_id);
      }
      await stmt.finalize();
      await sqlDb.exec('COMMIT');
      process.stdout.write(`\n🚀 Synced ${pending.length} records to Cloud\n`);
    }
  } catch (err) {
    // Silently fail if offline, will retry next tick
    if (err.response) console.error(`\n[Sync API returned error: ${err.response.status}]`);
  } finally {
    isSyncing = false;
  }
}, 5000); // Check every 5 seconds

// ── LOCAL UI APIs (Fallbacks if Dashboard is accessed via localhost:3000) ────
app.get('/api/readings', async (req, res) => {
  if (!sqlDb) return res.json([]);
  const rows = await sqlDb.all(`SELECT sensor_data FROM local_readings ORDER BY timestamp DESC LIMIT 300`);
  res.json(rows.map(r => JSON.parse(r.sensor_data)).reverse());
});

app.get('/api/alerts',           (req, res) => res.json(loadConfig().alerts.slice(0, 50)));
app.get('/api/vaccines',         (req, res) => res.json(VACCINES));
app.get('/api/status',           (req, res) => res.json({ serialConnected, uptime: Math.floor(process.uptime()) }));
app.get('/api/exposure',         (req, res) => res.json(loadConfig().vaccineExposure));
app.get('/api/selected-vaccines',(req, res) => res.json({ selected: loadConfig().selectedVaccines }));

app.post('/api/selected-vaccines', (req, res) => {
  const { selected } = req.body;
  const cfg = loadConfig();
  cfg.selectedVaccines = selected.filter(n => VACCINES[n]);
  saveConfig(cfg);
  io.emit('selected_vaccines_changed', { selected: cfg.selectedVaccines });
  res.json({ success: true, selected: cfg.selectedVaccines });
});
app.post('/api/reset', async (req, res) => {
  const fresh = defaultDB();
  fresh.selectedVaccines = loadConfig().selectedVaccines;
  saveConfig(fresh);
  if (sqlDb) await sqlDb.run(`DELETE FROM local_readings`);
  io.emit('data_reset');
  res.json({ success: true });
});

app.get('/api/stats', async (req, res) => {
  if (!sqlDb) return res.json({ empty: true });
  const rows = await sqlDb.all(`SELECT sensor_data FROM local_readings ORDER BY timestamp ASC`);
  if (!rows.length) return res.json({ empty: true });

  const readings = rows.map(r => JSON.parse(r.sensor_data));
  const temps    = readings.map(r => r.temp).filter(t => t !== undefined);
  const minTemp  = temps.length ? +(Math.min(...temps).toFixed(1)) : 0;
  const maxTemp  = temps.length ? +(Math.max(...temps).toFixed(1)) : 0;
  const avgTemp  = temps.length ? +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : 0;

  let maxStreak = 0, curStreak = 0, streak = 0;
  readings.forEach(r => {
    if (r.state === 'SAFE') { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
    else curStreak = 0;
  });
  for (let i = readings.length - 1; i >= 0; i--) {
    if (readings[i].state === 'SAFE') streak++; else break;
  }

  const heatmap = {};
  readings.forEach(r => {
    const day = r.timestamp.slice(0, 10);
    if (!heatmap[day]) heatmap[day] = { safe: 0, warning: 0, danger: 0, total: 0 };
    heatmap[day].total++;
    if      (r.state === 'SAFE')    heatmap[day].safe++;
    else if (r.state === 'WARNING') heatmap[day].warning++;
    else if (r.state === 'DANGER')  heatmap[day].danger++;
  });

  res.json({
    minTemp, maxTemp, avgTemp, streak, maxStreak,
    vaccinePotency: loadConfig().vaccineExposure,
    heatmap, totalReadings: readings.length
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().catch(console.error);