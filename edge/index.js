// EDGE GATEWAY — runs at the inspection station, next to CiRA CORE.
//
//   ESP32 (IR trigger, weight, jam) ──UART──┐
//   USB barcode scanner ──station page──────┤
//   CiRA CORE (dent / tear) ──MQTT/HTTP─────┼──> decide PASS/REJECT ──> ESP32 (pusher, tower light)
//                                           └──> local SQLite ──(store-and-forward, HTTPS)──> Cloud (Vercel)
//
// The real-time path never waits for the internet: if the cloud is down the station keeps
// sorting, stores everything locally, shows YELLOW, and syncs when the link comes back.
require('../shared/common').loadLocalEnv(); // CLOUD_URL, INGEST_API_KEY from .env.local
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const mqtt = require('mqtt');
const { TOPICS, DEFAULT_CONFIG, sanitizeConfig, startBroker, uid, log } = require('../shared/common');
const { openEdgeDb } = require('./db');
const { Esp32Link } = require('./esp32');
const { normalizeDetections, decide } = require('./decision');
const { toBuffer, decode, meanBrightness } = require('./image');
const { analyzeBox } = require('./condition');

const ENV = {
  EDGE_ID: process.env.EDGE_ID || 'hub-01',
  HTTP_PORT: Number(process.env.EDGE_HTTP_PORT || 8080),
  LOCAL_BROKER_PORT: Number(process.env.EDGE_BROKER_PORT || 1883),
  LOCAL_BROKER_URL: process.env.EDGE_BROKER_URL || '', // use an existing broker instead of the embedded one
  CLOUD_URL: (process.env.CLOUD_URL || 'http://localhost:3000').replace(/\/+$/, ''), // e.g. https://your-app.vercel.app
  INGEST_API_KEY: process.env.INGEST_API_KEY || '',
  ESP32_TRANSPORT: process.env.ESP32_TRANSPORT || (process.env.ESP32_PORT ? 'serial' : 'mqtt'),
  ESP32_PORT: process.env.ESP32_PORT || '',
  ESP32_BAUD: Number(process.env.ESP32_BAUD || 115200),
  DATA_DIR: path.resolve(process.env.EDGE_DATA_DIR || path.join(__dirname, '..', 'data', 'edge')),
};
const tag = 'edge';

