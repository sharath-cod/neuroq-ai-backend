// routes/dashboard.js
const router = require('express').Router();
const db     = require('../config/db');
const { auth } = require('../middleware/auth');

router.get('/stats', auth, async (req, res) => {
  try {
    const [[stats]] = await db.execute('SELECT * FROM dashboard_stats');
    const [monthly]  = await db.execute(`
      SELECT DATE_FORMAT(predicted_at,'%Y-%m') AS month, COUNT(*) AS count, AVG(risk_score) AS avg_risk
      FROM ai_predictions GROUP BY month ORDER BY month DESC LIMIT 12`);
    const [byDisease] = await db.execute(`
      SELECT d.name, d.color_hex, COUNT(*) AS count, AVG(ap.risk_score) AS avg_risk
      FROM ai_predictions ap JOIN diseases d ON d.id=ap.disease_id
      GROUP BY d.id ORDER BY count DESC`);
    const [highRisk] = await db.execute(`
      SELECT p.full_name, p.patient_code, p.status, ap.risk_score, ap.risk_label, d.name AS disease
      FROM ai_predictions ap JOIN patients p ON p.id=ap.patient_id JOIN diseases d ON d.id=ap.disease_id
      WHERE ap.risk_score >= 70
      ORDER BY ap.risk_score DESC LIMIT 5`);
    const [recentLogs] = await db.execute(`
      SELECT al.*, u.full_name, u.role FROM activity_logs al
      LEFT JOIN users u ON u.id=al.user_id
      ORDER BY al.created_at DESC LIMIT 10`);
    const [statusDist] = await db.execute(`SELECT status, COUNT(*) AS count FROM patients GROUP BY status`);
    res.json({ stats, monthly, byDisease, highRisk, recentLogs, statusDist });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// ─────────────────────────────────────────────────────────────
// routes/logs.js
const logsRouter = require('express').Router();
logsRouter.get('/', auth, async (req, res) => {
  try {
    const { page=1, limit=20, action } = req.query;
    const offset = (page-1)*limit;
    let where = 'WHERE 1=1';
    const params = [];
    if (action) { where += ' AND al.action_type=?'; params.push(action); }
    const [logs] = await db.execute(`
      SELECT al.*, u.full_name, u.role FROM activity_logs al
      LEFT JOIN users u ON u.id=al.user_id
      ${where} ORDER BY al.created_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`, params);
    const [[{total}]] = await db.execute(`SELECT COUNT(*) AS total FROM activity_logs al ${where}`, params);
    res.json({ logs, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
module.exports.logsRouter = logsRouter;

// ─────────────────────────────────────────────────────────────
// routes/notifications.js  
const notifRouter = require('express').Router();
notifRouter.get('/', auth, async (req, res) => {
  try {
    const [notifs] = await db.execute(
      'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    const [[{unread}]] = await db.execute(
      'SELECT COUNT(*) AS unread FROM notifications WHERE user_id=? AND is_read=0', [req.user.id]
    );
    res.json({ notifications: notifs, unread });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
notifRouter.patch('/:id/read', auth, async (req, res) => {
  await db.execute('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ message: 'Marked as read' });
});
notifRouter.patch('/read-all', auth, async (req, res) => {
  await db.execute('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id]);
  res.json({ message: 'All marked as read' });
});
module.exports.notifRouter = notifRouter;
