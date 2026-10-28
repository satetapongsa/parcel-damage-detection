// CLOUD API — one Express app that runs as a Vercel serverless function (api/index.js)
// and as a normal local server (cloud/server.js).
//
// Edge -> Cloud  : HTTPS POST /api/ingest/* with header  x-api-key: <INGEST_API_KEY>
// Cloud -> Edge  : config is returned in the response of every /api/ingest/status heartbeat
// Dashboard      : polls /api/feed every few seconds (serverless-friendly, no websockets)
const express = require('express');
const { DEFAULT_CONFIG, sanitizeConfig } = require('../shared/common');
const { createDb } = require('./db');

const db = createDb();
const app = express();
app.use(express.json({ limit: '10mb' }));

const INGEST_KEY = process.env.INGEST_API_KEY || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ONLINE_MS = 20000; // edge heartbeat is every 5 s

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});
const needIngest = (req, res, next) => (!INGEST_KEY || req.get('x-api-key') === INGEST_KEY ? next() : res.status(401).json({ error: 'bad api key' }));
const needAdmin = (req, res, next) => (!ADMIN_KEY || req.get('x-admin-key') === ADMIN_KEY ? next() : res.status(401).json({ error: 'ต้องใส่ Admin key' }));

function edgeView(r) {
  const s = JSON.parse(r.status || '{}');
  return { ...s, edge_id: r.edge_id, online: s.online !== false && Date.now() - r.last_seen < ONLINE_MS, last_seen: r.last_seen };
}
const parseInsp = (r) => ({ ...r, detections: JSON.parse(r.detections || '[]') });

// Shared WHERE builder: range / edge / result / reason / text search
function where(q, startIdx = 1) {
  const c = [], p = [];
  const add = (sql, v) => { p.push(v); c.push(sql.replace('?', `$${startIdx + p.length - 1}`)); };
  const from = Number(q.from) || Date.now() - 24 * 3600e3;
  const to = Number(q.to) || Date.now() + 60e3;
  add('ts >= ?', from);
  add('ts <= ?', to);
  if (q.edge) add('edge_id = ?', String(q.edge));
  if (q.result) add('result = ?', String(q.result).toUpperCase());
  if (q.reason) add('reason LIKE ?', `%${String(q.reason).toUpperCase()}%`);
  if (q.q) add('(LOWER(tracking) LIKE ? OR id LIKE $X)', `%${String(q.q).trim().toLowerCase()}%`);
  const sql = 'WHERE ' + c.join(' AND ').replace('$X', `$${startIdx + p.length - 1}`);
  return { sql, p, from, to, next: startIdx + p.length };
}
const SUM = (cond) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END)`;

// ======================= INGEST (from edge gateways) =======================
app.post('/api/ingest/inspection', needIngest, wrap(async (req, res) => {
  const m = req.body || {};
  if (!m.id || !m.edge_id) return res.status(400).json({ error: 'id and edge_id required' });
  const now = Date.now();
  const saveImg = async (name, b64) => {
    if (!b64) return null;
    const key = `${m.id}_${name}.jpg`;
    await db.run('INSERT INTO images (name, data) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [key, b64]);
    return key;
  };
  const det = Array.isArray(m.detections) ? m.detections : [];
  const imgTop = await saveImg('top', m.images?.top);
  const imgSide = await saveImg('side', m.images?.side);
  const r = await db.run(`INSERT INTO inspections
    (id, edge_id, seq, tracking, result, reason, decided_by, detections, max_conf, dent, tear, deform, wet, weight_g, brightness, img_top, img_side, latency_ms, ts, received_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (id) DO NOTHING`, [
    String(m.id), String(m.edge_id), m.seq ?? null, m.tracking ?? null, m.result, m.reason, m.decided_by,
    JSON.stringify(det), m.max_conf ?? null,
    ...['DENT', 'TEAR', 'DEFORM', 'WET'].map((c) => (String(m.reason || '').split('+').includes(c) ? 1 : 0)), // only defects that caused the reject
    m.weight_g ?? null, m.brightness ?? null, imgTop, imgSide, m.latency_ms ?? null, m.ts || now, now,
  ]);
  res.json({ ok: true, inserted: r.changes });
}));

app.post('/api/ingest/alert', needIngest, wrap(async (req, res) => {
  const a = req.body || {};
  if (!a.id || !a.edge_id) return res.status(400).json({ error: 'id and edge_id required' });
  await db.run(`INSERT INTO alerts (id, edge_id, type, severity, message, ts, received_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
  [String(a.id), String(a.edge_id), a.type, a.severity, a.message, a.ts || Date.now(), Date.now()]);
  res.json({ ok: true });
}));

