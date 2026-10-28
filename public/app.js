/* Parcel Inspector dashboard — vanilla JS + Chart.js, live updates by polling /api/feed (works on Vercel). */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmtTime = (t) => new Date(t).toLocaleTimeString('th-TH', { hour12: false });
  const fmtDateTime = (t) => new Date(t).toLocaleString('th-TH', { hour12: false });
  const fmtNum = (n) => (n ?? 0).toLocaleString('th-TH');
  // Write actions send the Admin key (only needed when ADMIN_KEY is set on the server).
  const getAdminKey = () => { try { return localStorage.getItem('pi.adminKey') || ''; } catch { return ''; } };
  const api = async (url, opt = {}, retried = false) => {
    const write = opt.method && opt.method !== 'GET';
    const headers = { ...(opt.headers || {}), ...(write && getAdminKey() ? { 'x-admin-key': getAdminKey() } : {}) };
    const r = await fetch(url, { ...opt, headers });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && write && !retried) {
      const k = prompt('ใส่ Admin key เพื่อแก้ไขข้อมูล');
      if (k) { try { localStorage.setItem('pi.adminKey', k); } catch { /* ignore */ } return api(url, opt, true); }
    }
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };

  const C = {
    good: css('--good'), critical: css('--critical'), warning: css('--warning'),
    dent: css('--dent'), tear: css('--tear'), deform: css('--deform'), wet: css('--wet'), accent: css('--accent'),
    surface: css('--surface-1'), line: css('--line'), text2: css('--text-secondary'), muted: css('--text-muted'),
  };
  const CLASS_TH = { dent: 'รอยบุบ', tear: 'ฉีกขาด', deform: 'ผิดรูป/ยับ', wet: 'เปียกน้ำ' };
  const classColor = (c) => C[c] || C.muted;
  const RESULT_LABEL = { PASS: '✓ PASS', REJECT: '✕ REJECT' };
  const ALERT_ICON = { critical: '⛔', warning: '⚠️', info: '✅' };
  const ALERT_TH = {
    VISION_FAULT: 'กล้องมีปัญหา (ภาพมืดเกินไป)', BELT_JAM: 'สายพานติดขัด', AI_TIMEOUT: 'AI ตอบไม่ทันเวลา (ใช้ Fail-safe)',
    CLOUD_OFFLINE: 'สถานีขาดการเชื่อมต่อ Cloud (ทำงานออฟไลน์)', ESP32_OFFLINE: 'ขาดการเชื่อมต่อ ESP32/PLC',
    PUSH_LATE: 'แขนปัดทำงานช้ากว่ากำหนด', CONTROLLER_FAILSAFE: 'ESP32 ใช้ Fail-safe เอง',
  };
  const alertTitle = (t) => ALERT_TH[t] || (t.endsWith('_CLEARED') ? `กลับมาปกติ: ${ALERT_TH[t.replace('_CLEARED', '')] || t}` : t);

  // ---------- Chart.js defaults (dark, thin marks, recessive grid) ----------
  Chart.defaults.color = C.text2;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.borderColor = 'rgba(34,52,79,.6)';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.tooltip.backgroundColor = '#0b1526';
  Chart.defaults.plugins.tooltip.borderColor = C.line;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation = false; // factory screen: no motion, numbers update in place
  const charts = {};
  function chart(id, config) {
    if (charts[id]) { charts[id].data = config.data; charts[id].options = config.options || charts[id].options; charts[id].update('none'); return charts[id]; }
    charts[id] = new Chart(document.getElementById(id), config);
    return charts[id];
  }
  const barDs = (label, data, color, extra = {}) => ({
    label, data, backgroundColor: color, borderColor: C.surface, borderWidth: { top: 2, left: 0, right: 0, bottom: 0 },
    borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, ...extra,
  });
  const lineDs = (label, data, color) => ({
    label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.25, spanGaps: true,
  });
  const gridOpts = { grid: { color: 'rgba(34,52,79,.45)' }, border: { display: false } };

  // ---------- state ----------
  const st = { tab: 'overview', range: 86400000, page: 0, pageSize: 25, edges: {}, feed: [], openAlerts: 0, lastSummary: null };
  const TZ = -new Date().getTimezoneOffset() * 60000; // so hour/day buckets follow local time
  const rangeQs = () => `from=${Date.now() - st.range}&to=${Date.now() + 60000}&tz=${TZ}`;

  // ---------- tabs ----------
  function showTab(t) {
    st.tab = t;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${t}`));
    try { localStorage.setItem('pi.tab', t); } catch { /* ignore */ }
    refreshTab();
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (!g) return;
    if (g.dataset.filter) $('#fResult').value = g.dataset.filter;
    st.page = 0; showTab(g.dataset.goto);
  });
  $('#range').addEventListener('change', (e) => { st.range = Number(e.target.value); refreshTab(); });

  function refreshTab() {
    if (st.tab === 'overview') loadOverview();
    if (st.tab === 'live') loadLive();
    if (st.tab === 'evidence') loadEvidence();
    if (st.tab === 'alerts') loadAlerts();
    if (st.tab === 'analytics') loadAnalytics();
    if (st.tab === 'settings') loadSettings();
  }

  // ---------- shared fetchers ----------
  function fillBuckets(rows, bucket) {
    const end = Math.floor(Date.now() / bucket) * bucket;
    const start = Math.floor((Date.now() - st.range) / bucket) * bucket + bucket;
    const map = new Map(rows.map((r) => [r.t, r]));
    const out = [];
    for (let t = start; t <= end; t += bucket) out.push(map.get(t) || { t, pass: 0, reject: 0, dent: 0, tear: 0 });
    return out;
  }
  const bucketLabel = (t, bucket) => {
    const d = new Date(t);
    if (bucket >= 86400000) return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
    return d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  async function loadSummary() {
    const s = await api(`/api/summary?${rangeQs()}`);
    st.lastSummary = s;
    $('#k-total').textContent = fmtNum(s.total);
    $('#k-latency').textContent = s.total ? `เวลาตัดสินเฉลี่ย ${fmtNum(s.avg_latency)} ms` : 'ยังไม่มีข้อมูล';
    $('#k-pass').textContent = fmtNum(s.pass);
    $('#k-passrate').textContent = s.total ? `${(100 - s.reject_rate).toFixed(1)}% ของทั้งหมด` : '–';
    $('#k-reject').textContent = fmtNum(s.reject);
    $('#k-rate').textContent = `อัตราของเสีย ${s.reject_rate}% · Dent ${s.dent} · Tear ${s.tear}`;
    $('#k-alerts').textContent = fmtNum(s.open_alerts);
    $('#k-failsafe').textContent = `Fail-safe ${s.failsafe} · ไม่มีบาร์โค้ด ${s.no_barcode} · sync ย้อนหลัง ${s.synced_late}`;
    setAlertBadge(s.open_alerts);
    return s;
  }

  async function loadOverview() {
    loadSummary();
    loadEdges();
    const { bucket, rows } = await api(`/api/timeseries?${rangeQs()}`);
    const data = fillBuckets(rows, bucket);
    const labels = data.map((r) => bucketLabel(r.t, bucket));
    $('#bucketLabel').textContent = `ต่อ ${bucket >= 86400000 ? 'วัน' : bucket >= 3600000 ? 'ชั่วโมง' : 'นาที'}`;
    chart('chVolume', {
      type: 'bar',
      data: { labels, datasets: [barDs('✓ PASS', data.map((r) => r.pass), C.good), barDs('✕ REJECT', data.map((r) => r.reject), C.critical)] },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0 } }, y: { stacked: true, beginAtZero: true, ...gridOpts, ticks: { precision: 0 } } } },
    });
    chart('chRate', {
      type: 'line',
      data: { labels, datasets: [lineDs('อัตราของเสีย %', data.map((r) => (r.pass + r.reject ? +((r.reject / (r.pass + r.reject)) * 100).toFixed(1) : null)), C.critical)] },
      options: { plugins: { legend: { display: false } }, interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0 } }, y: { beginAtZero: true, suggestedMax: 20, ...gridOpts, ticks: { callback: (v) => v + '%' } } } },
    });
    const rj = await api(`/api/inspections?result=REJECT&limit=8&${rangeQs()}`);
    renderThumbs(rj.rows);
  }

  function renderThumbs(rows) {
    const el = $('#recentRejects');
    if (!rows.length) { el.innerHTML = '<div class="empty">ยังไม่มีพัสดุชำรุดในช่วงนี้ 🎉</div>'; return; }
    el.innerHTML = rows.map((r) => `
      <div class="thumb" data-id="${esc(r.id)}">
        ${r.img_top ? `<img loading="lazy" src="/api/images/${esc(r.img_top)}" alt="">` : '<div class="noimg">ไม่มีภาพ</div>'}
        <div class="cap">${esc(r.reason)} · ${esc(r.tracking || 'no barcode')}<br>${fmtTime(r.ts)}</div>
      </div>`).join('');
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-id]');
    if (t) openDetail(t.dataset.id);
  });

  // ---------- edges ----------
  async function loadEdges() {
    const list = await api('/api/edges');
    list.forEach((e) => { st.edges[e.edge_id] = e; });
    renderEdges();
  }
  function renderEdges() {
    const edges = Object.values(st.edges);
    const el = $('#edgeList');
    if (!edges.length) { el.innerHTML = '<div class="empty">ยังไม่มีสถานีเชื่อมต่อ</div>'; return; }
    const dot = (ok, warn) => `<span class="dot ${ok ? 'ok' : warn ? 'warn' : 'bad'}"></span>`;
    el.innerHTML = edges.map((e) => {
      const online = e.online && Date.now() - e.last_seen < 15000;
      const ciraOk = e.cira_last_seen && Date.now() - e.cira_last_seen < 60000;
      return `<div class="edge">
        <div class="edge-top"><span class="edge-name">${esc(e.edge_id)}</span>
          <span class="state ${online ? 'on' : 'off'}">${online ? '● ONLINE' : '○ OFFLINE'}</span></div>
        <div class="dots">
          <span>${dot(online && e.esp32)}ESP32 / PLC</span>
          <span>${dot(online && ciraOk, online)}CiRA CORE</span>
          <span>${dot(online)}Cloud link</span>
          <span>${dot(!e.pending_sync, true)}รอ sync: ${fmtNum(e.pending_sync || 0)}</span>
        </div>
        ${online && e.faults?.length ? `<div class="faults">${e.faults.map((f) => `<span class="tag fs">⚠ ${esc(f)}</span>`).join('')}</div>` : ''}
        ${!online ? `<div class="muted small" style="margin-top:6px">เห็นล่าสุด ${e.last_seen ? fmtDateTime(e.last_seen) : '–'} — สถานียังคัดแยกต่อได้ ข้อมูลจะ sync เมื่อกลับมาออนไลน์</div>` : ''}
      </div>`;
    }).join('');
    renderLiveEdge();
  }

  // ---------- live ----------
  async function loadGate() {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const s = await api(`/api/summary?from=${d0.getTime()}&tz=${TZ}`);
    $('#gatePass').textContent = fmtNum(s.pass);
    $('#gateReject').textContent = fmtNum(s.reject);
  }
  async function loadLive() {
    loadGate();
    loadEdges();
    if (!st.feed.length) {
      const r = await api('/api/inspections?limit=30');
      st.feed = r.rows;
    }
    renderFeed();
    if (st.feed[0]) renderLiveCard(st.feed[0]);
  }
  function feedRow(r) {
    const delay = r.received_at - r.ts;
    return `<tr data-id="${esc(r.id)}" class="${r._new ? 'flash' : ''}">
      <td class="mono">${fmtTime(r.ts)}</td><td class="mono">${esc(r.tracking || '—')}</td>
      <td><span class="pill ${esc(r.result)}">${RESULT_LABEL[r.result] || esc(r.result)}</span></td>
      <td>${reasonTags(r)}</td><td>${r.max_conf != null ? (r.max_conf * 100).toFixed(0) + '%' : '–'}</td>
      <td>${r.weight_g != null ? fmtNum(Math.round(r.weight_g)) + ' g' : '–'}</td><td class="mono">${esc(r.edge_id)}</td>
      <td class="small ${delay > 10000 ? '' : 'muted'}">${delay > 10000 ? `⟳ ย้อนหลัง ${Math.round(delay / 1000)}s` : 'real-time'}</td></tr>`;
  }
  function reasonTags(r) {
    if (r.result === 'PASS' && r.reason === 'OK') return '<span class="muted">–</span>';
    return String(r.reason || '').split('+').map((x) => {
      const cls = ['DENT', 'TEAR', 'DEFORM', 'WET'].includes(x) ? x.toLowerCase() : 'fs';
      return `<span class="tag ${cls}">${esc(x)}</span>`;
    }).join(' ');
  }
  function renderFeed() {
    $('#feed').innerHTML = st.feed.slice(0, 40).map(feedRow).join('') || '<tr><td colspan="8" class="empty">ยังไม่มีข้อมูล</td></tr>';
    st.feed.forEach((r) => delete r._new);
  }
  function renderLiveCard(r) {
    $('#liveTime').textContent = fmtDateTime(r.ts);
    $('#liveCard').innerHTML = `
      <div>${evidenceImages(r)}</div>
      <div>
        <div class="big-result ${esc(r.result)}">${RESULT_LABEL[r.result] || esc(r.result)}</div>
        <div style="margin-top:6px">${reasonTags(r)}</div>
        <dl class="kv">
          <dt>Tracking</dt><dd class="mono">${esc(r.tracking || 'ไม่มีบาร์โค้ด')}</dd>
          <dt>สถานี</dt><dd class="mono">${esc(r.edge_id)}</dd>
          <dt>ตัดสินโดย</dt><dd>${r.decided_by === 'FAILSAFE' ? '<span class="tag fs">FAIL-SAFE</span>' : 'อัตโนมัติ (AI + Vision)'}</dd>
          <dt>น้ำหนัก</dt><dd>${r.weight_g != null ? fmtNum(r.weight_g) + ' g' : '–'}</dd>
          <dt>ความสว่างภาพ</dt><dd>${r.brightness ?? '–'}</dd>
          <dt>เวลาตัดสิน</dt><dd>${r.latency_ms ?? '–'} ms</dd>
        </dl>
        ${detList(r.detections)}
      </div>`;
    drawOverlays($('#liveCard'), r.detections);
  }
  function lampFlash(result) {
    const lamp = result === 'REJECT' ? $('#lampRed') : $('#lampGreen');
    lamp.classList.add('on');
    clearTimeout(lamp._t);
    lamp._t = setTimeout(() => lamp.classList.remove('on'), 1500);
  }
  function renderLiveEdge() {
    const e = Object.values(st.edges)[0];
    if (!e) return;
    const online = e.online && Date.now() - e.last_seen < 15000;
    const yellow = !online || e.light === 'yellow' || (e.faults || []).length > 0;
    $('#lampYellow').classList.toggle('on', yellow);
    $('#towerText').textContent = !online ? 'สถานีออฟไลน์จาก Cloud (ไฟเหลืองที่หน้างาน)' : yellow ? `ไฟเหลือง: ${(e.faults || []).join(', ') || 'ระบบขัดข้อง'}` : 'ระบบปกติ · เขียว=ผ่าน แดง=ปัดออก';
    $('#liveEdge').innerHTML = `<dl class="kv"><dt>สถานี</dt><dd class="mono">${esc(e.edge_id)}</dd>
      <dt>Transport</dt><dd>${esc(e.esp32_transport || '–')}</dd>
      <dt>ดีเลย์ปัด</dt><dd>${e.config?.reject_delay_ms ?? '–'} ms</dd>
      <dt>Threshold</dt><dd>Dent ${e.config?.conf_dent ?? '–'} · Tear ${e.config?.conf_tear ?? '–'}</dd>
      <dt>รอ sync</dt><dd>${fmtNum(e.pending_sync || 0)} รายการ</dd></dl>`;
  }

  // ---------- evidence images + bounding boxes ----------
  function evidenceImages(r) {
    const cams = [['top', r.img_top], ['side', r.img_side]].filter(([, f]) => f);
    if (!cams.length) return '<div class="imgwrap"><div class="noimg">ไม่มีภาพ (Fail-safe / กล้องไม่ส่งภาพ)</div></div>';
    return `<div class="evidence-imgs ${cams.length > 1 ? 'two' : ''}">${cams.map(([cam, f]) => `
      <div class="imgwrap" data-cam="${cam}"><img src="/api/images/${esc(f)}" alt="${cam} camera"><canvas></canvas><span class="cam">${cam === 'top' ? 'กล้องบน' : 'กล้องข้าง'}</span></div>`).join('')}</div>`;
  }
  function drawOverlays(root, detections) {
    $$('.imgwrap[data-cam]', root).forEach((w) => {
      const img = $('img', w), cv = $('canvas', w);
      const draw = () => {
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const g = cv.getContext('2d');
        const lw = Math.max(2, cv.width / 260);
        (detections || []).filter((d) => d.box && (d.cam || 'top') === w.dataset.cam).forEach((d) => {
          const [x, y, bw, bh] = [d.box[0] * cv.width, d.box[1] * cv.height, d.box[2] * cv.width, d.box[3] * cv.height];
          const color = classColor(d.cls);
          g.strokeStyle = color; g.lineWidth = lw; g.setLineDash(d.counted === false ? [6, 4] : []);
          g.strokeRect(x, y, bw, bh);
          const label = `${d.cls} ${(d.conf * 100).toFixed(0)}%`;
          g.font = `600 ${Math.max(12, cv.width / 45)}px sans-serif`;
          const tw = g.measureText(label).width + 10, th = Math.max(16, cv.width / 34);
          g.fillStyle = color; g.fillRect(x, Math.max(0, y - th), tw, th);
          g.fillStyle = '#fff'; g.fillText(label, x + 5, Math.max(0, y - th) + th * 0.75);
        });
      };
      if (img.complete && img.naturalWidth) draw(); else img.addEventListener('load', draw, { once: true });
    });
  }
  function detList(dets) {
    if (!dets || !dets.length) return '<div class="muted small" style="margin-top:10px">AI ไม่พบความเสียหาย</div>';
    return `<div class="det-list">${dets.map((d) => {
      const color = classColor(d.cls);
      return `<div class="small"><span class="tag ${esc(d.cls)}">${esc(d.cls)}</span> ${(d.conf * 100).toFixed(1)}% <span class="muted">(${d.cam === 'side' ? 'กล้องข้าง' : 'กล้องบน'} · ${d.src === 'cv' ? 'ตรวจสี/รูปทรง' : 'AI'})</span>
        <div class="bar-conf"><i style="width:${Math.round(d.conf * 100)}%;background:${color}"></i></div></div>`;
    }).join('')}</div>`;
  }

  async function openDetail(id) {
    const r = await api(`/api/inspections/${encodeURIComponent(id)}`);
    const cfg = st.edges[r.edge_id]?.config;
    const thr = cfg ? { dent: cfg.conf_dent, tear: cfg.conf_tear } : {};
    r.detections.forEach((d) => { if (thr[d.cls] != null) d.counted = d.conf >= thr[d.cls]; });
    $('#modalBody').innerHTML = `
      <div class="card-h"><h3>หลักฐานพัสดุ · <span class="mono">${esc(r.tracking || 'ไม่มีบาร์โค้ด')}</span></h3></div>
      <div class="live-card">
        <div>${evidenceImages(r)}</div>
        <div>
          <div class="big-result ${esc(r.result)}">${RESULT_LABEL[r.result] || esc(r.result)}</div>
          <div style="margin-top:6px">${reasonTags(r)}</div>
          <dl class="kv">
            <dt>เวลาตรวจ</dt><dd>${fmtDateTime(r.ts)}</dd>
            <dt>ขึ้น Cloud</dt><dd>${fmtDateTime(r.received_at)} ${r.received_at - r.ts > 10000 ? '<span class="tag fs">sync ย้อนหลัง</span>' : ''}</dd>
            <dt>สถานี</dt><dd class="mono">${esc(r.edge_id)} · seq ${esc(r.seq ?? '–')}</dd>
            <dt>ตัดสินโดย</dt><dd>${r.decided_by === 'FAILSAFE' ? '<span class="tag fs">FAIL-SAFE</span>' : 'อัตโนมัติ (AI + Vision)'}</dd>
            <dt>น้ำหนัก</dt><dd>${r.weight_g != null ? fmtNum(r.weight_g) + ' g' : '–'}</dd>
            <dt>ความสว่างภาพ</dt><dd>${r.brightness ?? '–'}</dd>
            <dt>เวลาตัดสิน</dt><dd>${r.latency_ms ?? '–'} ms</dd>
            <dt>Record ID</dt><dd class="mono small">${esc(r.id)}</dd>
          </dl>
          ${detList(r.detections)}
        </div>
      </div>
      ${r.history.length > 1 ? `<div class="history"><h3 style="font-size:14px">ประวัติการผ่านจุดตรวจของพัสดุนี้</h3>
        <table class="tbl"><tbody>${r.history.map((h) => `<tr><td>${fmtDateTime(h.ts)}</td><td class="mono">${esc(h.edge_id)}</td><td><span class="pill ${esc(h.result)}">${RESULT_LABEL[h.result]}</span></td><td>${esc(h.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    $('#modal').classList.remove('hidden');
    drawOverlays($('#modalBody'), r.detections);
  }
  $('#modalClose').addEventListener('click', () => $('#modal').classList.add('hidden'));
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });

  // ---------- evidence search ----------
  function evQuery() {
    const p = new URLSearchParams();
    const q = $('#q').value.trim();
    if (q) p.set('q', q);
    if ($('#fResult').value) p.set('result', $('#fResult').value);
    if ($('#fReason').value) p.set('reason', $('#fReason').value);
    if (!q) { p.set('from', Date.now() - st.range); p.set('to', Date.now() + 60000); } // tracking search ignores range
    return p;
  }
  async function loadEvidence() {
    const p = evQuery();
    $('#btnCsv').href = `/api/export.csv?${p}`;
    p.set('limit', st.pageSize); p.set('offset', st.page * st.pageSize);
    const r = await api(`/api/inspections?${p}`);
    $('#evCount').textContent = `พบ ${fmtNum(r.total)} รายการ${$('#q').value.trim() ? ' (ค้นหาทุกช่วงเวลา)' : ''}`;
    $('#evRows').innerHTML = r.rows.map((x) => `<tr data-id="${esc(x.id)}">
      <td class="mono">${fmtDateTime(x.ts)}</td><td class="mono">${esc(x.tracking || '—')}</td>
      <td><span class="pill ${esc(x.result)}">${RESULT_LABEL[x.result]}</span></td><td>${reasonTags(x)}</td>
      <td>${x.decided_by === 'FAILSAFE' ? '<span class="tag fs">FAIL-SAFE</span>' : 'AI'}</td>
      <td>${x.max_conf != null ? (x.max_conf * 100).toFixed(0) + '%' : '–'}</td>
      <td>${x.weight_g != null ? fmtNum(Math.round(x.weight_g)) + ' g' : '–'}</td><td class="mono">${esc(x.edge_id)}</td></tr>`).join('')
      || '<tr><td colspan="8" class="empty">ไม่พบข้อมูล</td></tr>';
    const pages = Math.max(1, Math.ceil(r.total / st.pageSize));
    $('#pageInfo').textContent = `หน้า ${st.page + 1} / ${pages}`;
    $('#prev').disabled = st.page === 0;
    $('#next').disabled = st.page + 1 >= pages;
  }
  $('#btnSearch').addEventListener('click', () => { st.page = 0; loadEvidence(); });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { st.page = 0; loadEvidence(); } });
  $('#fResult').addEventListener('change', () => { st.page = 0; loadEvidence(); });
  $('#fReason').addEventListener('change', () => { st.page = 0; loadEvidence(); });
  $('#prev').addEventListener('click', () => { st.page--; loadEvidence(); });
  $('#next').addEventListener('click', () => { st.page++; loadEvidence(); });

  // ---------- alerts ----------
  function setAlertBadge(n) {
    st.openAlerts = n;
    $('#alertBadge').textContent = n;
    $('#alertBadge').classList.toggle('hidden', !n);
  }
  async function loadAlerts() {
    const rows = await api(`/api/alerts?limit=200${$('#openOnly').checked ? '&open=1' : ''}`);
    $('#alertList').innerHTML = rows.map((a) => `
      <div class="alert ${esc(a.severity)} ${a.ack || a.severity === 'info' ? 'acked' : ''}">
        <div class="ico">${ALERT_ICON[a.severity] || 'ℹ️'}</div>
        <div><div class="t">${esc(alertTitle(a.type))} <span class="muted small">· ${esc(a.edge_id)} · ${fmtDateTime(a.ts)}</span></div>
          <div class="m">${esc(a.message)}</div></div>
        <div>${!a.ack && a.severity !== 'info' ? `<button class="btn ghost" data-ack="${esc(a.id)}">รับทราบ</button>` : '<span class="muted small">✓</span>'}</div>
      </div>`).join('') || '<div class="empty">ไม่มีแจ้งเตือน</div>';
  }
  $('#alertList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ack]');
    if (!b) return;
    await api(`/api/alerts/${encodeURIComponent(b.dataset.ack)}/ack`, { method: 'POST' });
    loadAlerts(); loadSummary();
  });
  $('#ackAll').addEventListener('click', async () => { await api('/api/alerts/ack-all', { method: 'POST' }); loadAlerts(); loadSummary(); });
  $('#openOnly').addEventListener('change', loadAlerts);

  // ---------- analytics ----------
  async function loadAnalytics() {
    const s = await loadSummary();
    $('#a-dent').textContent = fmtNum(s.dent);
    $('#a-tear').textContent = fmtNum(s.tear);
    $('#a-deform').textContent = fmtNum(s.deform);
    $('#a-wet').textContent = fmtNum(s.wet);
    const [{ bucket, rows }, b] = await Promise.all([api(`/api/timeseries?${rangeQs()}`), api(`/api/breakdown?${rangeQs()}`)]);
    const data = fillBuckets(rows, bucket);
    chart('chDefects', {
      type: 'bar',
      data: { labels: data.map((r) => bucketLabel(r.t, bucket)), datasets: ['dent', 'tear', 'deform', 'wet'].map((c) => barDs(`${c[0].toUpperCase() + c.slice(1)} (${CLASS_TH[c]})`, data.map((r) => r[c] || 0), C[c])) },
      options: { interaction: { mode: 'index', intersect: false }, scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0 } }, y: { stacked: true, beginAtZero: true, ...gridOpts, ticks: { precision: 0 } } } },
    });
    const reasonColor = (r) => (r.includes('+') ? C.critical : C[r.toLowerCase()] || C.warning); // single class / combined / fail-safe
    chart('chReasons', {
      type: 'bar',
      data: { labels: b.reasons.map((r) => r.reason), datasets: [barDs('จำนวน', b.reasons.map((r) => r.n), b.reasons.map((r) => reasonColor(r.reason)), { borderSkipped: 'start', borderWidth: 0 })] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ...gridOpts, ticks: { precision: 0 } }, y: { grid: { display: false } } } },
    });
    const hours = Array.from({ length: 24 }, (_, h) => b.by_hour.find((x) => x.h === h) || { h, total: 0, reject: 0 });
    chart('chHour', {
      type: 'bar',
      data: { labels: hours.map((x) => String(x.h).padStart(2, '0') + ':00'), datasets: [barDs('อัตราของเสีย %', hours.map((x) => (x.total ? +((x.reject / x.total) * 100).toFixed(1) : 0)), C.critical, { borderWidth: 0 })] },
      options: { plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (c) => `จาก ${hours[c.dataIndex].total} กล่อง` } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ...gridOpts, ticks: { callback: (v) => v + '%' } } } },
    });
    const bins = Array.from({ length: 11 }, (_, i) => +(i / 10).toFixed(1));
    chart('chConf', {
      type: 'bar',
      data: { labels: bins.map((x) => x.toFixed(1)), datasets: [barDs('จำนวนกล่อง', bins.map((x) => b.conf.find((c) => Math.abs(c.bin - x) < 0.01)?.n || 0), C.accent, { borderWidth: 0 })] },
      options: { plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => `ความมั่นใจสูงสุด ≈ ${c[0].label}` } } }, scales: { x: { title: { display: true, text: 'ค่าความมั่นใจ (confidence)' }, grid: { display: false } }, y: { beginAtZero: true, ...gridOpts, ticks: { precision: 0 } } } },
    });
    $('#edgeTable').innerHTML = b.by_edge.map((e) => `<tr><td class="mono">${esc(e.edge_id)}</td><td>${fmtNum(e.total)}</td><td>${fmtNum(e.reject)}</td>
      <td>${e.total ? ((e.reject / e.total) * 100).toFixed(1) : 0}%</td><td>${fmtNum(e.avg_latency)} ms</td></tr>`).join('') || '<tr><td colspan="5" class="empty">ไม่มีข้อมูล</td></tr>';
  }

  // ---------- settings ----------
  const CFG_META = [
    ['reject_delay_ms', 'ดีเลย์ปัดออก (ms)', 'เวลาจาก IR ตรวจจับ → แขนปัดทำงาน ปรับตามความเร็วสายพาน', 100, 6000, 50],
    ['servo_hold_ms', 'เวลาค้างแขนปัด (ms)', 'แขน Servo ยื่นออกนานเท่าไร', 100, 2000, 50],
    ['conf_dent', 'Threshold รอยบุบ (Dent)', 'AI ต้องมั่นใจอย่างน้อยเท่านี้ถึงจะนับเป็นรอยบุบ', 0.05, 0.99, 0.01],
    ['conf_tear', 'Threshold รอยฉีก (Tear)', 'เพิ่มค่านี้ถ้าเจอลายกราฟิกถูกนับเป็นรอยฉีก (False positive)', 0.05, 0.99, 0.01],
    ['conf_deform', 'Threshold ผิดรูป/ยับเยิน (Deform)', 'ยิ่งต่ำยิ่งไว: กล่องบุบเบี้ยวเล็กน้อยก็ถูกคัดออก', 0.05, 0.99, 0.01],
    ['conf_wet', 'Threshold เปียกน้ำ (Wet)', 'ยิ่งต่ำยิ่งไว: คราบน้ำเล็ก ๆ ก็ถูกคัดออก', 0.05, 0.99, 0.01],
    ['min_box_area', 'ขนาดกรอบขั้นต่ำ (สัดส่วนภาพ)', 'ตัดกรอบที่เล็กเกินไป (noise)', 0, 0.05, 0.001],
    ['brightness_min', 'ความสว่างขั้นต่ำ (0-255)', 'ต่ำกว่านี้ = กล้องโดนบัง/เลนส์มัว/ไฟดับ → VISION FAULT', 0, 150, 1],
    ['jam_timeout_ms', 'Belt jam timeout (ms)', 'IR ถูกบังค้างนานเกินนี้ = สายพานติด → หยุดสายพาน', 500, 20000, 100],
    ['ai_timeout_ms', 'AI timeout (ms)', 'ไม่ได้ผลจาก CiRA CORE ภายในเวลานี้ → ใช้ Fail-safe (ต้องน้อยกว่าดีเลย์ปัด)', 100, 5000, 50],
    ['scan_window_ms', 'หน้าต่างจับคู่บาร์โค้ด (ms)', 'บาร์โค้ดที่สแกนก่อนกล่องถึง IR ไม่เกินเวลานี้จะถูกจับคู่', 1000, 60000, 500],
  ];
  let cfgDefaults = {};
  async function loadSettings() {
    await loadEdges();
    const sel = $('#cfgEdge');
    const ids = Object.keys(st.edges);
    if (!ids.length) ids.push('hub-01');
    const cur = sel.value || ids[0];
    sel.innerHTML = ids.map((i) => `<option ${i === cur ? 'selected' : ''}>${esc(i)}</option>`).join('');
    const r = await api(`/api/config/${encodeURIComponent(sel.value)}`);
    cfgDefaults = r.defaults;
    renderCfg(r.config);
    $('#cfgMsg').textContent = r.updated_at ? `แก้ไขล่าสุด ${fmtDateTime(r.updated_at)}` : 'ค่าเริ่มต้น';
  }
  function renderCfg(c) {
    $('#cfgForm').innerHTML = CFG_META.map(([k, label, desc, min, max, step]) => `
      <label>${esc(label)}<span class="d">${esc(desc)}</span>
        <span class="range-row"><input type="range" min="${min}" max="${max}" step="${step}" value="${c[k]}" data-sync="${k}">
        <input type="number" name="${k}" min="${min}" max="${max}" step="${step}" value="${c[k]}"></span></label>`).join('') + `
      <label>ตรวจสี/รูปทรงที่ Gateway (Wet + Deform)<span class="d">เปิดไว้เมื่อโมเดล CiRA ยังไม่ได้เทรนคลาสเปียก/ผิดรูป</span>
        <select name="cv_check"><option value="1" ${Number(c.cv_check) ? 'selected' : ''}>เปิด</option><option value="0" ${Number(c.cv_check) ? '' : 'selected'}>ปิด</option></select></label>
      <label>Fail-safe เมื่อ AI/กล้องขัดข้อง<span class="d">REJECT = ปลอดภัยกว่า (กล่องถูกคัดไปตรวจมือ)</span>
        <select name="failsafe_action"><option ${c.failsafe_action === 'REJECT' ? 'selected' : ''}>REJECT</option><option ${c.failsafe_action === 'PASS' ? 'selected' : ''}>PASS</option></select></label>`;
  }
  $('#cfgForm').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.sync) $(`input[name="${t.dataset.sync}"]`).value = t.value;
    else if (t.type === 'number') { const r = $(`input[data-sync="${t.name}"]`); if (r) r.value = t.value; }
  });
  $('#cfgEdge').addEventListener('change', loadSettings);
  $('#cfgReset').addEventListener('click', () => renderCfg(cfgDefaults));
  $('#cfgSave').addEventListener('click', async () => {
    const body = {};
    $$('#cfgForm [name]').forEach((i) => { body[i.name] = i.type === 'number' ? Number(i.value) : i.value; });
    try {
      const r = await api(`/api/config/${encodeURIComponent($('#cfgEdge').value)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      $('#cfgMsg').textContent = `✓ บันทึกแล้ว ${fmtTime(r.updated_at)} — ส่งไปยังสถานีแล้ว`;
      toast({ severity: 'info', type: 'CONFIG', message: 'ส่งพารามิเตอร์ใหม่ไปยังสถานีแล้ว' });
    } catch (err) {
      $('#cfgMsg').textContent = '✕ ' + err.message;
    }
  });

  // ---------- toast ----------
  function toast(a) {
    const el = document.createElement('div');
    el.className = `toast ${a.severity}`;
    el.innerHTML = `<b>${ALERT_ICON[a.severity] || ''} ${esc(alertTitle(a.type))}</b><div class="muted">${esc(a.message)}</div>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  // ---------- live stream ----------
  let refreshTimer = null;
  const softRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (st.tab === 'overview' || st.tab === 'analytics') refreshTab(); else loadSummary();
      if (st.tab === 'live') loadGate();
    }, 800);
  };
  // Poll /api/feed (serverless-friendly). Overlap the window a little and de-duplicate by id.
  const seen = new Set();
  let since = Date.now();
  async function poll() {
    try {
      const f = await api(`/api/feed?since=${since - 3000}`);
      since = f.now;
      $('#conn').textContent = '● LIVE'; $('#conn').classList.remove('off');
      const fresh = f.inspections.filter((r) => !seen.has(r.id)).reverse(); // oldest first
      fresh.forEach((r) => {
        seen.add(r.id);
        if (st.feed.some((x) => x.id === r.id)) return;
        r._new = true;
        st.feed.unshift(r);
      });
      st.feed = st.feed.slice(0, 60);
      if (fresh.length) {
        const last = fresh[fresh.length - 1];
        if (st.tab === 'live') { renderFeed(); renderLiveCard(st.feed[0]); }
        if (last.received_at - last.ts < 10000) lampFlash(last.result);
      }
      const newAlerts = f.alerts.filter((a) => !seen.has(a.id));
      newAlerts.forEach((a) => { seen.add(a.id); toast(a); });
      if (newAlerts.length && st.tab === 'alerts') loadAlerts();
      f.edges.forEach((e) => { st.edges[e.edge_id] = e; });
      renderEdges();
      if (fresh.length || newAlerts.length) softRefresh();
    } catch {
      $('#conn').textContent = '○ reconnecting'; $('#conn').classList.add('off');
    }
    setTimeout(poll, document.hidden ? 15000 : 3000);
  }
  function connect() {
    // mark what's already there as seen so the first poll doesn't toast old alerts
    api('/api/feed?since=' + (Date.now() - 60000)).then((f) => {
      f.inspections.forEach((r) => seen.add(r.id));
      f.alerts.forEach((a) => seen.add(a.id));
    }).catch(() => {}).finally(() => setTimeout(poll, 1000));
  }
  setInterval(renderEdges, 5000); // age out "online" when an edge goes silent

  // ---------- boot ----------
  let startTab = 'overview';
  try { startTab = localStorage.getItem('pi.tab') || 'overview'; } catch { /* ignore */ }
  if (!$(`#tab-${startTab}`)) startTab = 'overview';
  showTab(startTab);
  connect();
})();