async function main() {
  const store = openEdgeDb(ENV.DATA_DIR);
  const imgDir = path.join(ENV.DATA_DIR, 'images');
  let cfgState = store.getJson('config') || { config: { ...DEFAULT_CONFIG }, updated_at: 0 };
  cfgState.config = sanitizeConfig(cfgState.config);
  const cfg = () => cfgState.config;

  // ---------- local MQTT (CiRA CORE + ESP32/sim talk here) ----------
  if (!ENV.LOCAL_BROKER_URL) await startBroker(ENV.LOCAL_BROKER_PORT, tag);
  const local = mqtt.connect(ENV.LOCAL_BROKER_URL || `mqtt://localhost:${ENV.LOCAL_BROKER_PORT}`, {
    clientId: `gateway-${ENV.EDGE_ID}-${Math.random().toString(16).slice(2, 6)}`,
  });
  local.on('connect', () => {
    local.subscribe([TOPICS.ciraResult, TOPICS.scan], { qos: 1 });
    log(tag, 'connected to local broker');
  });

  // ---------- runtime state ----------
  const pending = new Map();       // parcel id -> parcel waiting for AI
  const finalized = new Set();     // recently decided ids (to drop late AI results)
  let scans = [];                  // barcode queue [{code, ts}]
  const faults = new Set();        // active faults -> yellow light
  let cloudOnline = false;
  let lastCiraTs = 0;
  let lastLight = null;
  let lastWeight = null;           // weight that arrived before its trigger was registered (rare)
  const sseClients = new Set();
  const counters = { pass: 0, reject: 0 };

  const emit = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };

  // ---------- ESP32 ----------
  const esp = new Esp32Link({ transport: ENV.ESP32_TRANSPORT, port: ENV.ESP32_PORT, baud: ENV.ESP32_BAUD, localMqtt: local });

  const pushConfigToEsp = () => esp.send({
    cmd: 'config',
    delay_ms: cfg().reject_delay_ms,
    hold_ms: cfg().servo_hold_ms,
    jam_ms: cfg().jam_timeout_ms,
    failsafe: cfg().failsafe_action,
  });

  function updateLight() {
    const base = !cloudOnline || faults.size ? 'yellow' : 'off';
    if (base !== lastLight) {
      lastLight = base;
      esp.send({ cmd: 'light', base });
      emit('status', statusSnapshot());
    }
  }

  function raise(type, severity, message) {
    const a = { id: uid(), type, severity, message, ts: Date.now() };
    store.addAlert(a);
    log(tag, `ALERT ${severity} ${type}: ${message}`);
    emit('alert', a);
  }

  function setFault(type, active, message) {
    if (active && !faults.has(type)) { faults.add(type); raise(type, 'critical', message); }
    else if (!active && faults.has(type)) { faults.delete(type); raise(`${type}_CLEARED`, 'info', message); }
    updateLight();
  }

  function takeScan() {
    const now = Date.now();
    scans = scans.filter((s) => now - s.ts <= cfg().scan_window_ms);
    return scans.shift()?.code || null;
  }

  function newParcel(seq) {
    const p = { id: uid(), seq, trigger_ts: Date.now(), tracking: takeScan(), weight_g: null, timer: null };
    pending.set(p.id, p);
    return p;
  }

  esp.on('link', (up) => {
    log(tag, `ESP32 link ${up ? 'UP' : 'DOWN'}`);
    setFault('ESP32_OFFLINE', !up, up ? 'ESP32 controller reconnected' : 'Lost connection to ESP32 controller');
    if (up) { pushConfigToEsp(); lastLight = null; updateLight(); }
  });

  esp.on('evt', (m) => {
    switch (m.evt) {
      case 'hello':
        log(tag, 'ESP32 hello', m.fw || '');
        pushConfigToEsp(); lastLight = null; updateLight();
        break;
      case 'trigger': {
        const p = newParcel(m.seq ?? null);
        p.timer = setTimeout(() => finalize(p, null, { aiTimeout: true }), cfg().ai_timeout_ms);
        local.publish(TOPICS.edgeTrigger, JSON.stringify({ parcel_id: p.id, seq: p.seq, ts: p.trigger_ts, tracking: p.tracking }), { qos: 0 });
        emit('trigger', { parcel_id: p.id, seq: p.seq, tracking: p.tracking });
        break;
      }
      case 'weight': {
        const p = [...pending.values()].find((x) => x.seq === m.seq);
        if (p) p.weight_g = Number(m.g);
        else lastWeight = { seq: m.seq, g: Number(m.g) };
        break;
      }
      case 'scan':
        if (m.code) scans.push({ code: String(m.code), ts: Date.now() });
        break;
      case 'jam':
        setFault('BELT_JAM', true, `IR blocked for ${m.ms || '?'} ms — belt stopped`);
        break;
      case 'jam_clear':
        setFault('BELT_JAM', false, 'Belt jam cleared — belt restarted');
        break;
      case 'failsafe':
        raise('CONTROLLER_FAILSAFE', 'warning', `ESP32 applied its own fail-safe for seq ${m.seq} (no decision from gateway in time)`);
        break;
      case 'done':
        if (m.late) raise('PUSH_LATE', 'warning', `Reject for seq ${m.seq} arrived ${m.late} ms late — increase reject_delay_ms or lower ai_timeout_ms`);
        emit('actuator', m);
        break;
      default:
        break;
    }
  });

  // ---------- CiRA CORE result ----------
  function onCiraResult(payload) {
    lastCiraTs = Date.now();
    if (!payload || typeof payload !== 'object') return;
    let p = null;
    if (payload.parcel_id && pending.has(payload.parcel_id)) p = pending.get(payload.parcel_id);
    else if (payload.parcel_id && finalized.has(payload.parcel_id)) {
      log(tag, `late AI result for ${payload.parcel_id} dropped (fail-safe already applied)`);
      return;
    } else if (payload.seq !== undefined && payload.seq !== null) {
      p = [...pending.values()].find((x) => x.seq === Number(payload.seq)) || null;
    }
    if (!p && pending.size) p = pending.values().next().value; // FIFO
    if (!p) {
      if (esp.connected) { log(tag, 'AI result without a pending trigger dropped'); return; }
      p = newParcel(null); // CiRA-only mode (no IR/ESP32 connected): every result is a parcel
    }
    finalize(p, payload, {});
  }

  function finalize(p, payload, { aiTimeout }) {
    if (!pending.has(p.id)) return;
    clearTimeout(p.timer);
    pending.delete(p.id);
    finalized.add(p.id);
    if (finalized.size > 500) finalized.delete(finalized.values().next().value);

    payload = payload || {};
    const imgs = payload.images || {};
    const topB64 = imgs.top || payload.image_top || payload.image || null;
    const sideB64 = imgs.side || payload.image_side || null;
    const topBuf = toBuffer(topB64), sideBuf = toBuffer(sideB64);

    let brightness = payload.brightness !== undefined ? Number(payload.brightness) : null;
    const topImg = decode(topBuf);
    if (brightness === null && topImg) brightness = meanBrightness(topImg);
    if (topImg && !payload.img_w) { payload.img_w = topImg.width; payload.img_h = topImg.height; }

    const detections = aiTimeout ? [] : normalizeDetections(payload);
    // colour/shape check for WET + DEFORM (skipped when the image is too dark to trust)
    if (!aiTimeout && cfg().cv_check && !(brightness !== null && brightness < cfg().brightness_min)) {
      const cv = [analyzeBox(topImg, 'top'), analyzeBox(decode(sideBuf), 'side')].flatMap((r) => r.detections);
      detections.push(...normalizeDetections({ detections: cv }));
    }
    const d = decide(detections, cfg(), { brightness: aiTimeout ? null : brightness, aiTimeout });

    if (!aiTimeout && brightness !== null) {
      setFault('VISION_FAULT', brightness < cfg().brightness_min,
        brightness < cfg().brightness_min
          ? `Image too dark (brightness ${brightness} < ${cfg().brightness_min}) — camera blocked, dirty lens or lights off`
          : `Camera image OK again (brightness ${brightness})`);
    }
    if (aiTimeout) raise('AI_TIMEOUT', 'warning', `No result from CiRA CORE within ${cfg().ai_timeout_ms} ms — fail-safe ${d.result}`);

    // actuator first: the physical path matters more than bookkeeping
    if (esp.connected || ENV.ESP32_TRANSPORT === 'mqtt') {
      esp.send({ cmd: d.result === 'REJECT' ? 'reject' : 'pass', seq: p.seq });
    }

    const save = (buf, name) => {
      if (!buf) return null;
      const file = `${p.id}_${name}.jpg`;
      fs.writeFileSync(path.join(imgDir, file), buf);
      return file;
    };
    if (lastWeight && lastWeight.seq === p.seq && p.weight_g === null) p.weight_g = lastWeight.g;

    const rec = {
      id: p.id,
      seq: p.seq,
      tracking: payload.tracking ? String(payload.tracking) : p.tracking,
      result: d.result,
      reason: d.reason,
      decided_by: d.decided_by,
      detections: JSON.stringify(detections),
      max_conf: detections.length ? Math.max(...detections.map((x) => x.conf)) : null,
      weight_g: p.weight_g ?? (payload.weight_g !== undefined ? Number(payload.weight_g) : null),
      brightness,
      img_top: save(topBuf, 'top'),
      img_side: save(sideBuf, 'side'),
      latency_ms: Date.now() - p.trigger_ts,
      ts: p.trigger_ts,
    };
    store.addInspection(rec);
    counters[d.result === 'REJECT' ? 'reject' : 'pass']++;
    log(tag, `${rec.result.padEnd(6)} ${rec.reason.padEnd(12)} tracking=${rec.tracking || '-'} seq=${p.seq ?? '-'} ${rec.latency_ms}ms`);
    emit('inspection', { ...rec, detections });
  }

  local.on('message', (topic, buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return log(tag, `bad JSON on ${topic}`); }
    if (topic === TOPICS.ciraResult) onCiraResult(msg);
    else if (topic === TOPICS.scan && msg.code) scans.push({ code: String(msg.code), ts: Date.now() });
  });

  // ---------- cloud link (Store-and-Forward over HTTPS) ----------
  // Works with Vercel: every record is POSTed to the cloud API; failures just leave it queued in SQLite.
  async function cloudPost(p, body, ms = 15000) {
    const r = await fetch(ENV.CLOUD_URL + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ENV.INGEST_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    if (r.status === 401) throw new Error('cloud rejected INGEST_API_KEY (401)');
    if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
    return r.json();
  }

  function setCloud(up, why) {
    if (up === cloudOnline) return;
    cloudOnline = up;
    if (up) {
      log(tag, `cloud CONNECTED (${ENV.CLOUD_URL}) — pending records: ${store.pendingCount()}`);
      if (faults.has('CLOUD_OFFLINE')) setFault('CLOUD_OFFLINE', false, 'Cloud link restored — syncing stored records');
    } else {
      log(tag, `cloud OFFLINE (${why}) — storing locally (yellow light)`);
      faults.add('CLOUD_OFFLINE');
      raise('CLOUD_OFFLINE', 'warning', 'Cloud link lost — station keeps running, data is stored locally');
    }
    updateLight();
  }

  // heartbeat: sends station status, receives the config the cloud wants this station to run
  let beating = false;
  async function heartbeat() {
    if (beating) return;
    beating = true;
    try {
      const res = await cloudPost('/api/ingest/status', statusSnapshot(), 8000);
      setCloud(true);
      if (res.config && (res.updated_at || 0) > cfgState.updated_at) applyConfig(res.config, res.updated_at, 'cloud');
    } catch (e) {
      setCloud(false, e.message);
    } finally {
      beating = false;
    }
  }

  function applyConfig(input, updatedAt, source) {
    cfgState = { config: sanitizeConfig(input, cfg()), updated_at: updatedAt || Date.now() };
    store.setJson('config', cfgState);
    pushConfigToEsp();
    log(tag, `config updated from ${source}:`, JSON.stringify(cfgState.config));
    if (source !== 'cloud') heartbeat(); // tell the cloud right away
    emit('status', statusSnapshot());
  }

  let syncing = false;
  async function syncOnce() {
    if (!cloudOnline || syncing) return;
    syncing = true;
    try {
      for (const a of store.pendingAlerts(50)) {
        await cloudPost('/api/ingest/alert', { ...a, edge_id: ENV.EDGE_ID });
        store.markAlertSynced(a.id);
      }
      for (const r of store.pendingInspections(10)) {
        const readImg = (f) => (f && fs.existsSync(path.join(imgDir, f)) ? fs.readFileSync(path.join(imgDir, f)).toString('base64') : null);
        const msg = { ...r, edge_id: ENV.EDGE_ID, detections: JSON.parse(r.detections || '[]'), images: { top: readImg(r.img_top), side: readImg(r.img_side) } };
        delete msg.synced;
        await cloudPost('/api/ingest/inspection', msg, 30000);
        store.markInspectionSynced(r.id);
      }
    } catch (e) {
      log(tag, 'sync paused:', e.message);
      setCloud(false, e.message);
    } finally {
      syncing = false;
    }
  }
  setInterval(syncOnce, 1000);

  function statusSnapshot() {
    return {
      edge_id: ENV.EDGE_ID,
      online: true,
      cloud: cloudOnline,
      esp32: esp.connected,
      esp32_transport: ENV.ESP32_TRANSPORT,
      cira_last_seen: lastCiraTs || null,
      pending_sync: store.pendingCount(),
      pending_parcels: pending.size,
      faults: [...faults],
      light: lastLight,
      counters,
      config: cfg(),
      config_updated_at: cfgState.updated_at,
      ts: Date.now(),
    };
  }
  heartbeat();
  setInterval(() => { heartbeat(); emit('status', statusSnapshot()); }, 5000);

  // ---------- station web (operator page + HTTP API for CiRA CORE) ----------
  const app = express();
  app.use(express.json({ limit: '40mb' }));
  app.use('/images', express.static(imgDir));
  app.use(express.static(path.join(__dirname, 'public')));

  app.post('/api/cira/result', (req, res) => { onCiraResult(req.body); res.json({ ok: true }); });
  app.post('/api/scan', (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code required' });
    scans.push({ code, ts: Date.now() });
    emit('scan', { code });
    res.json({ ok: true, queued: scans.length });
  });
  app.get('/api/status', (_req, res) => res.json(statusSnapshot()));
  app.get('/api/recent', (_req, res) => res.json(store.recent(30)));
  app.get('/api/config', (_req, res) => res.json(cfgState));
  app.put('/api/config', (req, res) => { applyConfig(req.body, Date.now(), 'station'); res.json(cfgState); });
  app.post('/api/test/:action', (req, res) => {
    const a = req.params.action;
    if (a === 'reject' || a === 'pass') esp.send({ cmd: a, seq: null });
    else if (a === 'belt-start') esp.send({ cmd: 'belt', run: true });
    else if (a === 'belt-stop') esp.send({ cmd: 'belt', run: false });
    else return res.status(400).json({ error: 'unknown action' });
    res.json({ ok: true });
  });
  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: status\ndata: ${JSON.stringify(statusSnapshot())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.listen(ENV.HTTP_PORT, () => log(tag, `station page + CiRA HTTP API on http://localhost:${ENV.HTTP_PORT}`));
  log(tag, `edge_id=${ENV.EDGE_ID} esp32=${ENV.ESP32_TRANSPORT}${ENV.ESP32_PORT ? ' ' + ENV.ESP32_PORT : ''} data=${ENV.DATA_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
