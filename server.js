// ═══════════════════════════════════════════════════════
// المودة للبرمجيات — سيرفر التراخيص والتفعيل
// License Server v1.0
// تشغيل: npm install && node server.js
// ═══════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CORS ──────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── CONFIG ────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_KEY: process.env.ADMIN_KEY || 'mawada-admin-2024-secret',
  DB_FILE: process.env.DB_FILE || './licenses.json',
  SECRET: process.env.SECRET || 'mawada-license-secret-key-2024',
  HEARTBEAT_DAYS: 1, // كم يوم بين كل heartbeat
};

// ─── DATABASE (JSON File) ───────────────────────────────
function loadDB() {
  if (!fs.existsSync(CONFIG.DB_FILE)) {
    const initial = {
      licenses: {},
      logs: [],
      stats: { totalActivations: 0, activeNow: 0 }
    };
    fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(db, null, 2));
}

function log(db, action, data) {
  db.logs.unshift({
    id: Date.now(),
    time: new Date().toISOString(),
    action,
    ...data
  });
  if (db.logs.length > 500) db.logs = db.logs.slice(0, 500);
}

// ─── HELPERS ────────────────────────────────────────────
function generateLicenseCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `MWDA-${seg()}-${seg()}-${seg()}`;
}

function hashHWID(hwid) {
  return crypto.createHmac('sha256', CONFIG.SECRET).update(hwid).digest('hex').slice(0, 32);
}

function isAdminKey(req) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  return key === CONFIG.ADMIN_KEY;
}

function requireAdmin(req, res, next) {
  if (!isAdminKey(req)) return res.status(401).json({ error: 'غير مصرح' });
  next();
}

// ─── API: CLIENT ────────────────────────────────────────

// تفعيل ترخيص
app.post('/api/activate', (req, res) => {
  const { code, hwid, shopName, version } = req.body;
  if (!code || !hwid) return res.status(400).json({ error: 'كود التفعيل ومعرف الجهاز مطلوبان' });

  const db = loadDB();
  const license = db.licenses[code];

  if (!license) return res.json({ success: false, error: 'كود التفعيل غير صحيح' });
  if (license.status === 'revoked') return res.json({ success: false, error: 'تم إلغاء هذا الترخيص' });
  if (license.status === 'expired') return res.json({ success: false, error: 'انتهت صلاحية هذا الترخيص' });

  // Check expiry date
  if (license.expiryDate && new Date(license.expiryDate) < new Date()) {
    license.status = 'expired';
    saveDB(db);
    return res.json({ success: false, error: 'انتهت صلاحية الترخيص بتاريخ ' + license.expiryDate });
  }

  const hwHash = hashHWID(hwid);

  // Already activated on this device?
  if (license.hwHash && license.hwHash !== hwHash) {
    // Different device
    if (license.status === 'active') {
      log(db, 'محاولة تفعيل على جهاز مختلف', { code, hwid: hwid.slice(0, 20) });
      saveDB(db);
      return res.json({ success: false, error: 'هذا الترخيص مفعّل على جهاز آخر. تواصل مع المطور لنقل الترخيص.' });
    }
  }

  // Activate!
  license.status = 'active';
  license.hwHash = hwHash;
  license.hwid_preview = hwid.slice(0, 20) + '...';
  license.shopName = shopName || license.shopName || '';
  license.version = version || '4.0';
  license.activatedAt = license.activatedAt || new Date().toISOString();
  license.lastHeartbeat = new Date().toISOString();
  license.activationCount = (license.activationCount || 0) + 1;

  db.stats.totalActivations++;
  db.stats.activeNow = Object.values(db.licenses).filter(l => l.status === 'active').length;

  log(db, 'تفعيل ترخيص', { code, shop: license.shopName, hwid: hwid.slice(0, 20) });
  saveDB(db);

  res.json({
    success: true,
    message: 'تم التفعيل بنجاح',
    license: {
      code,
      plan: license.plan,
      shopName: license.shopName,
      expiryDate: license.expiryDate,
      features: license.features || []
    }
  });
});

