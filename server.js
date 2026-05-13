// NeuroQ AI - Backend Server
// Node.js + Express + MySQL2 + JWT + HuggingFace
// ─────────────────────────────────────────────

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const multer       = require('multer');
require('dotenv').config();

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 5000;

// ─── Security middleware ──────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','PATCH'],
  allowedHeaders: ['Content-Type','Authorization']
}));

// ─── Rate limiting ────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' }
});
app.use('/api/', limiter);
app.use('/api/auth/login', authLimiter);

// ─── Body parsing ─────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

// ─── Static file serving ──────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Routes ───────────────────────────────────
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/patients',     require('./routes/patients'));
app.use('/api/biomarkers',   require('./routes/biomarkers'));
app.use('/api/ai',           require('./routes/ai'));
app.use('/api/dashboard',    require('./routes/dashboard'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/reports',      require('./routes/reports'));
app.use('/api/logs',         require('./routes/logs'));
app.use('/api/notifications',require('./routes/notifications'));

// ─── Health check ─────────────────────────────
app.get('/api/health', async (req, res) => {
  const db = require('./config/db');
  try {
    await db.execute('SELECT 1');
    res.json({
      status: 'healthy',
      db: 'connected',
      ai: `HuggingFace (${process.env.HF_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3'})`,
      version: '2.0.0',
      time: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: e.message });
  }
});

// ─── 404 handler ──────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global error handler ─────────────────────
app.use((err, req, res, next) => {
  console.error('Global error:', err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

app.listen(PORT, () => {
  console.log(`\n🧠 NeuroQ AI Backend running on port ${PORT}`);
  console.log(`📊 Database: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
  console.log(`🤖 AI Model: ${process.env.HF_MODEL}`);
  console.log(`🌐 Frontend: ${process.env.FRONTEND_URL}\n`);
});

module.exports = app;