// heartbeat: stores edge status, adopts newer station-side config, returns the config the edge should run
app.post('/api/ingest/status', needIngest, wrap(async (req, res) => {
  const s = req.body || {};
  if (!s.edge_id) return res.status(400).json({ error: 'edge_id required' });
  const edge = String(s.edge_id);
  await db.run(`INSERT INTO edges (edge_id, status, last_seen) VALUES ($1, $2, $3)
    ON CONFLICT (edge_id) DO UPDATE SET status = EXCLUDED.status, last_seen = EXCLUDED.last_seen`, [edge, JSON.stringify(s), Date.now()]);
  let cur = await db.get('SELECT config, updated_at FROM configs WHERE edge_id = $1', [edge]);
  if (s.config && s.config_updated_at && (!cur || cur.updated_at < s.config_updated_at)) {
    const cfg = JSON.stringify(sanitizeConfig(s.config));
    await db.run(`INSERT INTO configs (edge_id, config, updated_at) VALUES ($1, $2, $3)
      ON CONFLICT (edge_id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`, [edge, cfg, s.config_updated_at]);
    cur = { config: cfg, updated_at: s.config_updated_at };
  }
  res.json(cur ? { config: JSON.parse(cur.config), updated_at: cur.updated_at } : { config: null, updated_at: 0 });
}));

// ======================= DASHBOARD API =======================
app.get('/api/health', wrap(async (_req, res) => res.json({ ok: true, db: db.kind, auth: { ingest: !!INGEST_KEY, admin: !!ADMIN_KEY } })));

app.get('/api/summary', wrap(async (req, res) => {
  const w = where(req.query);
  const s = await db.get(`SELECT COUNT(*) total, ${SUM("result = 'PASS'")} pass, ${SUM("result = 'REJECT'")} reject,
      SUM(dent) dent, SUM(tear) tear, SUM(deform) deform, SUM(wet) wet, ${SUM("decided_by = 'FAILSAFE'")} failsafe, ${SUM('tracking IS NULL')} no_barcode,
      ROUND(AVG(latency_ms)) avg_latency, ROUND(CAST(AVG(weight_g) AS NUMERIC), 1) avg_weight,
      ${SUM('received_at - ts > 10000')} synced_late
    FROM inspections ${w.sql}`, w.p);
  const a = await db.get(`SELECT COUNT(*) n FROM alerts WHERE ack = 0 AND severity <> 'info' AND ts >= $1`, [w.from]);
  for (const k of Object.keys(s)) s[k] = s[k] ?? 0;
  s.reject_rate = s.total ? Math.round((s.reject / s.total) * 1000) / 10 : 0;
  s.open_alerts = a.n;
  res.json(s);
}));

app.get('/api/timeseries', wrap(async (req, res) => {
  const w = where(req.query);
  const span = w.to - w.from;
  const bucket = Number(req.query.bucket) || (span <= 2 * 3600e3 ? 60e3 : span <= 2 * 86400e3 ? 3600e3 : 86400e3);
  const off = Number(req.query.tz) || 0; // client UTC offset in ms, so day buckets start at local midnight
  const b = `CAST($${w.next} AS BIGINT)`, o = `CAST($${w.next + 1} AS BIGINT)`;
  const rows = await db.all(`SELECT ((ts + ${o}) / ${b}) * ${b} - ${o} t, ${SUM("result = 'PASS'")} pass, ${SUM("result = 'REJECT'")} reject,
      SUM(dent) dent, SUM(tear) tear, SUM(deform) deform, SUM(wet) wet
    FROM inspections ${w.sql} GROUP BY 1 ORDER BY 1`, [...w.p, bucket, off]);
  res.json({ bucket, rows });
}));

app.get('/api/breakdown', wrap(async (req, res) => {
  const w = where(req.query);
  const off = Number(req.query.tz) || 0;
  const [reasons, byHour, byEdge, conf] = await Promise.all([
    db.all(`SELECT reason, COUNT(*) n FROM inspections ${w.sql} AND result = 'REJECT' GROUP BY reason ORDER BY n DESC`, w.p),
    db.all(`SELECT ((ts + CAST($${w.next} AS BIGINT)) / 3600000) % 24 h, COUNT(*) total, ${SUM("result = 'REJECT'")} reject
      FROM inspections ${w.sql} GROUP BY 1 ORDER BY 1`, [...w.p, off]),
    db.all(`SELECT edge_id, COUNT(*) total, ${SUM("result = 'REJECT'")} reject, ROUND(AVG(latency_ms)) avg_latency
      FROM inspections ${w.sql} GROUP BY edge_id`, w.p),
    db.all(`SELECT ROUND(max_conf * 10) / 10 bin, COUNT(*) n FROM inspections ${w.sql} AND max_conf IS NOT NULL GROUP BY 1 ORDER BY 1`, w.p),
  ]);
  res.json({ reasons, by_hour: byHour, by_edge: byEdge, conf });
}));

