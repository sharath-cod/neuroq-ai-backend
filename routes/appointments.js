// routes/appointments.js
const router = require('express').Router();
const db     = require('../config/db');
const { auth } = require('../middleware/auth');
const { log }  = require('../utils/logger');

router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT a.*, p.full_name AS patient_name, p.patient_code,
             u.full_name AS doctor_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN users u ON u.id=a.doctor_id
      ORDER BY a.appointment_date ASC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const { patient_id, doctor_id, appointment_date, duration_mins, type, notes } = req.body;
    const [ins] = await db.execute(
      'INSERT INTO appointments (patient_id,doctor_id,appointment_date,duration_mins,type,notes) VALUES (?,?,?,?,?,?)',
      [patient_id, doctor_id||req.user.id, appointment_date, duration_mins||30, type||'consultation', notes||null]
    );
    await log(req.user.id,'APPOINTMENT_CREATED','appointment',ins.insertId,'Appointment created',req);
    res.json({ message:'Appointment created', id: ins.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/:id/status', auth, async (req, res) => {
  try {
    await db.execute('UPDATE appointments SET status=? WHERE id=?', [req.body.status, req.params.id]);
    await log(req.user.id,'APPOINTMENT_UPDATED','appointment',req.params.id,`Status: ${req.body.status}`,req);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
