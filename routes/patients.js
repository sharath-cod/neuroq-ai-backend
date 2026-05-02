// routes/patients.js - Fixed for MySQL 5.5 (no VIEW dependency)
const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const db      = require('../config/db');
const { auth, doctorOrAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s/g,'_')}`)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// GET /api/patients - list all (NO VIEW — direct JOIN for MySQL 5.5)
router.get('/', auth, async (req, res) => {
  try {
    const { search, status, page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let whereClauses = [];
    let params = [];

    if (search) {
      whereClauses.push('(p.full_name LIKE ? OR p.patient_code LIKE ? OR p.phone LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (status) {
      whereClauses.push('p.status = ?');
      params.push(status);
    }

    const where = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // Direct JOIN query — no VIEW needed
    const query = `
      SELECT
        p.id, p.patient_code, p.full_name, p.age, p.gender,
        p.phone, p.status, p.created_at,
        u.full_name AS doctor_name,
        ap.risk_score AS latest_risk,
        ap.risk_label,
        d.name AS primary_disease
      FROM patients p
      LEFT JOIN users u ON u.id = p.assigned_doctor
      LEFT JOIN ai_predictions ap ON ap.patient_id = p.id
        AND ap.predicted_at = (
          SELECT MAX(ap2.predicted_at)
          FROM ai_predictions ap2
          WHERE ap2.patient_id = p.id
        )
      LEFT JOIN diseases d ON d.id = ap.disease_id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `;

    params.push(parseInt(limit), offset);
    const [patients] = await db.execute(query, params);

    // Count query
    const countParams = whereClauses.length > 0 ? params.slice(0, -2) : [];
    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM patients p ${where}`,
      countParams
    );

    res.json({
      patients,
      total,
      page:  parseInt(page),
      pages: Math.ceil(total / parseInt(limit))
    });
  } catch (e) {
    console.error('GET /patients error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/patients/:id - full patient detail
router.get('/:id', auth, async (req, res) => {
  try {
    const [patients] = await db.execute(`
      SELECT p.*, u.full_name AS doctor_name, u.specialty
      FROM patients p
      LEFT JOIN users u ON u.id = p.assigned_doctor
      WHERE p.id = ?`, [req.params.id]
    );
    if (!patients.length) return res.status(404).json({ error: 'Patient not found' });

    const [biomarkers]   = await db.execute('SELECT * FROM biomarkers WHERE patient_id = ? ORDER BY recorded_on DESC LIMIT 1', [req.params.id]);
    const [genetics]     = await db.execute('SELECT * FROM genetic_markers WHERE patient_id = ?', [req.params.id]);
    const [comorbid]     = await db.execute('SELECT * FROM comorbidities WHERE patient_id = ?', [req.params.id]);
    const [visits]       = await db.execute('SELECT * FROM visits WHERE patient_id = ? ORDER BY visit_date DESC', [req.params.id]);
    const [predictions]  = await db.execute(`
      SELECT ap.*, d.name AS disease_name, d.code AS disease_code, d.color_hex,
             u.full_name AS predicted_by_name
      FROM ai_predictions ap
      LEFT JOIN diseases d ON d.id = ap.disease_id
      LEFT JOIN users u    ON u.id = ap.predicted_by
      WHERE ap.patient_id = ?
      ORDER BY ap.predicted_at DESC`, [req.params.id]
    );
    const [appointments] = await db.execute(`
      SELECT a.*, u.full_name AS doctor_name
      FROM appointments a
      LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.patient_id = ?
      ORDER BY a.appointment_date DESC`, [req.params.id]
    );

    const patient = patients[0];
    res.json({
      ...patient,
      biomarkers:    biomarkers[0]  || {},
      genetics:      genetics[0]    || {},
      comorbidities: comorbid[0]    || {},
      visits,
      predictions,
      appointments
    });
  } catch (e) {
    console.error('GET /patients/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/patients - add new patient
router.post('/', auth, doctorOrAdmin,
  upload.fields([{ name: 'mri_scan', maxCount: 1 }, { name: 'blood_report', maxCount: 1 }]),
  async (req, res) => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const b = req.body;

      const [[{ cnt }]] = await conn.execute('SELECT COUNT(*) AS cnt FROM patients');
      const code = `NQ-${String(cnt + 1).padStart(3, '0')}`;

      const mri_url   = req.files?.mri_scan?.[0]    ? `/uploads/${req.files.mri_scan[0].filename}`    : null;
      const blood_url = req.files?.blood_report?.[0] ? `/uploads/${req.files.blood_report[0].filename}` : null;

      const [ins] = await conn.execute(`
        INSERT INTO patients
          (patient_code, full_name, age, gender, dob, blood_group, phone, email,
           address, emergency_contact, education_years, bmi, occupation,
           symptoms, previous_diseases, current_medications, allergies,
           mri_scan_url, blood_report_url, doctor_notes,
           assigned_doctor, status, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [code, b.full_name, b.age, b.gender, b.dob || null, b.blood_group || null,
         b.phone || null, b.email || null, b.address || null,
         b.emergency_contact || null, b.education_years || 12, b.bmi || null,
         b.occupation || null, b.symptoms || null, b.previous_diseases || null,
         b.current_medications || null, b.allergies || null,
         mri_url, blood_url, b.doctor_notes || null,
         b.assigned_doctor || null, b.status || 'active', req.user.id]
      );
      const pid = ins.insertId;

      // Biomarkers
      if (b.amyloid_beta || b.total_tau || b.hippocampal_vol) {
        await conn.execute(`
          INSERT INTO biomarkers
            (patient_id, amyloid_beta, total_tau, phospho_tau, hippocampal_vol,
             alpha_synuclein, dopamine_level, neurofilament_light, tdp43,
             oligoclonal_bands, igg_index, caudate_vol, recorded_on)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURDATE())`,
          [pid, b.amyloid_beta || null, b.total_tau || null, b.phospho_tau || null,
           b.hippocampal_vol || null, b.alpha_synuclein || null, b.dopamine_level || null,
           b.neurofilament_light || null, b.tdp43 || null,
           b.oligoclonal_bands ? 1 : 0, b.igg_index || null, b.caudate_vol || null]
        );
      }

      // Genetics
      await conn.execute(`
        INSERT INTO genetic_markers
          (patient_id, apoe4, family_hx, lrrk2, snca, c9orf72, sod1, htt_cag, hla_drb1, tested_on)
        VALUES (?,?,?,?,?,?,?,?,?,CURDATE())`,
        [pid, b.apoe4?1:0, b.family_hx?1:0, b.lrrk2?1:0, b.snca?1:0,
         b.c9orf72?1:0, b.sod1?1:0, b.htt_cag || 18, b.hla_drb1?1:0]
      );

      // Comorbidities
      await conn.execute(`
        INSERT INTO comorbidities
          (patient_id, diabetes, hypertension, smoking, depression,
           obesity, head_trauma, sleep_disorder, heart_disease, stroke_history)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [pid, b.diabetes?1:0, b.hypertension?1:0, b.smoking?1:0, b.depression?1:0,
         b.obesity?1:0, b.head_trauma?1:0, b.sleep_disorder?1:0,
         b.heart_disease?1:0, b.stroke_history?1:0]
      );

      await conn.commit();
      await log(req.user.id, 'PATIENT_ADDED', 'patient', pid, `Patient ${code} ${b.full_name} added`, req);
      res.json({ message: 'Patient added successfully', patient_id: pid, patient_code: code });
    } catch (e) {
      await conn.rollback();
      console.error('POST /patients error:', e.message);
      res.status(500).json({ error: e.message });
    } finally {
      conn.release();
    }
  }
);

// PUT /api/patients/:id - update patient
router.put('/:id', auth, doctorOrAdmin,
  upload.fields([{ name: 'mri_scan' }, { name: 'blood_report' }]),
  async (req, res) => {
    try {
      const b = req.body;
      const mri_url   = req.files?.mri_scan?.[0]    ? `/uploads/${req.files.mri_scan[0].filename}`    : undefined;
      const blood_url = req.files?.blood_report?.[0] ? `/uploads/${req.files.blood_report[0].filename}` : undefined;

      const updates = {
        full_name:        b.full_name,
        age:              b.age,
        gender:           b.gender,
        phone:            b.phone,
        address:          b.address,
        symptoms:         b.symptoms,
        previous_diseases: b.previous_diseases,
        current_medications: b.current_medications,
        doctor_notes:     b.doctor_notes,
        status:           b.status,
        assigned_doctor:  b.assigned_doctor || null,
        updated_at:       new Date(),
        ...(mri_url   && { mri_scan_url:    mri_url }),
        ...(blood_url && { blood_report_url: blood_url }),
      };

      const keys   = Object.keys(updates).map(k => `${k}=?`).join(',');
      const values = [...Object.values(updates), req.params.id];
      await db.execute(`UPDATE patients SET ${keys} WHERE id=?`, values);
      await log(req.user.id, 'PATIENT_UPDATED', 'patient', req.params.id, `Patient ${req.params.id} updated`, req);
      res.json({ message: 'Patient updated' });
    } catch (e) {
      console.error('PUT /patients error:', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

// DELETE /api/patients/:id
router.delete('/:id', auth, doctorOrAdmin, async (req, res) => {
  try {
    const [[p]] = await db.execute('SELECT full_name, patient_code FROM patients WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Patient not found' });
    await db.execute('DELETE FROM patients WHERE id=?', [req.params.id]);
    await log(req.user.id, 'PATIENT_DELETED', 'patient', req.params.id, `Patient ${p.patient_code} ${p.full_name} deleted`, req);
    res.json({ message: 'Patient deleted' });
  } catch (e) {
    console.error('DELETE /patients error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/patients/:id/visit
router.post('/:id/visit', auth, async (req, res) => {
  try {
    const b = req.body;
    const [ins] = await db.execute(`
      INSERT INTO visits
        (patient_id, visit_date, visit_type, mmse, moca, updrs_motor, updrs_total,
         alsfrs, edss, memory_score, attention_score, language_score, doctor_id, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id,
       b.visit_date || new Date().toISOString().slice(0, 10),
       b.visit_type || 'routine',
       b.mmse || null, b.moca || null, b.updrs_motor || null, b.updrs_total || null,
       b.alsfrs || null, b.edss || null, b.memory_score || null,
       b.attention_score || null, b.language_score || null,
       req.user.id, b.notes || null]
    );
    await log(req.user.id, 'VISIT_ADDED', 'patient', req.params.id, `Visit added for patient ${req.params.id}`, req);
    res.json({ message: 'Visit added', visit_id: ins.insertId });
  } catch (e) {
    console.error('POST /visit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
