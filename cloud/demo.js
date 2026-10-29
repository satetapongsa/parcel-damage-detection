// DEMO MODE — generates realistic parcels on the server, so the deployed website can show the whole
// system working without a station PC. Uses the same camera simulator, colour/shape check and decision
// logic as the real edge gateway. Every record is stored with demo = 1 and shown as "ข้อมูลจำลอง".
const crypto = require('node:crypto');
const { frame, makeScenario, W, H } = require('../simulator/scene');
const { normalizeDetections, decide } = require('../edge/decision');
const { analyzeBox } = require('../edge/condition');
const { decode } = require('../edge/image');
const { DEFAULT_CONFIG } = require('../shared/common');

const DEMO_EDGE = 'demo-hub';
let seq = 0;

const ALERTS = [
  ['VISION_FAULT', 'critical', 'Image too dark (brightness 14 < 40) — camera blocked, dirty lens or lights off'],
  ['BELT_JAM', 'critical', 'IR blocked for 3300 ms — belt stopped'],
  ['AI_TIMEOUT', 'warning', 'No result from CiRA CORE within 1000 ms — fail-safe REJECT'],
  ['CLOUD_OFFLINE', 'warning', 'Cloud link lost — station keeps running, data is stored locally'],
];

function makeDemoParcel(config = DEFAULT_CONFIG) {
  const sc = makeScenario();
  const top = frame('top', sc.defect, false);
  const side = frame('side', sc.defect, false);
  const cv = [analyzeBox(decode(Buffer.from(top, 'base64')), 'top'), analyzeBox(decode(Buffer.from(side, 'base64')), 'side')]
    .flatMap((r) => r.detections);
  const dets = normalizeDetections({ detections: [...sc.dets, ...cv], img_w: W, img_h: H });
  const d = decide(dets, config);
  seq += 1;
  return {
    id: crypto.randomUUID(),
    edge_id: DEMO_EDGE,
    seq,
    tracking: Math.random() < 0.03 ? null : 'TH' + String(Math.floor(1e11 + Math.random() * 9e11)),
    result: d.result,
    reason: d.reason,
    decided_by: d.decided_by,
    detections: dets,
    max_conf: dets.length ? Math.max(...dets.map((x) => x.conf)) : null,
    weight_g: +(300 + Math.random() * 1200).toFixed(1),
    brightness: +(85 + Math.random() * 15).toFixed(1),
    latency_ms: 250 + Math.round(Math.random() * 300),
    ts: Date.now(),
    // keep the database small: images for every reject, every 4th pass
    images: d.result === 'REJECT' || seq % 4 === 0 ? { top, side } : {},
  };
}

function maybeDemoAlert() {
  if (Math.random() > 0.03) return null;
  const [type, severity, message] = ALERTS[Math.floor(Math.random() * ALERTS.length)];
  return { id: crypto.randomUUID(), edge_id: DEMO_EDGE, type, severity, message, ts: Date.now() };
}

function demoStatus(config = DEFAULT_CONFIG) {
  return {
    edge_id: DEMO_EDGE, online: true, cloud: true, esp32: true, esp32_transport: 'demo (simulated)',
    cira_last_seen: Date.now(), pending_sync: 0, pending_parcels: 0, faults: [], light: 'off',
    config, config_updated_at: 0, ts: Date.now(), demo: true,
  };
}

module.exports = { DEMO_EDGE, makeDemoParcel, maybeDemoAlert, demoStatus };
