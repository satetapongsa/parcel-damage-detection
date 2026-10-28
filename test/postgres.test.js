// Runs every cloud API endpoint against real Postgres (PGlite, in-process) —
// the same SQL that runs on Vercel + Neon.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

test('cloud API works on Postgres', { timeout: 60000 }, async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  global.__PG_QUERY__ = async (q, p) => {
    const r = await pg.query(q, p);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  const app = require('../cloud/app');
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}`;
  const j = async (path, opt) => {
    const r = await fetch(base + path, opt);
    const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
    assert.ok(r.ok, `${path} -> ${r.status} ${JSON.stringify(body)}`);
    return body;
  };
  const post = (path, body, method = 'POST') => j(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  try {
    const now = Date.now();
    const id = crypto.randomUUID();
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    await post('/api/ingest/inspection', { id, edge_id: 'hub-01', seq: 1, tracking: 'TH123', result: 'REJECT', reason: 'DENT', decided_by: 'AI',
      detections: [{ cls: 'dent', conf: 0.9, box: [0.1, 0.1, 0.2, 0.2], cam: 'top' }], max_conf: 0.9, weight_g: 512.5, brightness: 90, latency_ms: 300, ts: now - 1000, images: { top: img } });
    await post('/api/ingest/inspection', { id, edge_id: 'hub-01', result: 'REJECT', reason: 'DENT', ts: now }); // duplicate -> ignored
    await post('/api/ingest/inspection', { id: crypto.randomUUID(), edge_id: 'hub-01', tracking: null, result: 'PASS', reason: 'OK', decided_by: 'AI', detections: [], ts: now - 20 * 3600e3 });
    await post('/api/ingest/alert', { id: crypto.randomUUID(), edge_id: 'hub-01', type: 'BELT_JAM', severity: 'critical', message: 'x', ts: now });
    const hb = await post('/api/ingest/status', { edge_id: 'hub-01', online: true, config: { reject_delay_ms: 1800 }, config_updated_at: now });
    assert.equal(hb.config.reject_delay_ms, 1800);

    const s = await j(`/api/summary?from=${now - 86400e3}&tz=25200000`);
    assert.deepEqual([s.total, s.pass, s.reject, s.dent, s.no_barcode, s.open_alerts], [2, 1, 1, 1, 1, 1]);
    assert.equal(typeof s.avg_latency, 'number');

    const ts = await j(`/api/timeseries?from=${now - 86400e3}&tz=25200000`);
    assert.equal(ts.bucket, 3600e3);
    assert.equal(ts.rows.reduce((a, r) => a + r.pass + r.reject, 0), 2);
    assert.ok(ts.rows.every((r) => Number.isInteger(r.t) && (r.t + 25200000) % 3600e3 === 0));

    const b = await j(`/api/breakdown?from=${now - 86400e3}&tz=25200000`);
    assert.equal(b.reasons[0].reason, 'DENT');
    assert.ok(b.by_hour.every((x) => x.h >= 0 && x.h < 24));

    const list = await j('/api/inspections?q=th123');
    assert.equal(list.total, 1);
    assert.equal(list.rows[0].detections[0].cls, 'dent');
    const one = await j(`/api/inspections/${id}`);
    assert.equal(one.history.length, 1);
    const pic = await fetch(`${base}/api/images/${one.img_top}`);
    assert.equal(pic.headers.get('content-type'), 'image/jpeg');

    assert.match(await j('/api/export.csv'), /TH123/);
    const alerts = await j('/api/alerts?open=1');
    await post(`/api/alerts/${alerts[0].id}/ack`, {});
    await post('/api/alerts/ack-all', {});
    assert.equal((await j('/api/alerts?open=1')).length, 0);

    assert.equal((await j('/api/edges'))[0].online, true);
    const cfg = await post('/api/config/hub-01', { reject_delay_ms: 2000, conf_tear: 0.7 }, 'PUT');
    assert.equal(cfg.config.conf_tear, 0.7);
    assert.equal((await post('/api/ingest/status', { edge_id: 'hub-01' })).config.reject_delay_ms, 2000);

    const feed = await j(`/api/feed?since=${now - 60000}`);
    assert.equal(feed.inspections.length, 2);
  } finally {
    server.close();
    delete global.__PG_QUERY__;
  }
});
