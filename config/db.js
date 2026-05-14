// config/db.js - MySQL connection pool (Aiven SSL FIXED)
const mysql = require('mysql2/promise');

// Aiven requires SSL — without this, connection is silently dropped or rejected
const sslConfig = process.env.DB_SSL === 'false'
  ? false
  : { rejectUnauthorized: false }; // Aiven uses self-signed CA

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASS     || '',
  database:           process.env.DB_NAME     || 'neuroqai',
  ssl:                sslConfig,              // ← AIVEN FIX: SSL required
  waitForConnections: true,
  connectionLimit:    20,
  queueLimit:         0,
  connectTimeout:     30000,                  // 30s for Aiven latency
  enableKeepAlive:    true,
  keepAliveInitialDelay: 10000,
  timezone:           '+05:30',              // IST
  charset:            'utf8mb4'
});

// Test connection on startup with detailed error reporting
(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('✅ MySQL (Aiven) connected successfully');
    const [[{ version }]] = await conn.execute('SELECT VERSION() AS version');
    console.log(`   MySQL version: ${version}`);
    conn.release();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    if (err.message.includes('SSL') || err.message.includes('ssl')) {
      console.error('   → SSL issue. Check DB_SSL env var and Aiven SSL settings.');
    }
    if (err.message.includes('ECONNREFUSED') || err.message.includes('ETIMEDOUT')) {
      console.error('   → Cannot reach DB. Check DB_HOST and DB_PORT in .env');
    }
    process.exit(1);
  }
})();

module.exports = pool;
