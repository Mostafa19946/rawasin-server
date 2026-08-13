// server.js — Rawasin payment-plan system: real backend (Express + SQLite + bcrypt + JWT).
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const { signToken, requireAuth, requirePermission, requireAdminRole } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '15mb' })); // floor plan images are base64-encoded JSON payloads
app.use(express.static(path.join(__dirname, 'public')));

// ==================== AUTH ====================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(user.role);
  const token = signToken(user);
  res.json({
    token,
    user: { username: user.username, role: user.role, display: user.display },
    roleName: role ? role.name : user.role,
    perms: role ? JSON.parse(role.perms_json) : {},
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT username, role, display FROM users WHERE username = ?').get(req.user.username);
  if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(user.role);
  res.json({ user, roleName: role ? role.name : user.role, perms: role ? JSON.parse(role.perms_json) : {} });
});

// ==================== UNITS ====================
app.get('/api/units', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT *, has_floorplan AS hasFloorPlan FROM units').all();
  res.json(rows.map(r => ({ ...r, hasFloorPlan: !!r.has_floorplan })));
});

app.post('/api/units', requireAuth, requirePermission('inventory.add'), (req, res) => {
  const u = req.body || {};
  if (!u.code || !u.project) return res.status(400).json({ error: 'كود الوحدة والمشروع مطلوبان' });
  const exists = db.prepare('SELECT 1 FROM units WHERE code = ?').get(u.code);
  if (exists) return res.status(409).json({ error: 'هذا الكود موجود بالفعل' });
  db.prepare(`
    INSERT INTO units (code, project, desc, area, garden_area, price, garage, condition)
    VALUES (@code, @project, @desc, @area, @garden_area, @price, @garage, @condition)
  `).run({
    code: u.code, project: u.project, desc: u.desc || u.code,
    area: u.area || 0, garden_area: u.garden_area || 0,
    price: u.price || 0, garage: u.garage || 0, condition: u.condition || 'متاحة',
  });
  res.status(201).json({ ok: true });
});

app.put('/api/units/:code', requireAuth, requirePermission('inventory.edit'), (req, res) => {
  const code = req.params.code;
  const existing = db.prepare('SELECT * FROM units WHERE code = ?').get(code);
  if (!existing) return res.status(404).json({ error: 'الوحدة غير موجودة' });
  const u = { ...existing, ...req.body };
  db.prepare(`
    UPDATE units SET project=@project, desc=@desc, area=@area, garden_area=@garden_area,
    price=@price, garage=@garage, condition=@condition WHERE code=@code
  `).run(u);
  res.json({ ok: true });
});

app.delete('/api/units/:code', requireAuth, requirePermission('inventory.delete'), (req, res) => {
  db.prepare('DELETE FROM floorplans WHERE code = ?').run(req.params.code);
  const result = db.prepare('DELETE FROM units WHERE code = ?').run(req.params.code);
  if (result.changes === 0) return res.status(404).json({ error: 'الوحدة غير موجودة' });
  res.json({ ok: true });
});

// Bulk upsert (used by the Excel/JSON import feature) — creates or updates by code.
app.post('/api/units/bulk', requireAuth, requirePermission('inventory.add'), (req, res) => {
  const list = req.body && req.body.units;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'صيغة غير صحيحة' });
  const upsert = db.prepare(`
    INSERT INTO units (code, project, desc, area, garden_area, price, garage, condition)
    VALUES (@code, @project, @desc, @area, @garden_area, @price, @garage, @condition)
    ON CONFLICT(code) DO UPDATE SET
      project=excluded.project, desc=excluded.desc, area=excluded.area,
      garden_area=excluded.garden_area, price=excluded.price, garage=excluded.garage,
      condition=excluded.condition
  `);
  const tx = db.transaction((rows) => {
    let created = 0, updated = 0;
    for (const u of rows) {
      const before = db.prepare('SELECT 1 FROM units WHERE code = ?').get(u.code);
      upsert.run({
        code: u.code, project: u.project || 'كمبوند رواسين', desc: u.desc || u.code,
        area: u.area || 0, garden_area: u.garden_area || 0,
        price: u.price || 0, garage: u.garage || 0, condition: u.condition || 'متاحة',
      });
      if (before) updated++; else created++;
    }
    return { created, updated };
  });
  const result = tx(list);
  res.json({ ok: true, ...result });
});

