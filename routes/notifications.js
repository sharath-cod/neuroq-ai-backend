// routes/notifications.js
const router = require('express').Router();
const db     = require('../config/db');
const { auth } = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const [notifs] = await db.execute(
      'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    const [[{unread}]] = await db.execute(
      'SELECT COUNT(*) AS unread FROM notifications WHERE user_id=? AND is_read=0',
      [req.user.id]
    );
    res.json({ notifications: notifs, unread });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/read', auth, async (req, res) => {
  await db.execute('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
  res.json({ message: 'Marked as read' });
});

router.patch('/read-all', auth, async (req, res) => {
  await db.execute('UPDATE notifications SET is_read=1 WHERE user_id=?',[req.user.id]);
  res.json({ message: 'All marked as read' });
});

module.exports = router;
