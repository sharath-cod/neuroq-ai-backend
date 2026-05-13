// routes/auth.js
const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const db      = require('../config/db');
const { log } = require('../utils/logger');
const { auth } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const [rows] = await db.execute(
      'SELECT * FROM users WHERE email = ? AND is_active = 1', [email]
    );
    if (!rows.length) {
      await log(null, 'UNAUTHORIZED_ACCESS', null, null, `Failed login for ${email}`, req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = rows[0];
    // Support plain text for dev + bcrypt for prod
    let match = password === user.password;
    if (!match) { try { match = await bcrypt.compare(password, user.password); } catch {} }
    if (!match) {
      await log(user.id, 'UNAUTHORIZED_ACCESS', null, null, `Wrong password for ${email}`, req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    await db.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET || 'neuroq-secret-2024',
      { expiresIn: '8h' }
    );
    await log(user.id, 'LOGIN', null, null, `Login from ${req.ip}`, req);
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, full_name: user.full_name, role: user.role, specialty: user.specialty }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password, full_name, role, specialty } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [r] = await db.execute(
      'INSERT INTO users (username,email,password,full_name,role,specialty) VALUES (?,?,?,?,?,?)',
      [username, email, hash, full_name, role||'doctor', specialty||null]
    );
    res.json({ message: 'User created', id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email or username already exists' });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  const [rows] = await db.execute(
    'SELECT id,username,email,full_name,role,specialty,phone,avatar_url,last_login FROM users WHERE id=?',
    [req.user.id]
  );
  res.json(rows[0]);
});

// POST /api/auth/logout
router.post('/logout', auth, async (req, res) => {
  await log(req.user.id, 'LOGOUT', null, null, 'User logged out', req);
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