// ==================== FLOOR PLANS ====================
app.get('/api/floorplan/:code', requireAuth, (req, res) => {
  const row = db.prepare('SELECT image_base64 FROM floorplans WHERE code = ?').get(req.params.code);
  if (!row) return res.status(404).json({ error: 'لا يوجد رسم هندسي' });
  res.json({ image: row.image_base64 });
});

app.post('/api/floorplan/:code', requireAuth, requirePermission('inventory.edit'), (req, res) => {
  const code = req.params.code;
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'لا توجد بيانات صورة' });
  const unit = db.prepare('SELECT 1 FROM units WHERE code = ?').get(code);
  if (!unit) return res.status(404).json({ error: 'الوحدة غير موجودة' });
  db.prepare(`
    INSERT INTO floorplans (code, image_base64, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET image_base64=excluded.image_base64, updated_at=CURRENT_TIMESTAMP
  `).run(code, image);
  db.prepare('UPDATE units SET has_floorplan = 1 WHERE code = ?').run(code);
  res.json({ ok: true });
});

app.delete('/api/floorplan/:code', requireAuth, requirePermission('inventory.edit'), (req, res) => {
  db.prepare('DELETE FROM floorplans WHERE code = ?').run(req.params.code);
  db.prepare('UPDATE units SET has_floorplan = 0 WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

// ==================== ROLES ====================
app.get('/api/roles', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM roles').all();
  res.json(rows.map(r => ({ id: r.id, name: r.name, perms: JSON.parse(r.perms_json) })));
});

app.post('/api/roles', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  const { id, name, perms } = req.body || {};
  if (!name || !perms) return res.status(400).json({ error: 'بيانات ناقصة' });
  const roleId = id || 'role_' + Date.now();
  const exists = db.prepare('SELECT 1 FROM roles WHERE id = ?').get(roleId);
  if (exists) {
    db.prepare('UPDATE roles SET name=?, perms_json=? WHERE id=?').run(name, JSON.stringify(perms), roleId);
  } else {
    db.prepare('INSERT INTO roles (id, name, perms_json) VALUES (?, ?, ?)').run(roleId, name, JSON.stringify(perms));
  }
  res.json({ ok: true, id: roleId });
});

app.delete('/api/roles/:id', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  const inUse = db.prepare('SELECT 1 FROM users WHERE role = ?').get(req.params.id);
  if (inUse) return res.status(409).json({ error: 'لا يمكن حذف دور مرتبط بمستخدمين حاليين' });
  db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== USERS ====================
// Listing users is allowed for anyone with users.manage (to view), but creating/editing/
// deleting credentials is hard-restricted to the "admin" role account (requireAdminRole).
app.get('/api/users', requireAuth, requirePermission('users.manage'), (req, res) => {
  const rows = db.prepare('SELECT username, role, display FROM users').all();
  res.json(rows);
});

app.post('/api/users', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  const { username, password, role, display } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: 'بيانات ناقصة' });
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'اسم المستخدم موجود بالفعل' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password_hash, role, display) VALUES (?, ?, ?, ?)')
    .run(username, hash, role, display || '');
  res.status(201).json({ ok: true });
});

app.put('/api/users/:username', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  const originalUsername = req.params.username;
  const { username, password, role, display } = req.body || {};
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(originalUsername);
  if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (originalUsername === 'admin' && username && username !== 'admin') {
    return res.status(400).json({ error: 'لا يمكن تغيير اسم مستخدم الحساب الأساسي admin' });
  }
  const newUsername = username || originalUsername;
  if (newUsername !== originalUsername) {
    const clash = db.prepare('SELECT 1 FROM users WHERE username = ?').get(newUsername);
    if (clash) return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل' });
  }
  const newHash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;
  db.prepare('DELETE FROM users WHERE username = ?').run(originalUsername);
  db.prepare('INSERT INTO users (username, password_hash, role, display) VALUES (?, ?, ?, ?)')
    .run(newUsername, newHash, role || existing.role, display !== undefined ? display : existing.display);
  res.json({ ok: true });
});

app.delete('/api/users/:username', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  if (req.params.username === 'admin') return res.status(400).json({ error: 'لا يمكن حذف حساب المدير الأساسي' });
  db.prepare('DELETE FROM users WHERE username = ?').run(req.params.username);
  res.json({ ok: true });
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Fallback to index.html for any non-API route (single-page app)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Rawasin payment server running on http://localhost:${PORT}`);
});
