// Local SQLite at the station = the "store" half of Store-and-Forward.
// Every record is written here first (synced = 0) and forwarded to the cloud later.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openEdgeDb(dir) {
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'edge.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS inspections (
      id TEXT PRIMARY KEY, seq INTEGER, tracking TEXT, result TEXT, reason TEXT,
      decided_by TEXT, detections TEXT, max_conf REAL, weight_g REAL, brightness REAL,
      img_top TEXT, img_side TEXT, latency_ms INTEGER, ts INTEGER, synced INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY, type TEXT, severity TEXT, message TEXT, ts INTEGER, synced INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE INDEX IF NOT EXISTS idx_insp_synced ON inspections(synced);
    CREATE INDEX IF NOT EXISTS idx_alert_synced ON alerts(synced);
  `);

  const q = {
    insertInsp: db.prepare(`INSERT INTO inspections
      (id, seq, tracking, result, reason, decided_by, detections, max_conf, weight_g, brightness, img_top, img_side, latency_ms, ts)
      VALUES (:id, :seq, :tracking, :result, :reason, :decided_by, :detections, :max_conf, :weight_g, :brightness, :img_top, :img_side, :latency_ms, :ts)`),
    insertAlert: db.prepare('INSERT INTO alerts (id, type, severity, message, ts) VALUES (:id, :type, :severity, :message, :ts)'),
    pendingInsp: db.prepare('SELECT * FROM inspections WHERE synced = 0 ORDER BY ts LIMIT ?'),
    pendingAlerts: db.prepare('SELECT * FROM alerts WHERE synced = 0 ORDER BY ts LIMIT ?'),
    markInsp: db.prepare('UPDATE inspections SET synced = 1 WHERE id = ?'),
    markAlert: db.prepare('UPDATE alerts SET synced = 1 WHERE id = ?'),
    countPending: db.prepare('SELECT (SELECT COUNT(*) FROM inspections WHERE synced = 0) + (SELECT COUNT(*) FROM alerts WHERE synced = 0) AS n'),
    recent: db.prepare('SELECT id, seq, tracking, result, reason, decided_by, max_conf, weight_g, brightness, ts, synced FROM inspections ORDER BY ts DESC LIMIT ?'),
    getKv: db.prepare('SELECT v FROM kv WHERE k = ?'),
    setKv: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
  };

  return {
    db,
    addInspection: (r) => q.insertInsp.run(r),
    addAlert: (a) => q.insertAlert.run(a),
    pendingInspections: (n = 20) => q.pendingInsp.all(n),
    pendingAlerts: (n = 50) => q.pendingAlerts.all(n),
    markInspectionSynced: (id) => q.markInsp.run(id),
    markAlertSynced: (id) => q.markAlert.run(id),
    pendingCount: () => q.countPending.get().n,
    recent: (n = 30) => q.recent.all(n),
    getJson: (k) => { const r = q.getKv.get(k); return r ? JSON.parse(r.v) : null; },
    setJson: (k, v) => q.setKv.run(k, JSON.stringify(v)),
  };
}

module.exports = { openEdgeDb };
