// Failure case 2 (OFFLINE FAIL-SAFE): kill the cloud while parcels are running,
// the station must keep deciding, then everything must reach the cloud after it comes back.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel-test-'));
const env = {
  ...process.env,
  CLOUD_HTTP_PORT: '3190', CLOUD_DATA_DIR: path.join(tmp, 'cloud'),
  EDGE_HTTP_PORT: '8190', EDGE_BROKER_PORT: '1893', EDGE_DATA_DIR: path.join(tmp, 'edge'),
  CLOUD_URL: 'http://localhost:3190', EDGE_ID: 'test-hub', PARCEL_NO_ENV_FILE: '1',
};
const start = (file, args = []) => spawn(process.execPath, [path.join(root, file), ...args], { cwd: root, env, stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => fetch(u).then((r) => r.json());

test('station keeps sorting offline and syncs afterwards', { timeout: 60000 }, async () => {
  let cloud = start('cloud/server.js');
  await wait(800);
  const edge = start('edge/index.js');
  await wait(1000);
  const sim = start('simulator/sim.js', ['--interval', '700']);
  try {
    await wait(4000);
    const before = await get('http://localhost:3190/api/summary?from=1');
    assert.ok(before.total > 0, 'cloud received data while online');

    cloud.kill();                       // ---- internet / server down (12 s) ----
    await wait(12000);
    const st = await get('http://localhost:8190/api/status');
    assert.equal(st.cloud, false);
    assert.equal(st.light, 'yellow', 'tower light shows yellow while offline');
    assert.ok(st.pending_sync > 0, 'records are queued locally');
    const localCount = (await get('http://localhost:8190/api/recent')).length;
    assert.ok(localCount > before.total, 'station kept deciding while offline');

    cloud = start('cloud/server.js');     // ---- back online ----
    await wait(9000);
    const after = await get('http://localhost:3190/api/summary?from=1');
    const st2 = await get('http://localhost:8190/api/status');
    assert.equal(st2.cloud, true);
    assert.ok(after.total >= localCount, `cloud has every local record (${after.total} >= ${localCount})`);
    assert.ok(after.synced_late > 0, 'backlog arrived late but arrived');
    assert.ok(st2.pending_sync <= 2, `backlog drained (pending ${st2.pending_sync})`);
  } finally {
    sim.kill(); edge.kill(); cloud.kill();
  }
});
