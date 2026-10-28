const test = require('node:test');
const assert = require('node:assert');
const { normalizeDetections, decide } = require('../edge/decision');
const { DEFAULT_CONFIG } = require('../shared/common');

const cfg = { ...DEFAULT_CONFIG };

test('normalises different CiRA CORE payload shapes', () => {
  const a = normalizeDetections({ detections: [{ label: 'Dent', confidence: 0.8, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] });
  const b = normalizeDetections({ objects: [{ name: 'tear', score: 91, bbox: [64, 48, 128, 96] }], img_w: 640, img_h: 480 });
  const c = normalizeDetections({ results: [{ class: 'รอยบุบ', prob: 0.7, xmin: 0, ymin: 0, xmax: 320, ymax: 240 }], width: 640, height: 480 });
  assert.equal(a[0].cls, 'dent');
  assert.equal(b[0].cls, 'tear');
  assert.equal(b[0].conf, 0.91);
  assert.deepEqual(b[0].box, [0.1, 0.1, 0.2, 0.2]);
  assert.equal(c[0].cls, 'dent');
  assert.deepEqual(c[0].box, [0, 0, 0.5, 0.5]);
});

test('PASS when nothing is above threshold (Failure case 1: printed graphic)', () => {
  const d = decide(normalizeDetections({ detections: [{ label: 'tear', conf: 0.35, x: 0.4, y: 0.4, w: 0.2, h: 0.1 }] }), cfg);
  assert.equal(d.result, 'PASS');
});

test('REJECT on dent / tear above threshold', () => {
  const dets = normalizeDetections({ detections: [
    { label: 'dent', conf: 0.9, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    { label: 'tear', conf: 0.8, x: 0.5, y: 0.5, w: 0.2, h: 0.1 },
  ] });
  const d = decide(dets, cfg);
  assert.equal(d.result, 'REJECT');
  assert.equal(d.reason, 'DENT+TEAR');
});

test('tiny boxes are ignored', () => {
  const d = decide(normalizeDetections({ detections: [{ label: 'dent', conf: 0.95, x: 0.1, y: 0.1, w: 0.01, h: 0.01 }] }), cfg);
  assert.equal(d.result, 'PASS');
});

test('fail-safe on AI timeout and dark image', () => {
  assert.deepEqual(
    [decide([], cfg, { aiTimeout: true }).reason, decide([], cfg, { brightness: 5 }).reason],
    ['AI_TIMEOUT', 'VISION_FAULT'],
  );
  assert.equal(decide([], { ...cfg, failsafe_action: 'PASS' }, { aiTimeout: true }).result, 'PASS');
});

test('REJECT on deform / wet, and YOLO "damaged" counts as deform', () => {
  const dets = normalizeDetections({ detections: [
    { label: 'wet', conf: 0.8, x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
    { label: 'damaged', conf: 0.7, x: 0.1, y: 0.1, w: 0.6, h: 0.6 },
    { label: 'normal', conf: 0.95, x: 0.1, y: 0.1, w: 0.6, h: 0.6 },
  ] });
  assert.deepEqual(dets.map((d) => d.cls), ['wet', 'deform', 'normal']);
  assert.equal(decide(dets, cfg).reason, 'DEFORM+WET');
  assert.equal(decide(normalizeDetections({ detections: [{ label: 'normal', conf: 0.99, x: 0, y: 0, w: 1, h: 1 }] }), cfg).result, 'PASS');
});

test('colour/shape check finds wet + deformed boxes and leaves normal ones alone', () => {
  const { frame, makeScenario } = require('../simulator/scene');
  const { analyzeBox } = require('../edge/condition');
  const { decode } = require('../edge/image');
  const run = (type) => {
    let sc; do { sc = makeScenario(); } while (sc.type !== type);
    const img = decode(Buffer.from(frame('top', sc.defect, false), 'base64'));
    return normalizeDetections({ detections: analyzeBox(img).detections });
  };
  for (const t of ['ok', 'dent', 'tear', 'graphic']) assert.equal(decide(run(t), cfg).result, 'PASS', t);
  assert.equal(decide(run('wet'), cfg).reason, 'WET');
  assert.equal(decide(run('deform'), cfg).reason, 'DEFORM');
});
