// middleware/auth.js
const jwt  = require('jsonwebtoken');
const db   = require('../config/db');

const auth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'neuroq-secret');
    const [rows] = await db.execute(
      'SELECT id, username, email, role, full_name FROM users WHERE id = ? AND is_active = 1',
      [decoded.id]
    );
    if (!rows.length) return res.status(401).json({ error: 'User not found or inactive' });
    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
    next(err);
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
};

const doctorOrAdmin = (req, res, next) => {
  if (!['admin','doctor'].includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
};

module.exports = { auth, adminOnly, doctorOrAdmin };
