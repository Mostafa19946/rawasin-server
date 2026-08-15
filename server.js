// server.js — Rawasin payment-plan system: real backend (Express + JSON-file store + bcrypt + JWT).
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

  const user = db.findUser(username.trim());
  if (!user) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

  const role = db.findRole(user.role);
  const token = signToken(user);
  res.json({
    token,
    user: { username: user.username, role: user.role, display: user.display },
    roleName: role ? role.name : user.role,
    perms: role ? role.perms : {},
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.findUser(req.user.username);
  if (!user) return res.status(404).json({ error: 'مستخدم غير موجود' });
  const role = db.findRole(user.role);
  res.json({
    user: { username: user.username, role: user.role, display: user.display },
    roleName: role ? role.name : user.role,
    perms: role ? role.perms : {},
  });
});

// ==================== UNITS ====================
app.get('/api/units', requireAuth, (req, res) => {
  res.json(db.listUnits());
});

app.post('/api/units', requireAuth, requirePermission('inventory.add'), (req, res) => {
  const u = req.body || {};
  if (!u.code || !u.project) return res.status(400).json({ error: 'كود الوحدة والمشروع مطلوبان' });
  if (db.findUnit(u.code)) return res.status(409).json({ error: 'هذا الكود موجود بالفعل' });
  db.insertUnit(u);
  res.status(201).json({ ok: true });
});

app.put('/api/units/:code', requireAuth, requirePermission('inventory.edit'), (req, res) => {
  const ok = db.updateUnit(req.params.code, req.body || {});
  if (!ok) return res.status(404).json({ error: 'الوحدة غير موجودة' });
  res.json({ ok: true });
});

app.delete('/api/units/:code', requireAuth, requirePermission('inventory.delete'), (req, res) => {
  const ok = db.deleteUnit(req.params.code);
  if (!ok) return res.status(404).json({ error: 'الوحدة غير موجودة' });
  res.json({ ok: true });
});

// Bulk upsert (used by the Excel/JSON import feature) — creates or updates by code.
app.post('/api/units/bulk', requireAuth, requirePermission('inventory.add'), (req, res) => {
  const list = req.body && req.body.units;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'صيغة غير صحيحة' });
  const result = db.bulkUpsertUnits(list);
  res.json({ ok: true, ...result });
});

// ==================== FLOOR PLANS (multiple images per unit) ====================
app.get('/api/floorplan/:code', requireAuth, (req, res) => {
  const images = db.getFloorplans(req.params.code);
  if (!images.length) return res.status(404).json({ error: 'لا يوجد رسم هندسي' });
  res.json({ images });
});

app.post('/api/floorplan/:code', requireAuth, requirePermission('inventory.edit'), (req, res) => {
  const code = req.params.code;
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'لا توجد بيانات صورة' });
  if (!db.findUnit(code)) return res.status(404).json({ error: 'الوحدة غير موجودة' });
  const result = db.addFloorplan(code, image);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, count: result.count });
});

app.delete('/api/floorplan/:code/:index', requireAuth, requirePermission('inventory.edit'), (req, res) => {
  const ok = db.deleteFloorplanImage(req.params.code, parseInt(req.params.index, 10));
  if (!ok) return res.status(404).json({ error: 'الصورة غير موجودة' });
  res.json({ ok: true });
});

app.delete('/api/floorplan/:code', requireAuth, requirePermission('inventory.edit'), (req, res) => {
  db.deleteAllFloorplans(req.params.code);
  res.json({ ok: true });
});

// ==================== ROLES ====================
app.get('/api/roles', requireAuth, (req, res) => {
  res.json(db.listRoles());
});

app.post('/api/roles', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  const { id, name, perms } = req.body || {};
  if (!name || !perms) return res.status(400).json({ error: 'بيانات ناقصة' });
  const roleId = id || 'role_' + Date.now();
  db.upsertRole({ id: roleId, name, perms });
  res.json({ ok: true, id: roleId });
});

app.delete('/api/roles/:id', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  const inUse = db.listUsers().some(u => u.role === req.params.id);
  if (inUse) return res.status(409).json({ error: 'لا يمكن حذف دور مرتبط بمستخدمين حاليين' });
  db.deleteRole(req.params.id);
  res.json({ ok: true });
});

// ==================== USERS ====================
// Listing users is allowed for anyone with users.manage (to view), but creating/editing/
// deleting credentials is hard-restricted to the "admin" role account (requireAdminRole).
app.get('/api/users', requireAuth, requirePermission('users.manage'), (req, res) => {
  res.json(db.listUsers());
});

app.post('/api/users', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  const { username, password, role, display } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: 'بيانات ناقصة' });
  if (db.findUser(username)) return res.status(409).json({ error: 'اسم المستخدم موجود بالفعل' });
  db.insertUser({ username, password_hash: bcrypt.hashSync(password, 10), role, display });
  res.status(201).json({ ok: true });
});

app.put('/api/users/:username', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  const originalUsername = req.params.username;
  const { username, password, role, display } = req.body || {};
  const existing = db.findUser(originalUsername);
  if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });
  if (originalUsername === 'admin' && username && username !== 'admin') {
    return res.status(400).json({ error: 'لا يمكن تغيير اسم مستخدم الحساب الأساسي admin' });
  }
  const newUsername = username || originalUsername;
  if (newUsername !== originalUsername && db.findUser(newUsername)) {
    return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل' });
  }
  const patch = { username: newUsername, role, display };
  if (password) patch.password_hash = bcrypt.hashSync(password, 10);
  db.updateUser(originalUsername, patch);
  res.json({ ok: true });
});

app.delete('/api/users/:username', requireAuth, requirePermission('users.manage'), requireAdminRole, (req, res) => {
  if (req.params.username === 'admin') return res.status(400).json({ error: 'لا يمكن حذف حساب المدير الأساسي' });
  db.deleteUser(req.params.username);
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
