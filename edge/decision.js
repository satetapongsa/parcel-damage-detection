// Normalises whatever CiRA CORE sends into one shape, then decides PASS / REJECT.
// Damage classes: dent (รอยบุบ), tear (ฉีกขาด), deform (ผิดรูป), wet (เปียกน้ำ).
//
// Accepted detection shapes (any of these keys work):
//   { cls|class|label|name|class_name, conf|confidence|score|prob,
//     x,y,w,h | bbox:[x,y,w,h] | x1,y1,x2,y2 | xmin,ymin,xmax,ymax, cam:'top'|'side' }
// Coordinates may be normalised (0-1) or pixels (then img_w/img_h are used to normalise).

const DENT_WORDS = ['dent', 'dented', 'crush', 'crushed', 'บุบ'];
const TEAR_WORDS = ['tear', 'torn', 'rip', 'ripped', 'hole', 'ฉีก', 'ขาด'];
// 'damaged' = the downloaded YOLO model's class (badly damaged / crushed box) -> treated as deform
const DEFORM_WORDS = ['deform', 'deformed', 'misshape', 'bulge', 'collapse', 'damaged', 'damage', 'ผิดรูป', 'บี้', 'ยุบ', 'ยับ'];
const NORMAL_WORDS = ['normal', 'undamaged', 'good', 'ok', 'ปกติ'];
const WET_WORDS = ['wet', 'water', 'damp', 'stain', 'moist', 'เปียก', 'น้ำ', 'ชื้น'];

// classes that make a parcel REJECT, and the config key holding each threshold
const DAMAGE_CLASSES = { dent: 'conf_dent', tear: 'conf_tear', deform: 'conf_deform', wet: 'conf_wet' };

function mapClass(label) {
  const l = String(label || '').toLowerCase().trim();
  if (NORMAL_WORDS.some((w) => l === w || l.startsWith('undamag') || l.startsWith('normal'))) return 'normal'; // before 'damaged'
  if (DEFORM_WORDS.some((w) => l.includes(w))) return 'deform';
  if (WET_WORDS.some((w) => l.includes(w))) return 'wet';
  if (DENT_WORDS.some((w) => l.includes(w))) return 'dent';
  if (TEAR_WORDS.some((w) => l.includes(w))) return 'tear';
  return l || 'unknown';
}

const pick = (o, keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

function normalizeBox(d, imgW, imgH) {
  let x, y, w, h;
  if (Array.isArray(d.bbox) && d.bbox.length >= 4) [x, y, w, h] = d.bbox.map(Number);
  else if (d.x1 !== undefined || d.xmin !== undefined) {
    const x1 = Number(pick(d, ['x1', 'xmin'])), y1 = Number(pick(d, ['y1', 'ymin']));
    const x2 = Number(pick(d, ['x2', 'xmax'])), y2 = Number(pick(d, ['y2', 'ymax']));
    x = x1; y = y1; w = x2 - x1; h = y2 - y1;
  } else {
    x = Number(pick(d, ['x', 'left']) ?? 0); y = Number(pick(d, ['y', 'top']) ?? 0);
    w = Number(pick(d, ['w', 'width']) ?? 0); h = Number(pick(d, ['h', 'height']) ?? 0);
  }
  // pixel coordinates -> normalised
  if ([x, y, w, h].some((v) => v > 1.5)) {
    if (imgW && imgH) { x /= imgW; w /= imgW; y /= imgH; h /= imgH; }
    else return null;
  }
  return [x, y, w, h].map((v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)));
}

function normalizeDetections(payload) {
  const list = pick(payload, ['detections', 'objects', 'results', 'predictions', 'boxes']) || [];
  const imgW = Number(payload.img_w || payload.width) || 0;
  const imgH = Number(payload.img_h || payload.height) || 0;
  const out = [];
  for (const d of Array.isArray(list) ? list : []) {
    if (!d || typeof d !== 'object') continue;
    let conf = Number(pick(d, ['conf', 'confidence', 'score', 'prob']) ?? 0);
    if (conf > 1) conf /= 100; // percent -> 0..1
    out.push({
      cls: mapClass(pick(d, ['cls', 'class', 'label', 'name', 'class_name'])),
      raw: String(pick(d, ['cls', 'class', 'label', 'name', 'class_name']) ?? ''),
      conf: Math.round(conf * 1000) / 1000,
      box: normalizeBox(d, Number(d.img_w) || imgW, Number(d.img_h) || imgH),
      cam: d.cam === 'side' ? 'side' : 'top',
      src: d.src === 'cv' ? 'cv' : 'ai',
    });
  }
  return out;
}

// Returns { result, reason, decided_by, counted: detections that crossed the threshold }
function decide(detections, cfg, { brightness, aiTimeout } = {}) {
  if (aiTimeout) {
    return { result: cfg.failsafe_action, reason: 'AI_TIMEOUT', decided_by: 'FAILSAFE', counted: [] };
  }
  if (brightness !== undefined && brightness !== null && brightness < cfg.brightness_min) {
    return { result: cfg.failsafe_action, reason: 'VISION_FAULT', decided_by: 'FAILSAFE', counted: [] };
  }
  const thr = Object.fromEntries(Object.entries(DAMAGE_CLASSES).map(([c, k]) => [c, cfg[k]]));
  const counted = detections.filter((d) => {
    if (!(d.cls in thr)) return false;
    if (d.conf < thr[d.cls]) return false;
    if (d.box && d.box[2] * d.box[3] < cfg.min_box_area) return false;
    return true;
  });
  if (!counted.length) return { result: 'PASS', reason: 'OK', decided_by: 'AI', counted };
  const classes = [...new Set(counted.map((d) => d.cls.toUpperCase()))].sort();
  return { result: 'REJECT', reason: classes.join('+'), decided_by: 'AI', counted };
}

module.exports = { normalizeDetections, decide, mapClass, DAMAGE_CLASSES };
