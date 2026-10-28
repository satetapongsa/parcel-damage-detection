// Generates synthetic sample images per box condition into datasets/synthetic/<class>/
// (for demos, testing the colour/shape check, and showing the expected classes).
//   node scripts/make-samples.js [--per-class 6]
const fs = require('node:fs');
const path = require('node:path');
const { frame, makeScenario } = require('../simulator/scene');

const i = process.argv.indexOf('--per-class');
const PER = i > 0 ? Number(process.argv[i + 1]) : 6;
const out = path.join(__dirname, '..', 'datasets', 'synthetic');
const map = { ok: 'normal', dent: 'dent', tear: 'tear', graphic: 'normal_printed_graphic', deform: 'deform', wet: 'wet' };

for (const [type, folder] of Object.entries(map)) {
  const dir = path.join(out, folder);
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= PER; n++) {
    let sc;
    do { sc = makeScenario(); } while (sc.type !== type);
    fs.writeFileSync(path.join(dir, `${folder}_${n}_top.jpg`), Buffer.from(frame('top', sc.defect, false), 'base64'));
    if (type === 'deform') fs.writeFileSync(path.join(dir, `${folder}_${n}_side.jpg`), Buffer.from(frame('side', sc.defect, false), 'base64'));
  }
  console.log(`${folder}: ${PER} images`);
}
console.log('saved to', out);
