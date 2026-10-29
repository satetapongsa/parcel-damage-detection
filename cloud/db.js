// Cloud database adapter.
//   DATABASE_URL set  -> Postgres (Neon / Vercel Postgres)   — used on Vercel
//   otherwise         -> local SQLite file (node:sqlite)     — used by `npm run cloud` / demo
// SQL is written once with $1, $2… placeholders and portable functions (CASE, integer math).
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS inspections (
    id TEXT PRIMARY KEY, edge_id TEXT, seq BIGINT, tracking TEXT, result TEXT, reason TEXT,
    decided_by TEXT, detections TEXT, max_conf DOUBLE PRECISION, dent INTEGER, tear INTEGER, deform INTEGER, wet INTEGER,
    weight_g DOUBLE PRECISION, brightness DOUBLE PRECISION, img_top TEXT, img_side TEXT,
    latency_ms BIGINT, ts BIGINT, received_at BIGINT, demo INTEGER DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS idx_insp_ts ON inspections(ts)',
  'CREATE INDEX IF NOT EXISTS idx_insp_tracking ON inspections(tracking)',
  'CREATE INDEX IF NOT EXISTS idx_insp_received ON inspections(received_at)',
  `CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY, edge_id TEXT, type TEXT, severity TEXT, message TEXT,
    ts BIGINT, received_at BIGINT, ack INTEGER DEFAULT 0, ack_ts BIGINT, demo INTEGER DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS idx_alert_ts ON alerts(ts)',
  'CREATE TABLE IF NOT EXISTS edges (edge_id TEXT PRIMARY KEY, status TEXT, last_seen BIGINT)',
  'CREATE TABLE IF NOT EXISTS configs (edge_id TEXT PRIMARY KEY, config TEXT, updated_at BIGINT)',
  'CREATE TABLE IF NOT EXISTS images (name TEXT PRIMARY KEY, data TEXT)',
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)',
];

// Columns added after the first release — applied to older databases, errors (= already there) ignored.
const MIGRATIONS = [
  'ALTER TABLE inspections ADD COLUMN deform INTEGER',
  'ALTER TABLE inspections ADD COLUMN wet INTEGER',
  'ALTER TABLE inspections ADD COLUMN demo INTEGER DEFAULT 0',
  'ALTER TABLE alerts ADD COLUMN demo INTEGER DEFAULT 0',
];

// Postgres only: a human-readable log for the Neon SQL editor  (SELECT * FROM inspection_log;)
const PG_VIEWS = [`CREATE OR REPLACE VIEW inspection_log AS
  SELECT to_timestamp(ts / 1000.0) AT TIME ZONE 'Asia/Bangkok' AS inspected_at,
    to_timestamp(received_at / 1000.0) AT TIME ZONE 'Asia/Bangkok' AS synced_at,
    edge_id AS station, tracking, result,
    CASE WHEN result = 'PASS' THEN 'ผ่าน' ELSE 'ไม่ผ่าน (ปัดออก)' END AS result_th,
    reason, decided_by,
    dent = 1 AS is_dent, tear = 1 AS is_tear, deform = 1 AS is_deform, wet = 1 AS is_wet,
    ROUND(CAST(max_conf AS NUMERIC), 3) AS max_confidence, weight_g, brightness, latency_ms,
    demo = 1 AS is_demo, id
  FROM inspections ORDER BY ts DESC`,
  `CREATE OR REPLACE VIEW alert_log AS
  SELECT to_timestamp(ts / 1000.0) AT TIME ZONE 'Asia/Bangkok' AS happened_at, edge_id AS station,
    type, severity, message, ack = 1 AS acknowledged, demo = 1 AS is_demo, id
  FROM alerts ORDER BY ts DESC`];

// Postgres returns BIGINT / SUM / COUNT as strings — convert the columns we know are numbers.
const NUMERIC = new Set(['seq', 'max_conf', 'dent', 'tear', 'deform', 'wet', 'weight_g', 'brightness', 'latency_ms', 'ts', 'received_at',
  'ack', 'ack_ts', 'last_seen', 'updated_at', 'total', 'pass', 'reject', 'failsafe', 'no_barcode', 'avg_latency',
  'avg_weight', 'synced_late', 'n', 't', 'h', 'bin', 'demo']);
const fix = (rows) => rows.map((r) => {
  for (const k of Object.keys(r)) if (NUMERIC.has(k) && r[k] !== null && r[k] !== undefined) r[k] = Number(r[k]);
  return r;
});

// query(q, params) -> { rows, rowCount }
function pgAdapter(query, kind = 'postgres') {
  let ready = null;
  const init = () => (ready ||= (async () => {
    for (const s of SCHEMA) await query(s, []);
    for (const m of MIGRATIONS) await query(m.replace('ADD COLUMN', 'ADD COLUMN IF NOT EXISTS'), []);
    for (const v of PG_VIEWS) await query(v, []);
  })().catch((e) => { ready = null; throw e; }));
  return {
    kind,
    async all(q, p = []) { await init(); return fix((await query(q, p)).rows); },
    async get(q, p = []) { return (await this.all(q, p))[0]; },
    async run(q, p = []) { await init(); return { changes: Number((await query(q, p)).rowCount) }; },
  };
}

function createDb() {
  if (global.__PG_QUERY__) return pgAdapter(global.__PG_QUERY__, 'postgres-test'); // used by test/postgres.test.js
  if (process.env.DATABASE_URL || process.env.POSTGRES_URL) {
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    return pgAdapter((q, p) => sql.query(q, p, { fullResults: true }));
  }

  const { DatabaseSync } = require('node:sqlite');
  // On Vercel without DATABASE_URL only /tmp is writable: works for a quick look, but data is lost on cold starts.
  const fallback = process.env.VERCEL ? '/tmp/parcel-cloud' : path.join(__dirname, '..', 'data', 'cloud');
  const dir = path.resolve(process.env.CLOUD_DATA_DIR || fallback);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'cloud.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  for (const s of SCHEMA) db.exec(s);
  for (const m of MIGRATIONS) { try { db.exec(m); } catch { /* column exists */ } }
  // $1 -> ?1 (SQLite numbered parameters)
  const prep = (q) => db.prepare(q.replace(/\$(\d+)/g, '?$1'));
  return {
    kind: process.env.VERCEL ? 'sqlite-temporary (connect Neon Postgres!)' : 'sqlite',
    async all(q, p = []) { return fix(prep(q).all(...p)); },
    async get(q, p = []) { return (await this.all(q, p))[0]; },
    async run(q, p = []) { return { changes: Number(prep(q).run(...p).changes) }; },
  };
}

module.exports = { createDb };
