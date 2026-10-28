// Synthetic camera frames + random parcel scenarios (shared by the simulator and the seed script).
const jpeg = require('jpeg-js');

const W = 640, H = 480;
function frame(kind, defect, dark) {
  const data = Buffer.alloc(W * H * 4);
  const k = dark ? 0.08 : 1;
  const bx = 140, by = 90, bw = 360, bh = 300; // box rectangle
  const rnd = (a) => (Math.random() - 0.5) * a;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 55, g = 58, b = 64;                                   // belt
      if ((x + y * 3) % 40 < 2) { r += 10; g += 10; b += 10; }      // belt texture
      let inBox = x >= bx && x < bx + bw && y >= by && y < by + bh;
      if (inBox && defect && defect.type === 'deform') {             // crushed: big bite out of one edge + skewed corner
        const ex = (x - defect.cx) / defect.r, ey = (y - defect.cy) / defect.r;
        if (ex * ex + ey * ey < 1) inBox = false;
        const cx0 = x - (bx + bw - 110), cy0 = y - (by + bh - 110);
        if (cx0 > 0 && cy0 > 0 && cx0 + cy0 > 110) inBox = false;     // squashed corner
      }
      if (inBox) {
        r = 182; g = 138; b = 90;                                   // cardboard
        if (kind === 'top' && x > bx + bw / 2 - 25 && x < bx + bw / 2 + 25) { r = 205; g = 180; b = 140; } // tape
        if (x > bx + 30 && x < bx + 150 && y > by + 30 && y < by + 90) { r = 240; g = 240; b = 235; }   // label
        const surf = kind === 'top' && defect ? defect.type : null;
        if (surf === 'wet') {                                       // water stain: darker + more saturated, ragged edge
          const inBlob = defect.blobs.some(([cx, cy, rr]) => (x - cx) ** 2 + (y - cy) ** 2 < (rr + Math.sin(x * 0.3) * 4 + Math.cos(y * 0.27) * 4) ** 2);
          if (inBlob) { r = 122; g = 74; b = 32; }
        }
        if (surf === 'graphic') {                  // printed graphic that looks like a tear
          const zz = Math.abs(((x - defect.x) % 30) - 15);
          if (x > defect.x && x < defect.x + defect.w && Math.abs(y - (defect.y + zz)) < 3) { r = 30; g = 30; b = 30; }
        }
        if (surf === 'dent') {
          const dx = (x - defect.cx) / defect.rx, dy = (y - defect.cy) / defect.ry, d = dx * dx + dy * dy;
          if (d < 1) { const s = 0.45 + 0.55 * d; r *= s; g *= s; b *= s; }
        }
        if (surf === 'tear') {
          const t = (x - defect.x) / defect.w;
          if (t >= 0 && t <= 1) {
            const cy = defect.y + Math.sin(t * 9) * 10 + t * 25;
            const dist = Math.abs(y - cy);
            if (dist < 6) { r = 25; g = 20; b = 15; } else if (dist < 9) { r = 235; g = 225; b = 205; }
          }
        }
      }
      const n = rnd(8);
      const i = (y * W + x) * 4;
      data[i] = Math.max(0, Math.min(255, (r + n) * k));
      data[i + 1] = Math.max(0, Math.min(255, (g + n) * k));
      data[i + 2] = Math.max(0, Math.min(255, (b + n) * k));
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width: W, height: H }, 70).data.toString('base64');
}

function makeScenario(state = {}) {
  const roll = Math.random();
  let type = 'ok';
  if (state.forceDamage) { type = ['dent', 'tear', 'deform', 'wet'][Math.floor(Math.random() * 4)]; state.forceDamage = false; }
  else if (roll < 0.07) type = 'dent';
  else if (roll < 0.13) type = 'tear';
  else if (roll < 0.18) type = 'deform';
  else if (roll < 0.24) type = 'wet';
  else if (roll < 0.29) type = 'graphic'; // Failure case 1: false-positive bait
  const dets = [];
  let defect = null;
  if (type === 'dent') {
    defect = { type, cx: 260 + Math.random() * 160, cy: 180 + Math.random() * 120, rx: 45, ry: 35 };
    dets.push({ label: 'dent', confidence: +(0.72 + Math.random() * 0.25).toFixed(3), x: (defect.cx - defect.rx) / W, y: (defect.cy - defect.ry) / H, w: (2 * defect.rx) / W, h: (2 * defect.ry) / H, cam: 'top' });
  } else if (type === 'tear') {
    defect = { type, x: 200 + Math.random() * 120, y: 200 + Math.random() * 80, w: 140 };
    dets.push({ label: 'tear', confidence: +(0.7 + Math.random() * 0.28).toFixed(3), x: defect.x / W, y: (defect.y - 15) / H, w: defect.w / W, h: 60 / H, cam: 'top' });
  } else if (type === 'graphic') {
    defect = { type, x: 300, y: 300, w: 150 };
    dets.push({ label: 'tear', confidence: +(0.25 + Math.random() * 0.2).toFixed(3), x: 300 / W, y: 290 / H, w: 150 / W, h: 30 / H, cam: 'top' });
  } else if (type === 'deform') {
    // the AI model has no 'deform' class here on purpose: the gateway's shape check must catch it
    defect = { type, cx: 220 + Math.random() * 200, cy: 90, r: 95 + Math.random() * 30 };
  } else if (type === 'wet') {
    // likewise for 'wet': caught by the colour check (darker + more saturated patch)
    const cx = 230 + Math.random() * 180, cy = 170 + Math.random() * 140;
    defect = { type, blobs: [[cx, cy, 34], [cx + 30, cy + 14, 26], [cx - 22, cy + 22, 22]] };
  }
  return { type, defect, dets };
}

module.exports = { frame, makeScenario, W, H };