// التحقق من الترخيص (heartbeat)
app.post('/api/verify', (req, res) => {
  const { code, hwid } = req.body;
  if (!code || !hwid) return res.status(400).json({ error: 'بيانات مطلوبة' });

  const db = loadDB();
  const license = db.licenses[code];

  if (!license) return res.json({ valid: false, error: 'ترخيص غير موجود' });
  if (license.status === 'revoked') return res.json({ valid: false, error: 'تم إلغاء الترخيص' });
  if (license.status === 'suspended') return res.json({ valid: false, error: 'الترخيص موقوف مؤقتاً' });

  // Check expiry
  if (license.expiryDate && new Date(license.expiryDate) < new Date()) {
    license.status = 'expired';
    saveDB(db);
    return res.json({ valid: false, error: 'انتهت صلاحية الترخيص' });
  }

  // Check HWID
  const hwHash = hashHWID(hwid);
  if (license.hwHash && license.hwHash !== hwHash) {
    log(db, 'تحقق فاشل - جهاز مختلف', { code });
    saveDB(db);
    return res.json({ valid: false, error: 'الجهاز غير مصرح له' });
  }

  license.lastHeartbeat = new Date().toISOString();
  saveDB(db);

  res.json({
    valid: true,
    license: {
      plan: license.plan,
      expiryDate: license.expiryDate,
      features: license.features || [],
      daysLeft: license.expiryDate ?
        Math.ceil((new Date(license.expiryDate) - new Date()) / 86400000) : null
    }
  });
});

// نقل الترخيص لجهاز جديد (يحتاج كود نقل من المطور)
app.post('/api/transfer', (req, res) => {
  const { code, hwid, transferCode } = req.body;
  const db = loadDB();
  const license = db.licenses[code];

  if (!license) return res.json({ success: false, error: 'ترخيص غير موجود' });
  if (license.transferCode !== transferCode) return res.json({ success: false, error: 'كود النقل غير صحيح' });

  const hwHash = hashHWID(hwid);
  license.hwHash = hwHash;
  license.hwid_preview = hwid.slice(0, 20) + '...';
  license.transferCode = null;
  license.lastTransfer = new Date().toISOString();

  log(db, 'نقل ترخيص', { code });
  saveDB(db);

  res.json({ success: true, message: 'تم نقل الترخيص بنجاح' });
});

// ─── API: ADMIN ─────────────────────────────────────────

// إنشاء ترخيص جديد
app.post('/api/admin/create', requireAdmin, (req, res) => {
  const { plan, expiryDate, shopName, features, customCode } = req.body;
  const db = loadDB();

  const code = customCode || generateLicenseCode();
  if (db.licenses[code]) return res.json({ success: false, error: 'الكود موجود مسبقاً' });

  db.licenses[code] = {
    code,
    plan: plan || 'standard',
    status: 'pending',
    shopName: shopName || '',
    expiryDate: expiryDate || null,
    features: features || ['all'],
    createdAt: new Date().toISOString(),
    activatedAt: null,
    hwHash: null,
    hwid_preview: null,
    lastHeartbeat: null,
    activationCount: 0,
    notes: req.body.notes || ''
  };

  log(db, 'إنشاء ترخيص', { code, plan, shop: shopName });
  saveDB(db);

  res.json({ success: true, code, license: db.licenses[code] });
});

// قائمة التراخيص
app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  const db = loadDB();
  const { status, search } = req.query;
  let licenses = Object.values(db.licenses);
  if (status) licenses = licenses.filter(l => l.status === status);
  if (search) licenses = licenses.filter(l =>
    l.code.includes(search.toUpperCase()) ||
    (l.shopName || '').includes(search)
  );
  res.json({ licenses, total: Object.keys(db.licenses).length });
});

// تفاصيل ترخيص
app.get('/api/admin/licenses/:code', requireAdmin, (req, res) => {
  const db = loadDB();
  const license = db.licenses[req.params.code];
  if (!license) return res.status(404).json({ error: 'غير موجود' });
  res.json(license);
});

// تعديل ترخيص
app.put('/api/admin/licenses/:code', requireAdmin, (req, res) => {
  const db = loadDB();
  const license = db.licenses[req.params.code];
  if (!license) return res.status(404).json({ error: 'غير موجود' });

  const { status, expiryDate, plan, shopName, notes } = req.body;
  if (status) license.status = status;
  if (expiryDate !== undefined) license.expiryDate = expiryDate;
  if (plan) license.plan = plan;
  if (shopName !== undefined) license.shopName = shopName;
  if (notes !== undefined) license.notes = notes;

  log(db, 'تعديل ترخيص', { code: req.params.code, changes: req.body });
  saveDB(db);
  res.json({ success: true, license });
});

// إلغاء ترخيص
app.delete('/api/admin/licenses/:code', requireAdmin, (req, res) => {
  const db = loadDB();
  if (!db.licenses[req.params.code]) return res.status(404).json({ error: 'غير موجود' });
  db.licenses[req.params.code].status = 'revoked';
  log(db, 'إلغاء ترخيص', { code: req.params.code });
  saveDB(db);
  res.json({ success: true });
});

// كود نقل الترخيص
app.post('/api/admin/transfer-code/:code', requireAdmin, (req, res) => {
  const db = loadDB();
  const license = db.licenses[req.params.code];
  if (!license) return res.status(404).json({ error: 'غير موجود' });
  const transferCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  license.transferCode = transferCode;
  log(db, 'إنشاء كود نقل', { code: req.params.code });
  saveDB(db);
  res.json({ success: true, transferCode });
});

