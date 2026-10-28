// Shared helpers: MQTT topics, default parameters, embedded broker, logging.
const net = require('node:net');
const crypto = require('node:crypto');

const TOPICS = {
  // ---- Edge (local broker at the station) ----
  edgeTrigger: 'parcel/edge/trigger',          // gateway -> CiRA CORE : capture now
  ciraResult: 'parcel/edge/cira/result',       // CiRA CORE -> gateway : detection result
  esp32Evt: 'parcel/edge/esp32/evt',           // ESP32 (wifi/sim) -> gateway
  esp32Cmd: 'parcel/edge/esp32/cmd',           // gateway -> ESP32 (wifi/sim)
  scan: 'parcel/edge/scan',                    // barcode scanner bridge -> gateway
  // Edge -> Cloud goes over HTTPS (/api/ingest/*), see edge/index.js
};

// Parameters tunable from the web (Failure case 3: tune without changing code)
const DEFAULT_CONFIG = {
  reject_delay_ms: 1500,    // travel time IR trigger -> pusher (depends on belt speed)
  servo_hold_ms: 400,       // how long the pusher arm stays out
  conf_dent: 0.6,           // confidence threshold for "dent"
  conf_tear: 0.6,           // confidence threshold for "tear"
  conf_deform: 0.5,         // confidence threshold for "deform" (box badly crushed / out of shape)
  conf_wet: 0.5,            // confidence threshold for "wet" (water stain = darker, more saturated patch)
  cv_check: 1,              // 1 = gateway also runs its own colour/shape check for wet + deform (works without a trained class)
  min_box_area: 0.002,      // ignore boxes smaller than this fraction of the image (noise / print)
  brightness_min: 40,       // mean brightness (0-255) below this = VISION_FAULT
  jam_timeout_ms: 3000,     // IR blocked longer than this = BELT_JAM
  ai_timeout_ms: 1000,      // no AI result within this = fail-safe (must be < reject_delay_ms)
  failsafe_action: 'REJECT',// what to do when AI/camera fails: REJECT | PASS
  scan_window_ms: 15000,    // barcode must be scanned at most this long before the trigger
};

function sanitizeConfig(input, base = DEFAULT_CONFIG) {
  const out = { ...base };
  for (const [k, def] of Object.entries(DEFAULT_CONFIG)) {
    if (input == null || input[k] === undefined) continue;
    if (typeof def === 'number') {
      const n = Number(input[k]);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    } else if (k === 'failsafe_action') {
      const v = String(input[k]).toUpperCase();
      if (v === 'REJECT' || v === 'PASS') out[k] = v;
    }
  }
  return out;
}

async function startBroker(port, name) {
  const { Aedes } = require('aedes');
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  log(name, `MQTT broker listening on :${port}`);
  return { broker, server };
}

const uid = () => crypto.randomUUID();

// Started by scripts/demo.js? Exit when the launcher dies (Windows doesn't kill child processes for us).
if (process.env.DEMO_PARENT_PID) {
  setInterval(() => {
    try { process.kill(Number(process.env.DEMO_PARENT_PID), 0); } catch { process.exit(0); }
  }, 2000).unref();
}

function log(tag, ...args) {
  const t = new Date().toLocaleTimeString('th-TH', { hour12: false });
  console.log(`[${t}] [${tag}]`, ...args);
}

module.exports = { TOPICS, DEFAULT_CONFIG, sanitizeConfig, startBroker, uid, log };
