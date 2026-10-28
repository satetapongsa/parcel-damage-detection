// SIMULATOR — pretends to be the ESP32 controller AND CiRA CORE so the whole pipeline
// can be demoed without hardware. Talks to the edge gateway's local MQTT broker.
//
//   node simulator/sim.js [--interval 2500] [--dark] [--no-ai] [--count 0]
//   keys while running:  d = toggle dark camera   a = toggle AI on/off   j = belt jam 4s
//                        r = next parcel damaged  p = pause/resume       q = quit
const mqtt = require('mqtt');
const { TOPICS, log } = require('../shared/common');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const state = {
  interval: Number(opt('interval', 2500)),
  count: Number(opt('count', 0)),
  dark: flag('dark'),
  ai: !flag('no-ai'),
  forceDamage: false,
  paused: false,
  seq: 0,
  delayMs: 1500,
};
const url = opt('broker', process.env.EDGE_BROKER_URL || `mqtt://localhost:${process.env.EDGE_BROKER_PORT || 1883}`);
const c = mqtt.connect(url, { clientId: `sim-${Math.random().toString(16).slice(2, 6)}` });
const tag = 'sim';

const { frame, makeScenario, W, H } = require('./scene');

const pendingScenario = new Map(); // seq -> scenario

function runParcel() {
  if (state.paused) return;
  const seq = ++state.seq;
  const tracking = 'TH' + String(Math.floor(1e11 + Math.random() * 9e11));
  const sc = makeScenario(state);
  pendingScenario.set(seq, sc);
  // 1) barcode scanner reads label before the parcel reaches the IR beam
  c.publish(TOPICS.scan, JSON.stringify({ code: tracking }));
  // 2) IR breakbeam -> trigger, 3) load cell weight
  setTimeout(() => {
    c.publish(TOPICS.esp32Evt, JSON.stringify({ evt: 'trigger', seq }));
    setTimeout(() => {
      const g = sc.type === 'dent' ? 300 + Math.random() * 400 : 450 + Math.random() * 900;
      c.publish(TOPICS.esp32Evt, JSON.stringify({ evt: 'weight', seq, g: +g.toFixed(1) }));
    }, 120);
  }, 300);
  log(tag, `parcel #${seq} ${tracking} scenario=${sc.type}${state.dark ? ' (DARK camera)' : ''}${state.ai ? '' : ' (AI OFF)'}`);
  if (state.count && seq >= state.count) { clearInterval(timer); setTimeout(() => process.exit(0), 4000); }
}

// fake CiRA CORE: capture when the gateway says so, run "inference", publish result
c.on('message', (topic, buf) => {
  const m = JSON.parse(buf.toString());
  if (topic === TOPICS.edgeTrigger) {
    if (!state.ai) return;
    const sc = pendingScenario.get(m.seq) || makeScenario(state);
    pendingScenario.delete(m.seq);
    setTimeout(() => {
      const top = frame('top', sc.defect, state.dark);
      const side = frame('side', sc.defect, state.dark);
      c.publish(TOPICS.ciraResult, JSON.stringify({
        parcel_id: m.parcel_id, seq: m.seq, model: 'cira-sim-yolo', img_w: W, img_h: H,
        detections: state.dark ? [] : sc.dets, images: { top, side },
      }));
    }, 150 + Math.random() * 250);
  } else if (topic === TOPICS.esp32Cmd) {
    if (m.cmd === 'reject') {
      log(tag, `  ESP32: RED + buzzer, servo PUSH seq ${m.seq} in ${state.delayMs} ms`);
      setTimeout(() => c.publish(TOPICS.esp32Evt, JSON.stringify({ evt: 'done', seq: m.seq, action: 'reject' })), state.delayMs);
    } else if (m.cmd === 'pass') log(tag, `  ESP32: GREEN seq ${m.seq}`);
    else if (m.cmd === 'config') { state.delayMs = m.delay_ms; log(tag, `  ESP32: config delay=${m.delay_ms}ms hold=${m.hold_ms}ms jam=${m.jam_ms}ms failsafe=${m.failsafe}`); }
    else if (m.cmd === 'light') log(tag, `  ESP32: tower base light = ${m.base.toUpperCase()}`);
  }
});

let timer;
c.on('connect', () => {
  log(tag, `connected to ${url} — interval ${state.interval} ms`);
  c.subscribe([TOPICS.edgeTrigger, TOPICS.esp32Cmd]);
  c.publish(TOPICS.esp32Evt, JSON.stringify({ evt: 'hello', fw: 'sim-1.0' }));
  setInterval(() => c.publish(TOPICS.esp32Evt, JSON.stringify({ evt: 'hb' })), 2000);
  if (!timer) timer = setInterval(runParcel, state.interval);
});

function jam() {
  log(tag, 'BELT JAM simulated (IR blocked 4 s)');
  state.paused = true;
  setTimeout(() => c.publish(TOPICS.esp32Evt, JSON.stringify({ evt: 'jam', ms: 3000 })), 3000);
  setTimeout(() => { c.publish(TOPICS.esp32Evt, JSON.stringify({ evt: 'jam_clear' })); state.paused = false; }, 7000);
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (b) => {
    const k = b.toString();
    if (k === 'q' || k === '\u0003') process.exit(0);
    if (k === 'd') { state.dark = !state.dark; log(tag, `dark camera ${state.dark ? 'ON' : 'OFF'}`); }
    if (k === 'a') { state.ai = !state.ai; log(tag, `AI ${state.ai ? 'ON' : 'OFF (timeouts expected)'}`); }
    if (k === 'j') jam();
    if (k === 'r') { state.forceDamage = true; log(tag, 'next parcel will be damaged'); }
    if (k === 'p') { state.paused = !state.paused; log(tag, state.paused ? 'paused' : 'resumed'); }
  });
  log(tag, 'keys: d=dark  a=AI on/off  j=jam  r=damage next  p=pause  q=quit');
}
