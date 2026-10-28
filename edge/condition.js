// Box CONDITION check (classic computer vision, no training needed) — runs in the gateway
// on every frame from CiRA CORE, alongside the AI model. Same algorithm as cira/box_condition.py.
//
//  WET    : water makes cardboard DARKER and MORE SATURATED while the hue stays brown.
//           Dent shadows are darker but keep the same saturation, so they are not counted.
//  DEFORM : the box silhouette should fill its minimum-area rectangle almost completely.
//           A crushed / bulging / collapsed box leaves big gaps -> low "fill ratio".
//
// Returns detections in the same shape as the AI ({label, conf, x, y, w, h, cam, src:'cv'}).

const TARGET_W = 200; // analyse a downscaled grid — plenty for stains and silhouettes

function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx / 255];
}

const isCardboard = (h, s, v) => h >= 12 && h <= 50 && s >= 0.22 && v >= 0.12;

function median(arr) {
  if (!arr.length) return 0;
  const a = Float32Array.from(arr).sort();
  return a[a.length >> 1];
}

// convex hull (monotone chain) of [x, y] points
function hull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// smallest-area rectangle enclosing the hull (rotating edges)
function minRectArea(h) {
  if (h.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < h.length; i++) {
    const [x1, y1] = h[i], [x2, y2] = h[(i + 1) % h.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (!len) continue;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of h) {
      const a = x * ux + y * uy, b = -x * uy + y * ux;
      if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    best = Math.min(best, (a1 - a0 + 1) * (b1 - b0 + 1));
  }
  return best;
}

function analyzeBox(img, cam = 'top') {
  if (!img) return { detections: [], metrics: null };
  const step = Math.max(1, Math.floor(img.width / TARGET_W));
  const W = Math.floor(img.width / step), H = Math.floor(img.height / step);
  const N = W * H;
  const hh = new Float32Array(N), ss = new Float32Array(N), vv = new Float32Array(N);
  const card = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((y * step) * img.width + x * step) * 4;
      const [h, s, v] = rgbToHsv(img.data[i], img.data[i + 1], img.data[i + 2]);
      const k = y * W + x;
      hh[k] = h; ss[k] = s; vv[k] = v;
      card[k] = isCardboard(h, s, v) ? 1 : 0;
    }
  }

  // ---- silhouette: inside both the row span and the column span of cardboard pixels ----
  const rowL = new Int32Array(H).fill(-1), rowR = new Int32Array(H).fill(-1);
  const colT = new Int32Array(W).fill(-1), colB = new Int32Array(W).fill(-1);
  const MIN_RUN = 3;
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if (card[y * W + x]) { n++; if (rowL[y] < 0) rowL[y] = x; rowR[y] = x; }
    if (n < MIN_RUN) rowL[y] = rowR[y] = -1;
  }
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = 0; y < H; y++) if (card[y * W + x]) { n++; if (colT[x] < 0) colT[x] = y; colB[x] = y; }
    if (n < MIN_RUN) colT[x] = colB[x] = -1;
  }
  const inside = new Uint8Array(N);
  let area = 0, bx0 = W, by0 = H, bx1 = -1, by1 = -1;
  const pts = [];
  for (let y = 0; y < H; y++) {
    if (rowL[y] < 0) continue;
    for (let x = rowL[y]; x <= rowR[y]; x++) {
      if (colT[x] < 0 || y < colT[x] || y > colB[x]) continue;
      inside[y * W + x] = 1; area++;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
  }
  if (area < N * 0.03) return { detections: [], metrics: { box_found: false } }; // no box in view
  for (let y = 0; y < H; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) if (inside[y * W + x]) { if (l < 0) l = x; r = x; }
    if (l >= 0) { pts.push([l, y]); pts.push([r, y]); }
  }
  const fill = area / minRectArea(hull(pts));

  // ---- wet: darker + more saturated cardboard, largest connected blob ----
  const vs = [], sts = [];
  for (let k = 0; k < N; k++) if (inside[k] && card[k]) { vs.push(vv[k]); sts.push(ss[k]); }
  const medV = median(vs), medS = median(sts);
  const wet = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (inside[k] && card[k] && vv[k] < medV * 0.8 && ss[k] > medS + 0.08) wet[k] = 1;
  }
  let best = { n: 0 };
  const seen = new Uint8Array(N);
  const stack = [];
  for (let k = 0; k < N; k++) {
    if (!wet[k] || seen[k]) continue;
    let n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack.push(k); seen[k] = 1;
    while (stack.length) {
      const c = stack.pop(), cx = c % W, cy = (c / W) | 0;
      n++;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = ny * W + nx;
        if (wet[nk] && !seen[nk]) { seen[nk] = 1; stack.push(nk); }
      }
    }
    if (n > best.n) best = { n, x0, y0, x1, y1 };
  }
  const wetRatio = best.n / area;

  const clamp = (v) => Math.max(0, Math.min(1, v));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const detections = [];
  const deformConf = clamp((0.97 - fill) / 0.17);  // fill 0.97 -> 0, 0.885 -> 0.5, 0.80 -> 1
  if (deformConf > 0.15) {
    detections.push({ label: 'deform', conf: r3(deformConf), x: bx0 / W, y: by0 / H, w: (bx1 - bx0 + 1) / W, h: (by1 - by0 + 1) / H, cam, src: 'cv' });
  }
  const wetConf = clamp(wetRatio / 0.06);           // 3 % of the box wet -> 0.5
  if (wetConf > 0.15 && best.n >= 12) {
    detections.push({ label: 'wet', conf: r3(wetConf), x: best.x0 / W, y: best.y0 / H, w: (best.x1 - best.x0 + 1) / W, h: (best.y1 - best.y0 + 1) / H, cam, src: 'cv' });
  }
  return { detections, metrics: { box_found: true, fill: r3(fill), wet_ratio: r3(wetRatio) } };
}

module.exports = { analyzeBox };