app.get('/api/inspections', wrap(async (req, res) => {
  const w = where({ from: 1, ...req.query });
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const [rows, total] = await Promise.all([
    db.all(`SELECT * FROM inspections ${w.sql} ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`, w.p),
    db.get(`SELECT COUNT(*) n FROM inspections ${w.sql}`, w.p),
  ]);
  res.json({ total: total.n, rows: rows.map(parseInsp) });
}));

app.get('/api/inspections/:id', wrap(async (req, res) => {
  const r = await db.get('SELECT * FROM inspections WHERE id = $1', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'not found' });
  const history = r.tracking
    ? await db.all('SELECT id, edge_id, result, reason, ts FROM inspections WHERE tracking = $1 ORDER BY ts', [r.tracking])
    : [];
  res.json({ ...parseInsp(r), history });
}));

app.get('/api/images/:name', wrap(async (req, res) => {
  const r = await db.get('SELECT data FROM images WHERE name = $1', [req.params.name]);
  if (!r) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(r.data, 'base64'));
}));

app.get('/api/export.csv', wrap(async (req, res) => {
  const w = where({ from: 1, ...req.query });
  const rows = await db.all(`SELECT ts, edge_id, tracking, result, reason, decided_by, max_conf, weight_g, brightness, latency_ms, id
    FROM inspections ${w.sql} ORDER BY ts DESC LIMIT 50000`, w.p);
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = 'time,edge_id,tracking,result,reason,decided_by,max_conf,weight_g,brightness,latency_ms,id';
  const body = rows.map((r) => [new Date(r.ts).toISOString(), r.edge_id, r.tracking, r.result, r.reason, r.decided_by, r.max_conf, r.weight_g, r.brightness, r.latency_ms, r.id].map(esc).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="inspections.csv"');
  res.send('﻿' + [head, ...body].join('\n'));
}));

app.get('/api/alerts', wrap(async (req, res) => {
  const open = req.query.open === '1';
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(await db.all(`SELECT * FROM alerts ${open ? "WHERE ack = 0 AND severity <> 'info'" : ''} ORDER BY ts DESC LIMIT ${limit}`));
}));
app.post('/api/alerts/ack-all', needAdmin, wrap(async (_req, res) => {
  await db.run('UPDATE alerts SET ack = 1, ack_ts = $1 WHERE ack = 0', [Date.now()]);
  res.json({ ok: true });
}));
app.post('/api/alerts/:id/ack', needAdmin, wrap(async (req, res) => {
  await db.run('UPDATE alerts SET ack = 1, ack_ts = $1 WHERE id = $2', [Date.now(), req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/edges', wrap(async (_req, res) => {
  res.json((await db.all('SELECT * FROM edges ORDER BY edge_id')).map(edgeView));
}));

app.get('/api/config/:edge', wrap(async (req, res) => {
  const r = await db.get('SELECT config, updated_at FROM configs WHERE edge_id = $1', [req.params.edge]);
  res.json({ edge_id: req.params.edge, config: r ? JSON.parse(r.config) : { ...DEFAULT_CONFIG }, updated_at: r?.updated_at || 0, defaults: DEFAULT_CONFIG });
}));
app.put('/api/config/:edge', needAdmin, wrap(async (req, res) => {
  const edge = req.params.edge;
  const cur = await db.get('SELECT config FROM configs WHERE edge_id = $1', [edge]);
  const config = sanitizeConfig(req.body, cur ? JSON.parse(cur.config) : DEFAULT_CONFIG);
  if (config.ai_timeout_ms >= config.reject_delay_ms) {
    return res.status(400).json({ error: 'ai_timeout_ms ต้องน้อยกว่า reject_delay_ms (ไม่งั้นแขนปัดจะปัดไม่ทัน)' });
  }
  const updated_at = Date.now();
  await db.run(`INSERT INTO configs (edge_id, config, updated_at) VALUES ($1, $2, $3)
    ON CONFLICT (edge_id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`, [edge, JSON.stringify(config), updated_at]);
  // the edge picks this up on its next heartbeat (≤ 5 s), or when it reconnects
  res.json({ edge_id: edge, config, updated_at });
}));

// polled by the dashboard for live updates
app.get('/api/feed', wrap(async (req, res) => {
  const since = Number(req.query.since) || Date.now() - 60e3;
  const now = Date.now();
  const [inspections, alerts, edges] = await Promise.all([
    db.all('SELECT * FROM inspections WHERE received_at > $1 ORDER BY received_at DESC LIMIT 50', [since]),
    db.all('SELECT * FROM alerts WHERE received_at > $1 ORDER BY received_at DESC LIMIT 50', [since]),
    db.all('SELECT * FROM edges ORDER BY edge_id'),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({ now, inspections: inspections.map(parseInsp), alerts, edges: edges.map(edgeView) });
}));

module.exports = app;
