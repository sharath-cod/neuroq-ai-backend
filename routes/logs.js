// routes/logs.js
const router = require('express').Router();
const db     = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
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

module.exports = router;
