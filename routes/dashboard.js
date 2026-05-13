// routes/dashboard.js - Fixed for MySQL 5.5 (no VIEW)
const router   = require('express').Router();
const db       = require('../config/db');
const { auth } = require('../middleware/auth');

router.get('/stats', auth, async (req, res) => {
  try {
    // All queries individually — no VIEW needed
    const [[{ total_patients }]]        = await db.execute('SELECT COUNT(*) AS total_patients FROM patients');
    const [[{ critical_patients }]]     = await db.execute("SELECT COUNT(*) AS critical_patients FROM patients WHERE status='critical'");
    const [[{ high_risk_count }]]       = await db.execute('SELECT COUNT(*) AS high_risk_count FROM ai_predictions WHERE risk_score >= 70');
    const [[{ upcoming_appointments }]] = await db.execute("SELECT COUNT(*) AS upcoming_appointments FROM appointments WHERE status='scheduled'");
    const [[{ total_doctors }]]         = await db.execute("SELECT COUNT(*) AS total_doctors FROM users WHERE role='doctor'");
    const [[{ total_predictions }]]     = await db.execute('SELECT COUNT(*) AS total_predictions FROM ai_predictions');

    const stats = {
      total_patients,
      critical_patients,
      high_risk_count,
      upcoming_appointments,
      total_doctors,
      total_predictions
    };

    // Monthly trend
    const [monthly] = await db.execute(`
      SELECT
        DATE_FORMAT(predicted_at, '%Y-%m') AS month,
        COUNT(*) AS count,
        AVG(risk_score) AS avg_risk
      FROM ai_predictions
      GROUP BY DATE_FORMAT(predicted_at, '%Y-%m')
      ORDER BY month DESC
      LIMIT 12`
    );

    // Disease distribution
    const [byDisease] = await db.execute(`
      SELECT d.name, d.color_hex, COUNT(*) AS count, AVG(ap.risk_score) AS avg_risk
      FROM ai_predictions ap
      JOIN diseases d ON d.id = ap.disease_id
      GROUP BY d.id, d.name, d.color_hex
      ORDER BY count DESC`
    );

    // High risk patients
    const [highRisk] = await db.execute(`
      SELECT p.full_name, p.patient_code, p.status,
             ap.risk_score, ap.risk_label,
             d.name AS disease
      FROM ai_predictions ap
      JOIN patients p  ON p.id  = ap.patient_id
      JOIN diseases d  ON d.id  = ap.disease_id
      WHERE ap.risk_score >= 70
      ORDER BY ap.risk_score DESC
      LIMIT 5`
    );

    // Recent activity logs
    const [recentLogs] = await db.execute(`
      SELECT al.*, u.full_name, u.role
      FROM activity_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ORDER BY al.created_at DESC
      LIMIT 10`
    );

    // Patient status distribution
    const [statusDist] = await db.execute(
      'SELECT status, COUNT(*) AS count FROM patients GROUP BY status'
    );

    res.json({ stats, monthly: monthly.reverse(), byDisease, highRisk, recentLogs, statusDist });

  } catch (e) {
    console.error('Dashboard error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
