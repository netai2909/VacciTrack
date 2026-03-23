// No dotenv needed for Render
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Database Connection
// Ensure special characters in the password are URL-encoded.
// The password 'Netai@915305' becomes 'Netai%40915305'
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:Netai%40915305@db.lpzrqpkgeomgwoqyoapm.supabase.co:5432/postgres';

const pool = new Pool({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false } // Required for Supabase
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cloud_readings (
        unique_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        sensor_data TEXT NOT NULL
      )
    `);
    console.log('✅ Connected to Supabase PostgreSQL');
  } catch (err) {
    console.error('❌ Failed to connect to DB:', err.message);
  }
}

app.post('/api/data', async (req, res) => {
  const records = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: 'Expected array' });

  let added = 0;
  let latestData = null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const query = `
      INSERT INTO cloud_readings (unique_id, timestamp, sensor_data)
      VALUES ($1, $2, $3)
      ON CONFLICT (unique_id) DO NOTHING
    `;

    for (const r of records) {
      const result = await client.query(query, [r.unique_id, r.timestamp, JSON.stringify(r.sensor_data)]);
      if (result.rowCount > 0) {
        added++;
        latestData = r.sensor_data;
      }
    }
    
    await client.query('COMMIT');

    if (added > 0) {
      console.log(`[Sync] Received batch of ${records.length}, inserted ${added} new records to Supabase.`);
      if (latestData) io.emit('reading', latestData);
    }
    res.json({ success: true, added });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Database sync error:', err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

app.get('/api/readings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT sensor_data FROM cloud_readings ORDER BY timestamp DESC LIMIT 300`);
    res.json(rows.map(r => JSON.parse(r.sensor_data)).reverse());
  } catch (err) {
    res.status(500).json([]);
  }
});

app.get('/api/alerts', (req, res) => res.json([]));

const VACCINES = {
  "Polio OPV": { min: 2, max: 8, warn: 12, heatCategory: "A", info: "Highly heat sensitive." },
  "Measles MMR": { min: 2, max: 8, warn: 12, heatCategory: "A", info: "Live attenuated vaccine." },
  "BCG": { min: 2, max: 8, warn: 12, heatCategory: "A", info: "Protect from light and heat." },
  "Varicella": { min: 2, max: 8, warn: 12, heatCategory: "A", info: "Store frozen or refrigerated." },
  "Rotavirus": { min: 2, max: 8, warn: 12, heatCategory: "B", info: "Moderately sensitive." },
  "PCV": { min: 2, max: 8, warn: 12, heatCategory: "B", info: "Pneumococcal vaccine." },
  "IPV": { min: 2, max: 8, warn: 12, heatCategory: "B", info: "Inactivated polio." },
  "HPV": { min: 2, max: 8, warn: 12, heatCategory: "B", info: "Cervical cancer prevention." },
  "Hepatitis B": { min: 2, max: 8, warn: 12, heatCategory: "C", info: "Avoid freezing! Freeze-sensitive." },
  "DPT": { min: 2, max: 8, warn: 12, heatCategory: "C", info: "Avoid freezing! Freeze-sensitive." },
  "Tetanus TT": { min: 2, max: 8, warn: 12, heatCategory: "C", info: "Most stable to heat, avoid freezing." },
  "Pentavalent": { min: 2, max: 8, warn: 12, heatCategory: "C", info: "Avoid freezing! Freeze-sensitive." }
};

app.get('/api/vaccines', (req, res) => res.json(VACCINES));
app.get('/api/selected-vaccines', (req, res) => res.json({ selected: Object.keys(VACCINES) }));
app.post('/api/selected-vaccines', (req, res) => res.json({ success: true, selected: req.body.selected }));
app.post('/api/reset', async (req, res) => {
  try {
    await pool.query(`TRUNCATE TABLE cloud_readings`);
    io.emit('data_reset');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear data' });
  }
});

app.get('/api/status', (req, res) => res.json({ serialConnected: true, uptime: Math.floor(process.uptime()) }));

app.get('/api/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT sensor_data FROM cloud_readings ORDER BY timestamp ASC`);
    if (!rows.length) return res.json({ empty: true });

    const readings = rows.map(r => JSON.parse(r.sensor_data));
    const temps = readings.map(r => r.temp).filter(t => t !== undefined);
    
    const minTemp = temps.length ? +(Math.min(...temps).toFixed(1)) : 0;
    const maxTemp = temps.length ? +(Math.max(...temps).toFixed(1)) : 0;
    const avgTemp = temps.length ? +(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : 0;

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

    const latest = readings[readings.length - 1] || {};
    res.json({
      minTemp, maxTemp, avgTemp, streak, maxStreak,
      vaccinePotency: latest.vaccineExposure || {},
      heatmap, totalReadings: readings.length
    });
  } catch (err) {
    res.status(500).json({ empty: true });
  }
});

app.get('/api/exposure', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT sensor_data FROM cloud_readings ORDER BY timestamp DESC LIMIT 1`);
    if (!rows.length) return res.json({});
    res.json(JSON.parse(rows[0].sensor_data).vaccineExposure || {});
  } catch (err) {
    res.status(500).json({});
  }
});

io.on('connection', socket => console.log('🟢 Cloud Dashboard connected:', socket.id));

initDB().then(() => {
  // Use Render's dynamically assigned PORT or 4000 locally
  const PORT = process.env.PORT || 4000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Cloud Backend] Running on port ${PORT}`);
  });
});
