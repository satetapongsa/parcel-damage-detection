// Starts cloud + edge + simulator together (one laptop demo).
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const procs = [];
const run = (name, file, args = [], delay = 0) => setTimeout(() => {
  const p = spawn(process.execPath, [path.join(root, file), ...args], { cwd: root, stdio: 'inherit', env: { ...process.env, DEMO_PARENT_PID: String(process.pid) } });
  p.on('exit', (code) => { console.log(`[demo] ${name} exited (${code})`); });
  procs.push(p);
}, delay);

run('cloud', 'cloud/server.js');
run('edge', 'edge/index.js', [], 800);
run('sim', 'simulator/sim.js', process.argv.slice(2), 2000);

const stop = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
