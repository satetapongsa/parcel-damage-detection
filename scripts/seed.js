// SEED — fills a cloud deployment with realistic sample data through the real ingest API,
// so a fresh Vercel dashboard has something to show before the hardware is connected.
//
//   node scripts/seed.js --url https://your-app.vercel.app --key <INGEST_API_KEY> [--count 150] [--hours 24]
const crypto = require('node:crypto');
const { frame, makeScenario, W, H } = require('../simulator/scene');
const { normalizeDetections, decide } = require('../edge/decision');
const { analyzeBox } = require('../edge/condition');
const { decode } = require('../edge/image');
const { DEFAULT_CONFIG } = require('../shared/common');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const URL_ = (opt('url', process.env.CLOUD_URL || 'http://localhost:3000')).replace(/\/+$/, '');
const KEY = opt('key', process.env.INGEST_API_KEY || '');
const COUNT = Number(opt('count', 150));
const HOURS = Number(opt('hours', 24));
const EDGES = String(opt('edges', 'hub-01,hub-02')).split(',');

async function post(path, body) {
  const r = await fetch(URL_ + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

async function main() {
  console.log(`seeding ${COUNT} inspections over ${HOURS} h into ${URL_}`);
  const now = Date.now();
  let done = 0;
  for (let i = 0; i < COUNT; i++) {
    const edge = EDGES[i % EDGES.length];
    const ts = now - Math.round(Math.random() * HOURS * 3600e3);
    const sc = makeScenario();
    const top = frame('top', sc.defect, false), side = frame('side', sc.defect, false);
    // same pipeline as the gateway: AI detections + colour/shape check (wet, deform)
    const cv = [analyzeBox(decode(Buffer.from(top, 'base64')), 'top'), analyzeBox(decode(Buffer.from(side, 'base64')), 'side')].flatMap((r) => r.detections);
    const dets = normalizeDetections({ detections: [...sc.dets, ...cv], img_w: W, img_h: H });
    const d = decide(dets, DEFAULT_CONFIG);
    const withImages = d.result === 'REJECT' || i % 5 === 0; // keep the database small: images for rejects + some passes
    await post('/api/ingest/inspection', {
      id: crypto.randomUUID(), edge_id: edge, seq: i + 1,
      tracking: Math.random() < 0.03 ? null : 'TH' + String(Math.floor(1e11 + Math.random() * 9e11)),
      result: d.result, reason: d.reason, decided_by: d.decided_by, detections: dets,
      max_conf: dets.length ? Math.max(...dets.map((x) => x.conf)) : null,
      weight_g: +(300 + Math.random() * 1200).toFixed(1), brightness: +(85 + Math.random() * 15).toFixed(1),
      latency_ms: 250 + Math.round(Math.random() * 300), ts,
      images: withImages ? { top, side } : {},
    });
    if (++done % 25 === 0) console.log(`  ${done}/${COUNT}`);
  }
  const alerts = [
    ['VISION_FAULT', 'critical', 'Image too dark (brightness 12 < 40) — camera blocked, dirty lens or lights off'],
    ['BELT_JAM', 'critical', 'IR blocked for 3200 ms — belt stopped'],
    ['CLOUD_OFFLINE', 'warning', 'Cloud link lost — station keeps running, data is stored locally'],
    ['AI_TIMEOUT', 'warning', 'No result from CiRA CORE within 1000 ms — fail-safe REJECT'],
  ];
  for (const [type, severity, message] of alerts) {
    await post('/api/ingest/alert', { id: crypto.randomUUID(), edge_id: EDGES[0], type, severity, message, ts: now - Math.round(Math.random() * HOURS * 3600e3) });
  }
  for (const edge of EDGES) {
    await post('/api/ingest/status', { edge_id: edge, online: true, cloud: true, esp32: true, esp32_transport: 'seed', cira_last_seen: now, pending_sync: 0, faults: [], light: 'off', config: DEFAULT_CONFIG, config_updated_at: 0, ts: now });
  }
  console.log('done ✓  open', URL_);
}

main().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