// إحصائيات
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const db = loadDB();
  const all = Object.values(db.licenses);
  res.json({
    total: all.length,
    active: all.filter(l => l.status === 'active').length,
    pending: all.filter(l => l.status === 'pending').length,
    expired: all.filter(l => l.status === 'expired').length,
    revoked: all.filter(l => l.status === 'revoked').length,
    suspended: all.filter(l => l.status === 'suspended').length,
    recentLogs: db.logs.slice(0, 20)
  });
});

// سجل العمليات
app.get('/api/admin/logs', requireAdmin, (req, res) => {
  const db = loadDB();
  res.json({ logs: db.logs.slice(0, 100) });
});

// ─── PWA STATIC FILES ──────────────────────────────────
// يخدم ملفات الـ PWA لو المستخدم شغّل البرنامج من السيرفر
const PWA_FILES = {
  '/manifest.json': { content: JSON.stringify({
    name: 'المودة للبرمجيات', short_name: 'المودة',
    description: 'نظام إدارة المبيعات المتكامل',
    start_url: '/', display: 'standalone',
    background_color: '#0D1B3E', theme_color: '#1B3A6B',
    orientation: 'portrait-primary', lang: 'ar', dir: 'rtl',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ],
    shortcuts: [
      { name: 'نقطة البيع', url: '/?page=pos' },
      { name: 'خلاصة اليوم', url: '/?page=dailysummary' }
    ]
  }), type: 'application/manifest+json' },
  '/sw.js': { file: './sw.js', type: 'application/javascript' }
};

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.send(PWA_FILES['/manifest.json'].content);
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  if (fs.existsSync('./sw.js')) {
    res.sendFile(path.resolve('./sw.js'));
  } else {
    res.send('// Service Worker placeholder');
  }
});

// Serve icon SVG as fallback
app.get('/icon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="38" fill="#1B3A6B"/><text x="96" y="130" font-size="100" text-anchor="middle">🏪</text></svg>');
});
app.get('/icon-192.png', (req, res) => { if(fs.existsSync('./icon-192.png')) res.sendFile(path.resolve('./icon-192.png')); else res.redirect('/icon.svg'); });
app.get('/icon-512.png', (req, res) => { if(fs.existsSync('./icon-512.png')) res.sendFile(path.resolve('./icon-512.png')); else res.redirect('/icon.svg'); });

// ─── SERVE CLIENT APP ───────────────────────────────────
// لو وجد ملف index.html، يخدمه كتطبيق PWA
app.get('/', (req, res) => {
  if (fs.existsSync('./index.html')) {
    res.sendFile(path.resolve('./index.html'));
  } else {
    res.send('<h1 dir="rtl" style="font-family:Arial;text-align:center;margin-top:40vh;color:#1B3A6B">🏪 المودة للبرمجيات — السيرفر يعمل ✅</h1>');
  }
});

// Health check + Server Time (للمزامنة)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    timestamp: Date.now(),
    version: '1.0.0'
  });
});

// Server time endpoint (أكثر دقة مع قياس latency)
app.get('/api/time', (req, res) => {
  const now = new Date();
  res.json({
    iso: now.toISOString(),
    timestamp: now.getTime(),
    utcOffset: 0,
    timezone: 'UTC'
  });
});

