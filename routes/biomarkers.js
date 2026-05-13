// routes/biomarkers.js
const router = require('express').Router();
const db = require('../config/db');
const { auth } = require('../middleware/auth');
const { log } = require('../utils/logger');

router.post('/:patientId', auth, async (req, res) => {
  try {
    const b = req.body;
    const [ins] = await db.execute(`
      INSERT INTO biomarkers (patient_id,amyloid_beta,total_tau,phospho_tau,hippocampal_vol,
        alpha_synuclein,dopamine_level,neurofilament_light,tdp43,oligoclonal_bands,igg_index,caudate_vol,
        cortisol_level,il6_level,recorded_on)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURDATE())`,
      [req.params.patientId,b.amyloid_beta||null,b.total_tau||null,b.phospho_tau||null,
       b.hippocampal_vol||null,b.alpha_synuclein||null,b.dopamine_level||null,
       b.neurofilament_light||null,b.tdp43||null,b.oligoclonal_bands?1:0,
       b.igg_index||null,b.caudate_vol||null,b.cortisol_level||null,b.il6_level||null]
    );
    await log(req.user.id,'BIOMARKER_ADDED','patient',req.params.patientId,'Biomarkers updated',req);
    res.json({ message:'Biomarkers added', id: ins.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:patientId', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM biomarkers WHERE patient_id=? ORDER BY recorded_on DESC',[req.params.patientId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
