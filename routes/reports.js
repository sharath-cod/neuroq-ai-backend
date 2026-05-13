// routes/reports.js
const router = require('express').Router();
const { auth } = require('../middleware/auth');
router.get('/download/:patientId', auth, (req, res) => {
  res.json({ message: 'Use POST /api/ai/report/:patientId to generate report text, then render PDF on frontend using jsPDF' });
});
module.exports = router;
