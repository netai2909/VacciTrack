# VacciTrack - Village PHC Cold Chain Monitor

## 🚀 How to move this project to another PC

To transfer this entire project to another laptop or PC and run it there, follow these steps:

### 1. Copy the project folder
Copy the entire `C:\VacciTrack` folder to a USB drive or zip it and send it to the other PC.
*Note: You don't need to copy the `node_modules` folders, but if you do, that's fine too (it just takes longer to copy).*

### 2. Install prerequisites on the new PC
The new PC must have these two things installed:
1. **Node.js** (Download from https://nodejs.org and install the LTS version)
2. **Arduino IDE** (Download from https://www.arduino.cc/en/software)

### 3. Open the project on the new PC
1. Paste the `VacciTrack` folder anywhere on the new PC (e.g., `C:\VacciTrack`).
2. Open **VS Code** (or your preferred editor) and open that folder.

### 4. Install dependencies (First time only)
Because you moved to a new PC, you need to tell Node.js to download the required packages. Open two terminal windows in VS Code:

**Terminal 1 (Server):**
```cmd
cd server
npm install
```

**Terminal 2 (Client):**
```cmd
cd client
npm install
```

### 5. Check the Arduino COM Port
When you plug the Arduino into the *new* PC, it might get assigned a different COM port (e.g., `COM3` instead of `COM5`).

1. Open Arduino IDE and check which port the Arduino is on (Tools -> Port).
2. Open `server/index.js` in VS Code.
3. Find the line at the top: `const SERIAL_PORT = 'COM5';`
4. Change `'COM5'` to whatever the new port is.

### 6. Run the Project
Now you run it exactly like you did before!

**Terminal 1 (Backend):**
```cmd
cd server
node index.js
```

**Terminal 2 (Frontend):**
```cmd
cd client
npm run dev
```

Open your browser to `http://localhost:5173`.
