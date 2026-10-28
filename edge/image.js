// Image helpers: decode base64 JPEG from CiRA CORE and measure mean brightness
// (System anomaly: VISION FAULT = camera blocked / dirty lens / lights off).
const jpeg = require('jpeg-js');

function toBuffer(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  const clean = b64.replace(/^data:image\/\w+;base64,/, '');
  try { return Buffer.from(clean, 'base64'); } catch { return null; }
}

// -> { width, height, data: RGBA } or null
function decode(buf) {
  if (!buf) return null;
  try { return jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 }); } catch { return null; }
}

// Mean luma (0-255) sampled on a grid so a 1080p frame stays fast.
function meanBrightness(img) {
  if (!img) return null;
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 20000)));
  let sum = 0, n = 0;
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      n++;
    }
  }
  return Math.round((sum / n) * 10) / 10;
}

module.exports = { toBuffer, decode, meanBrightness };