// ─── ADMIN DASHBOARD ────────────────────────────────────
app.get('/admin', (req, res) => {
  const key = req.query.key;
  if (key !== CONFIG.ADMIN_KEY) {
    return res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>دخول</title>
    <style>body{font-family:Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a}
    .box{background:#1e293b;border-radius:12px;padding:40px;width:320px;color:#fff}
    h2{text-align:center;color:#f59e0b;margin-bottom:20px}
    input{width:100%;padding:10px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:14px;margin-bottom:14px}
    button{width:100%;padding:11px;background:#f59e0b;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:14px}</style></head>
    <body><div class="box"><h2>🔐 لوحة تحكم المطور</h2>
    <form onsubmit="event.preventDefault();location.href='/admin?key='+document.getElementById('k').value">
    <input id="k" type="password" placeholder="مفتاح الإدارة...">
    <button type="submit">دخول</button></form></div></body></html>`);
  }

  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>المودة للبرمجيات — لوحة تحكم التراخيص</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--pr:#1B3A6B;--gold:#f59e0b;--ok:#10b981;--err:#ef4444;--warn:#f59e0b;--bg:#0f172a;--sur:#1e293b;--sur2:#263348;--border:#334155;--text:#e2e8f0;--text2:#94a3b8}
body{font-family:Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
#topbar{background:var(--sur);border-bottom:2px solid var(--gold);padding:12px 20px;display:flex;align-items:center;gap:14px}
#topbar h1{font-size:16px;color:var(--gold)}
#topbar span{font-size:12px;color:var(--text2)}
.ml{margin-right:auto}
#content{padding:20px;max-width:1200px;margin:0 auto}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.stat{background:var(--sur);border-radius:10px;padding:14px;border:1px solid var(--border);border-top:3px solid var(--gold)}
.stat.ok{border-top-color:var(--ok)}.stat.err{border-top-color:var(--err)}.stat.warn{border-top-color:var(--warn)}
.stat-lbl{font-size:11px;color:var(--text2);margin-bottom:4px}
.stat-val{font-size:24px;font-weight:800}
.card{background:var(--sur);border-radius:10px;border:1px solid var(--border);padding:16px;margin-bottom:16px}
.card-title{font-size:13px;font-weight:700;color:var(--gold);margin-bottom:14px;padding-bottom:9px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.btn{padding:7px 14px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:700;font-family:Arial}
.b-ok{background:var(--ok);color:#fff}.b-err{background:var(--err);color:#fff}
.b-gold{background:var(--gold);color:#000}.b-out{background:var(--sur2);color:var(--text);border:1px solid var(--border)}
.b-sm{padding:4px 10px;font-size:11px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:var(--sur2);color:var(--text2);padding:8px 10px;text-align:right;font-weight:600}
td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:hover td{background:rgba(255,255,255,.03)}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:10px;font-weight:700}
.b-active{background:#052e16;color:#4ade80}.b-pending{background:#1c1917;color:#fb923c}
.b-expired{background:#1c0404;color:#f87171}.b-revoked{background:#1c0404;color:#9ca3af}
.b-suspended{background:#1c1904;color:#fbbf24}
input,select,textarea{background:var(--sur2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font-size:12px;font-family:Arial;width:100%}
input:focus,select:focus{outline:none;border-color:var(--gold)}
.fg{margin-bottom:10px}
.fg label{font-size:11px;color:var(--text2);display:block;margin-bottom:4px;font-weight:600}
.fg2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.fg3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center}
.modal.open{display:flex}
.modal-box{background:var(--sur);border-radius:12px;width:480px;max-height:90vh;overflow-y:auto;border:1px solid var(--border)}
.modal-hdr{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--pr)}
.modal-hdr h3{font-size:13px;font-weight:700;color:#fff}
.modal-body{padding:16px 18px}
.modal-foot{padding:10px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--sur2)}
.code-box{background:var(--bg);border:2px dashed var(--gold);border-radius:8px;padding:14px;text-align:center;font-family:monospace;font-size:18px;font-weight:900;color:var(--gold);letter-spacing:3px;margin:12px 0}
.toast-c{position:fixed;bottom:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:7px}
.toast{padding:10px 16px;border-radius:7px;font-size:12px;font-weight:700;min-width:200px;animation:ti .2s ease}
.t-ok{background:#052e16;color:#4ade80;border:1px solid #166534}
.t-err{background:#1c0404;color:#f87171;border:1px solid #7f1d1d}
@keyframes ti{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.search-row{display:flex;gap:8px;margin-bottom:14px}
.search-row input{flex:1}
</style>
</head>
<body>
<div id="topbar">
  <h1>🏪 المودة للبرمجيات — لوحة تحكم التراخيص</h1>
  <span class="ml" id="serverTime">—</span>
  <button class="btn b-gold" onclick="openCreateModal()">+ ترخيص جديد</button>
  <button class="btn b-out" onclick="loadData()">🔄 تحديث</button>
</div>

<div class="toast-c" id="toastC"></div>

<div id="content">
  <div class="stats-grid" id="statsGrid"></div>

  <div class="card">
    <div class="card-title">
      <span>📋 قائمة التراخيص</span>
      <div style="display:flex;gap:8px">
        <select id="statusFilter" onchange="loadLicenses()" style="width:120px;padding:5px">
          <option value="">الكل</option>
          <option value="active">مفعّل</option>
          <option value="pending">معلق</option>
          <option value="expired">منتهي</option>
          <option value="revoked">ملغي</option>
          <option value="suspended">موقوف</option>
        </select>
      </div>
    </div>
    <div class="search-row">
      <input id="searchInput" placeholder="🔍 بحث بالكود أو اسم المحل..." oninput="loadLicenses()">
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead><tr><th>الكود</th><th>المحل</th><th>الخطة</th><th>الانتهاء</th><th>آخر اتصال</th><th>الحالة</th><th>إجراء</th></tr></thead>
        <tbody id="licensesBody"><tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text2)">جاري التحميل...</td></tr></tbody>
      </table>
    </div>
  </div>


  <!-- UPDATES SECTION in Admin Dashboard -->
  <div class="card">
    <div class="card-title">
      <span>🆕 إدارة التحديثات</span>
      <button class="btn b-gold" onclick="openAddUpdateModal()">+ إضافة إصدار جديد</button>
    </div>
    <div id="updatesBody"></div>
  </div>

  <!-- ADD UPDATE MODAL -->
  <div class="modal" id="addUpdateModal">
    <div class="modal-box">
      <div class="modal-hdr"><h3>+ إضافة إصدار جديد</h3><button onclick="closeModal('addUpdateModal')" style="background:rgba(255,255,255,.2);border:none;color:#fff;width:24px;height:24px;border-radius:50%;cursor:pointer">✕</button></div>
      <div class="modal-body">
        <div class="fg2">
          <div class="fg"><label>رقم الإصدار</label><input id="uv_ver" placeholder="4.2.0"></div>
          <div class="fg"><label>نوع التحديث</label><select id="uv_type"><option value="major">Major - رئيسي</option><option value="minor">Minor - ثانوي</option><option value="patch">Patch - إصلاح</option></select></div>
        </div>
        <div class="fg"><label>ملخص للعميل (يظهر للمستخدم)</label><input id="uv_summary" placeholder="تحسينات وإصلاحات..."></div>
        <div class="fg"><label>تفاصيل للمطور (لا تظهر للعميل)</label>
          <textarea id="uv_notes" rows="5" placeholder="- إضافة ميزة كذا&#10;- إصلاح bug في كذا&#10;- تحسين أداء كذا"></textarea>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn b-out" onclick="closeModal('addUpdateModal')">إلغاء</button>
        <button class="btn b-gold" onclick="addUpdate()">💾 حفظ الإصدار</button>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">📊 آخر العمليات</div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>الوقت</th><th>العملية</th><th>التفاصيل</th></tr></thead>
      <tbody id="logsBody"></tbody>
    </table></div>
  </div>
</div>

<!-- CREATE MODAL -->
<div class="modal" id="createModal">
  <div class="modal-box">
    <div class="modal-hdr"><h3>+ إنشاء ترخيص جديد</h3><button onclick="closeModal('createModal')" style="background:rgba(255,255,255,.2);border:none;color:#fff;width:24px;height:24px;border-radius:50%;cursor:pointer">✕</button></div>
    <div class="modal-body">
      <div class="fg"><label>اسم المحل / العميل</label><input id="c_shop" placeholder="مؤسسة الأمانة للتجارة"></div>
      <div class="fg2">
        <div class="fg"><label>الخطة</label><select id="c_plan"><option value="standard">Standard</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option><option value="trial">Trial (تجريبي)</option></select></div>
        <div class="fg"><label>تاريخ الانتهاء (فارغ = لا انتهاء)</label><input type="date" id="c_expiry"></div>
      </div>
      <div class="fg"><label>كود مخصص (فارغ = تلقائي)</label><input id="c_code" placeholder="MWDA-XXXX-XXXX-XXXX" style="font-family:monospace;letter-spacing:2px"></div>
      <div class="fg"><label>ملاحظات</label><textarea id="c_notes" rows="2" placeholder="أي ملاحظات..."></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn b-out" onclick="closeModal('createModal')">إلغاء</button>
      <button class="btn b-gold" onclick="createLicense()">✅ إنشاء الترخيص</button>
    </div>
  </div>
</div>

<!-- RESULT MODAL -->
<div class="modal" id="resultModal">
  <div class="modal-box">
    <div class="modal-hdr"><h3>✅ تم إنشاء الترخيص</h3><button onclick="closeModal('resultModal')" style="background:rgba(255,255,255,.2);border:none;color:#fff;width:24px;height:24px;border-radius:50%;cursor:pointer">✕</button></div>
    <div class="modal-body">
      <p style="font-size:12px;color:var(--text2);margin-bottom:8px">كود التفعيل للعميل:</p>
      <div class="code-box" id="resultCode">—</div>
      <button class="btn b-gold" style="width:100%;justify-content:center;margin-top:4px" onclick="copyCode()">📋 نسخ الكود</button>
      <div id="resultDetails" style="margin-top:14px;font-size:12px;color:var(--text2)"></div>
    </div>
    <div class="modal-foot"><button class="btn b-out" onclick="closeModal('resultModal')">إغلاق</button></div>
  </div>
</div>

<!-- EDIT MODAL -->
<div class="modal" id="editModal">
  <div class="modal-box">
    <div class="modal-hdr"><h3>✏️ تعديل الترخيص</h3><button onclick="closeModal('editModal')" style="background:rgba(255,255,255,.2);border:none;color:#fff;width:24px;height:24px;border-radius:50%;cursor:pointer">✕</button></div>
    <div class="modal-body" id="editBody"></div>
    <div class="modal-foot">
      <button class="btn b-out" onclick="closeModal('editModal')">إلغاء</button>
      <button class="btn b-gold" onclick="saveEdit()">💾 حفظ</button>
    </div>
  </div>
</div>

<script>
const ADMIN_KEY = '${CONFIG.ADMIN_KEY}';
const API = '';

function toast(msg, type='ok') {
  const el = document.createElement('div');
  el.className = 'toast t-'+type; el.textContent = msg;
  document.getElementById('toastC').appendChild(el);
  setTimeout(()=>el.remove(), 3500);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

async function api(method, path, body) {
  const res = await fetch(API+path, {
    method, headers: {'Content-Type':'application/json','X-Admin-Key':ADMIN_KEY},
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function loadData() {
  await Promise.all([loadStats(), loadLicenses(), loadLogs(), loadUpdates()]);
  document.getElementById('serverTime').textContent = new Date().toLocaleTimeString('ar-EG');
}

async function loadStats() {
  const data = await api('GET', '/api/admin/stats');
  document.getElementById('statsGrid').innerHTML = \`
    <div class="stat"><div class="stat-lbl">إجمالي التراخيص</div><div class="stat-val">\${data.total}</div></div>
    <div class="stat ok"><div class="stat-lbl">مفعّلة</div><div class="stat-val" style="color:var(--ok)">\${data.active}</div></div>
    <div class="stat warn"><div class="stat-lbl">معلقة</div><div class="stat-val" style="color:var(--warn)">\${data.pending}</div></div>
    <div class="stat err"><div class="stat-lbl">منتهية</div><div class="stat-val" style="color:var(--err)">\${data.expired}</div></div>
    <div class="stat err"><div class="stat-lbl">ملغية</div><div class="stat-val" style="color:#6b7280">\${data.revoked}</div></div>
  \`;
}

async function loadLicenses() {
  const status = document.getElementById('statusFilter').value;
  const search = document.getElementById('searchInput').value;
  const params = new URLSearchParams();
  if (status) params.append('status', status);
  if (search) params.append('search', search);
  const data = await api('GET', '/api/admin/licenses?'+params);
  const statusBadge = {
    active:'<span class="badge b-active">مفعّل</span>',
    pending:'<span class="badge b-pending">معلق</span>',
    expired:'<span class="badge b-expired">منتهي</span>',
    revoked:'<span class="badge b-revoked">ملغي</span>',
    suspended:'<span class="badge b-suspended">موقوف</span>'
  };
  const rows = (data.licenses||[]).slice(0,100).map(l => {
    const daysLeft = l.expiryDate ? Math.ceil((new Date(l.expiryDate)-new Date())/86400000) : null;
    const heartAgo = l.lastHeartbeat ? Math.ceil((new Date()-new Date(l.lastHeartbeat))/86400000) : null;
    return \`<tr>
      <td style="font-family:monospace;font-size:11px;font-weight:700;color:var(--gold)">\${l.code}</td>
      <td><strong>\${l.shopName||'—'}</strong></td>
      <td><span class="badge b-pending">\${l.plan||'standard'}</span></td>
      <td style="font-size:11px">\${l.expiryDate?l.expiryDate+' ('+daysLeft+' يوم)':'بلا انتهاء'}</td>
      <td style="font-size:11px;color:\${heartAgo!==null?(heartAgo>3?'var(--err)':'var(--ok)'):'var(--text2)'}">\${heartAgo!==null?heartAgo+' يوم':'لم يتصل'}</td>
      <td>\${statusBadge[l.status]||l.status}</td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">
        <button class="btn b-out b-sm" onclick="editLicense('\${l.code}')">✏️</button>
        <button class="btn b-out b-sm" onclick="getTransferCode('\${l.code}')">🔄 نقل</button>
        \${l.status==='active'?'<button class="btn b-sm" style="background:#1c1904;color:#fbbf24;border:none" onclick="suspendLicense(\''+l.code+'\')">⏸️ وقف</button>':''}
        \${l.status==='suspended'?'<button class="btn b-ok b-sm" onclick="activateLicense(\''+l.code+'\')">▶️ تفعيل</button>':''}
        <button class="btn b-err b-sm" onclick="revokeLicense('\${l.code}')">🚫 إلغاء</button>
      </td>
    </tr>\`;
  }).join('');
  document.getElementById('licensesBody').innerHTML = rows || '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text2)">لا تراخيص</td></tr>';
}

async function loadLogs() {
  const data = await api('GET', '/api/admin/logs');
  document.getElementById('logsBody').innerHTML = (data.logs||[]).slice(0,20).map(l => \`<tr>
    <td style="font-size:10px;white-space:nowrap">\${new Date(l.time).toLocaleString('ar-EG')}</td>
    <td><span class="badge b-pending">\${l.action}</span></td>
    <td style="font-size:11px;color:var(--text2)">\${JSON.stringify(l).slice(0,80)}</td>
  </tr>\`).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--text2)">لا سجلات</td></tr>';
}

function openCreateModal() { openModal('createModal'); }

async function createLicense() {
  const body = {
    shopName: document.getElementById('c_shop').value,
    plan: document.getElementById('c_plan').value,
    expiryDate: document.getElementById('c_expiry').value || null,
    customCode: document.getElementById('c_code').value || null,
    notes: document.getElementById('c_notes').value
  };
  const data = await api('POST', '/api/admin/create', body);
  if (!data.success) { toast(data.error||'خطأ', 'err'); return; }
  closeModal('createModal');
  document.getElementById('resultCode').textContent = data.code;
  document.getElementById('resultDetails').innerHTML = \`
    <div>المحل: <strong>\${data.license.shopName||'—'}</strong></div>
    <div>الخطة: <strong>\${data.license.plan}</strong></div>
    <div>الانتهاء: <strong>\${data.license.expiryDate||'بلا انتهاء'}</strong></div>
  \`;
  openModal('resultModal');
  toast('✅ تم إنشاء الترخيص');
  loadData();
}

function copyCode() {
  const code = document.getElementById('resultCode').textContent;
  navigator.clipboard.writeText(code);
  toast('✅ تم نسخ الكود');
}

let editingCode = null;
async function editLicense(code) {
  editingCode = code;
  const data = await api('GET', \`/api/admin/licenses/\${code}\`);
  document.getElementById('editBody').innerHTML = \`
    <div class="fg"><label>اسم المحل</label><input id="e_shop" value="\${data.shopName||''}"></div>
    <div class="fg2">
      <div class="fg"><label>الخطة</label><select id="e_plan">
        <option value="standard" \${data.plan==='standard'?'selected':''}>Standard</option>
        <option value="pro" \${data.plan==='pro'?'selected':''}>Pro</option>
        <option value="enterprise" \${data.plan==='enterprise'?'selected':''}>Enterprise</option>
        <option value="trial" \${data.plan==='trial'?'selected':''}>Trial</option>
      </select></div>
      <div class="fg"><label>الحالة</label><select id="e_status">
        <option value="pending" \${data.status==='pending'?'selected':''}>معلق</option>
        <option value="active" \${data.status==='active'?'selected':''}>مفعّل</option>
        <option value="suspended" \${data.status==='suspended'?'selected':''}>موقوف</option>
        <option value="expired" \${data.status==='expired'?'selected':''}>منتهي</option>
        <option value="revoked" \${data.status==='revoked'?'selected':''}>ملغي</option>
      </select></div>
    </div>
    <div class="fg"><label>تاريخ الانتهاء</label><input type="date" id="e_expiry" value="\${data.expiryDate||''}"></div>
    <div class="fg"><label>ملاحظات</label><textarea id="e_notes" rows="2">\${data.notes||''}</textarea></div>
    <div style="font-size:11px;color:var(--text2);margin-top:8px">
      الكود: <strong style="color:var(--gold)">\${data.code}</strong> |
      HWID: <strong>\${data.hwid_preview||'لم يتفعل'}</strong> |
      آخر اتصال: <strong>\${data.lastHeartbeat?new Date(data.lastHeartbeat).toLocaleString('ar-EG'):'—'}</strong>
    </div>
  \`;
  openModal('editModal');
}

async function saveEdit() {
  const body = {
    shopName: document.getElementById('e_shop').value,
    plan: document.getElementById('e_plan').value,
    status: document.getElementById('e_status').value,
    expiryDate: document.getElementById('e_expiry').value || null,
    notes: document.getElementById('e_notes').value
  };
  const data = await api('PUT', \`/api/admin/licenses/\${editingCode}\`, body);
  if (data.success) { toast('✅ تم الحفظ'); closeModal('editModal'); loadData(); }
  else toast(data.error||'خطأ', 'err');
}

async function revokeLicense(code) {
  if (!confirm('إلغاء الترخيص: ' + code + '؟')) return;
  await api('DELETE', \`/api/admin/licenses/\${code}\`);
  toast('تم إلغاء الترخيص', 'err'); loadData();
}

async function suspendLicense(code) {
  await api('PUT', \`/api/admin/licenses/\${code}\`, { status: 'suspended' });
  toast('تم إيقاف الترخيص', 'err'); loadData();
}

async function activateLicense(code) {
  await api('PUT', \`/api/admin/licenses/\${code}\`, { status: 'active' });
  toast('✅ تم تفعيل الترخيص'); loadData();
}

async function getTransferCode(code) {
  const data = await api('POST', \`/api/admin/transfer-code/\${code}\`);
  if (data.success) {
    alert('كود نقل الترخيص:\\n\\n' + data.transferCode + '\\n\\nأعطه للعميل لنقل الترخيص لجهاز جديد (صالح لمرة واحدة)');
    toast('✅ كود النقل: ' + data.transferCode);
  }
}


async function loadUpdates() {
  const data = await api('GET', '/api/admin/updates');
  const updates = data.updates || [];
  const el = document.getElementById('updatesBody');
  if (!el) return;
  el.innerHTML = \`
    <div style="margin-bottom:10px;font-size:12px;color:var(--text2)">الإصدار الحالي: <strong style="color:var(--gold)">\${data.currentVersion}</strong> — آخر تحديث: \${data.releaseDate}</div>
    <table>
      <thead><tr><th>الإصدار</th><th>التاريخ</th><th>النوع</th><th>ملخص العميل</th><th>تفاصيل المطور</th></tr></thead>
      <tbody>\${updates.map(u => \`<tr>
        <td style="font-family:monospace;font-weight:700;color:var(--gold)">\${u.version}</td>
        <td style="font-size:11px">\${u.date}</td>
        <td><span class="badge \${u.type==='major'?'b-active':u.type==='minor'?'b-pending':'b-revoked'}">\${u.type}</span></td>
        <td style="font-size:11px">\${u.clientSummary}</td>
        <td style="font-size:10px;color:var(--text2)"><ul style="padding-right:14px">\${(u.devNotes||[]).map(n=>\`<li>\${n}</li>\`).join('')}</ul></td>
      </tr>\`).join('')}
      </tbody>
    </table>\`;
}

function openAddUpdateModal() { openModal('addUpdateModal'); }

async function addUpdate() {
  const version = document.getElementById('uv_ver').value.trim();
  const type = document.getElementById('uv_type').value;
  const summary = document.getElementById('uv_summary').value.trim();
  const notes = document.getElementById('uv_notes').value.trim().split('\n').filter(n=>n.trim());
  if (!version || !summary) { toast('أدخل رقم الإصدار والملخص', 'err'); return; }
  const data = await api('POST', '/api/admin/updates', { version, type, clientSummary: summary, devNotes: notes });
  if (data.success) { toast('✅ تم إضافة الإصدار v' + version); closeModal('addUpdateModal'); loadUpdates(); }
  else toast(data.error || 'خطأ', 'err');
}

// Auto refresh every 30 seconds
loadData();
setInterval(loadData, 30000);
setInterval(() => {
  document.getElementById('serverTime').textContent = new Date().toLocaleTimeString('ar-EG');
}, 1000);
</script>
</body>
</html>`);
});

app.listen(CONFIG.PORT, () => {
  console.log(`\n🏪 المودة للبرمجيات — سيرفر التراخيص`);
  console.log(`🚀 يعمل على: http://localhost:${CONFIG.PORT}`);
  console.log(`🔐 لوحة التحكم: http://localhost:${CONFIG.PORT}/admin?key=${CONFIG.ADMIN_KEY}`);
  console.log(`📁 قاعدة البيانات: ${CONFIG.DB_FILE}\n`);
});

// ─── UPDATES API ────────────────────────────────────────

// للعميل: آخر تحديث فقط مع ملخص مختصر
app.get('/api/updates/latest', (req, res) => {
  try {
    const updates = JSON.parse(fs.readFileSync('./updates.json', 'utf8'));
    const latest = updates.updates[0];
    res.json({
      currentVersion: updates.currentVersion,
      releaseDate: updates.releaseDate,
      latestVersion: latest.version,
      date: latest.date,
      type: latest.type,
      summary: latest.clientSummary,
      hasUpdate: (ver1, ver2) => ver1 !== ver2
    });
  } catch(e) {
    res.json({ currentVersion: '4.0.0', latestVersion: '4.0.0' });
  }
});

// للمطور: كل التحديثات بالتفصيل
app.get('/api/admin/updates', requireAdmin, (req, res) => {
  try {
    const updates = JSON.parse(fs.readFileSync('./updates.json', 'utf8'));
    res.json(updates);
  } catch(e) { res.json({ updates: [] }); }
});

// إضافة تحديث جديد (للمطور فقط)
app.post('/api/admin/updates', requireAdmin, (req, res) => {
  const { version, clientSummary, devNotes, type, forPlans } = req.body;
  if (!version || !clientSummary) return res.status(400).json({ error: 'بيانات ناقصة' });
  try {
    const updates = JSON.parse(fs.readFileSync('./updates.json', 'utf8'));
    updates.updates.unshift({
      version, date: new Date().toISOString().slice(0,10),
      type: type || 'minor', clientSummary,
      devNotes: devNotes || [], forPlans: forPlans || ['all']
    });
    updates.currentVersion = version;
    updates.releaseDate = new Date().toISOString().slice(0,10);
    fs.writeFileSync('./updates.json', JSON.stringify(updates, null, 2));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
