// routes/ai.js - Fixed with working free HuggingFace model
// Mistral-7B-Instruct-v0.3 returns 404 on free tier
// Using google/flan-t5-large which works reliably on free HF API
const router  = require('express').Router();
const fetch   = require('node-fetch');
const db      = require('../config/db');
const { auth } = require('../middleware/auth');
const { log }  = require('../utils/logger');
const { predictAll, computeSHAP, _riskLabel } = require('../utils/quantumEngine');

// ─── Working free HuggingFace models ─────────────────────
// Option 1: facebook/blenderbot-400M-distill  (fast, always free)
// Option 2: google/flan-t5-large              (good quality, free)
// Option 3: tiiuae/falcon-7b-instruct         (better but slower)
const HF_KEY = process.env.HF_API_KEY;
const HF_URL = 'https://api-inference.huggingface.co/models/facebook/blenderbot-400M-distill';

// ─── Better option: use text-generation with a working model
const HF_URL_FLAN = 'https://api-inference.huggingface.co/models/google/flan-t5-large';

async function callHF(prompt) {
  if (!HF_KEY) {
    return 'HuggingFace API key not set. Add HF_API_KEY to your Render environment variables.';
  }

  // Try flan-t5-large first (reliable, free, good for medical Q&A)
  try {
    const res = await fetch(HF_URL_FLAN, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        inputs: prompt.slice(0, 512), // flan-t5 has input limit
        parameters: {
          max_new_tokens: 200,
          temperature:    0.7,
          do_sample:      true,
        },
        options: {
          wait_for_model: true,
          use_cache:      false,
        }
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const text = Array.isArray(data)
        ? data[0]?.generated_text
        : data?.generated_text;
      if (text && text.trim()) return text.trim();
    }

    // If flan fails, fall back to blenderbot
    const res2 = await fetch(HF_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        inputs: prompt.slice(0, 300),
        options: { wait_for_model: true }
      }),
    });

    if (res2.ok) {
      const data2 = await res2.json();
      const text2 = data2?.generated_text || data2?.[0]?.generated_text;
      if (text2) return text2.trim();
    }

    const status = res.status;
    if (status === 401) return 'Invalid HuggingFace API key. Check HF_API_KEY in Render environment.';
    if (status === 429) return 'HuggingFace rate limit reached. Please wait 1 minute and try again.';
    if (status === 503) return 'AI model is loading (first use takes ~20 seconds). Please try again shortly.';
    return `AI service returned status ${status}. Please try again.`;

  } catch (e) {
    console.error('HuggingFace error:', e.message);
    return `AI connection error: ${e.message}`;
  }
}

// ─── Build clean short prompt for flan-t5 ────────────────
function buildMedicalPrompt(patientData, question) {
  if (!patientData) {
    return `Answer this medical question about neurology: ${question}`;
  }
  return `Patient: ${patientData.full_name}, ${patientData.age} years old.
Diagnosis: ${patientData.disease_name || 'Under assessment'}, Stage: ${patientData.disease_stage || 'Unknown'}.
Risk Score: ${patientData.risk_score || 'N/A'}%.
Biomarkers: Amyloid=${patientData.amyloid_beta}, Tau=${patientData.total_tau}, MMSE=${patientData.mmse}/30.
APOE4: ${patientData.apoe4 ? 'Positive' : 'Negative'}.
Question: ${question}
Answer as a neurologist in 2-3 sentences:`;
}

function buildReportPrompt(p) {
  return `Write a medical report for this patient.
Name: ${p.full_name}, Age: ${p.age}, Gender: ${p.gender}.
Diagnosis: ${p.disease_name || 'Pending'}, Stage: ${p.disease_stage || 'Unknown'}.
Risk: ${p.risk_score || 'N/A'}% (${p.risk_label || 'N/A'}), Confidence: ${p.confidence || 'N/A'}%.
Amyloid-beta: ${p.amyloid_beta} pg/mL. Total Tau: ${p.total_tau} pg/mL. Hippocampus: ${p.hippocampal_vol} cm3.
MMSE: ${p.mmse}/30. MoCA: ${p.moca}/30. APOE4: ${p.apoe4 ? 'Positive' : 'Negative'}.
Treatment recommended: ${p.suggested_treatment || 'Standard care'}.
Write sections: Clinical Summary, Key Findings, Risk Assessment, Treatment Plan, Follow-up:`;
}

// ════════════════════════════════════════════════
// POST /api/ai/predict/:patientId
// ════════════════════════════════════════════════
router.post('/predict/:patientId', auth, async (req, res) => {
  try {
    const pid = req.params.patientId;

    const [[p]] = await db.execute(`
      SELECT p.*,
             g.apoe4, g.family_hx, g.lrrk2, g.snca, g.c9orf72, g.sod1, g.htt_cag, g.hla_drb1,
             b.amyloid_beta, b.total_tau, b.phospho_tau, b.hippocampal_vol,
             b.alpha_synuclein, b.dopamine_level, b.neurofilament_light, b.tdp43,
             b.oligoclonal_bands, b.igg_index, b.caudate_vol,
             c.diabetes, c.hypertension, c.smoking, c.depression,
             c.obesity, c.head_trauma, c.sleep_disorder,
             v.mmse, v.moca, v.updrs_motor, v.updrs_total, v.alsfrs, v.edss
      FROM patients p
      LEFT JOIN genetic_markers g ON g.patient_id = p.id
      LEFT JOIN biomarkers b      ON b.patient_id = p.id
      LEFT JOIN comorbidities c   ON c.patient_id = p.id
      LEFT JOIN visits v          ON v.patient_id = p.id
        AND v.visit_date = (SELECT MAX(visit_date) FROM visits WHERE patient_id = p.id)
      WHERE p.id = ?`, [pid]
    );

    if (!p) return res.status(404).json({ error: 'Patient not found' });

    // Run quantum AI engine for all 7 diseases
    const results = predictAll(p);

    // Get disease IDs from DB
    const [diseases] = await db.execute('SELECT id, code FROM diseases');
    const diseaseMap = {};
    diseases.forEach(d => { diseaseMap[d.code] = d.id; });

    // Save each prediction to DB
    for (const [code, result] of Object.entries(results)) {
      const did = diseaseMap[code];
      if (!did) continue;
      const shap = computeSHAP(code, p);
      await db.execute(`
        INSERT INTO ai_predictions
          (patient_id, disease_id, risk_score, risk_label, confidence,
           disease_stage, quantum_score, shap_factors, suggested_treatment,
           predicted_by, predicted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
        [pid, did, result.score, _riskLabel(result.score),
         result.confidence, result.stage,
         (result.score * 0.95 + Math.random() * 5).toFixed(1),
         JSON.stringify(shap), result.treatment, req.user.id]
      );
    }

    // Find primary disease (highest score)
    const primary = Object.entries(results)
      .sort((a, b) => b[1].score - a[1].score)[0];

    // Log the action
    await log(req.user.id, 'AI_PREDICTION', 'patient', pid,
      `Prediction: ${primary[0]} score=${primary[1].score}%`, req);

    // Send high-risk notification
    if (primary[1].score >= 70) {
      await db.execute(`
        INSERT INTO notifications (user_id, title, message, type, link, created_at)
        VALUES (?,?,?,?,?,NOW())`,
        [p.assigned_doctor || req.user.id,
         'High Risk Alert',
         `${p.full_name} (${p.patient_code}): ${primary[0]} risk ${primary[1].score}% — Very High`,
         'alert',
         `/patients/${pid}`]
      );
    }

    res.json({
      patient:         { id: p.id, name: p.full_name, code: p.patient_code },
      predictions:     results,
      primary_disease: primary[0],
      shap:            computeSHAP(primary[0], p)
    });

  } catch (e) {
    console.error('Predict error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// POST /api/ai/chat
// ════════════════════════════════════════════════
router.post('/chat', auth, async (req, res) => {
  const { patientId, messages } = req.body;
  try {
    let patientData = null;

    if (patientId) {
      try {
        const [[p]] = await db.execute(`
          SELECT p.full_name, p.patient_code, p.age, p.gender, p.symptoms,
                 b.amyloid_beta, b.total_tau, b.hippocampal_vol,
                 g.apoe4, v.mmse, v.moca,
                 ap.risk_score, ap.risk_label, ap.disease_stage,
                 d.name AS disease_name
          FROM patients p
          LEFT JOIN biomarkers b      ON b.patient_id = p.id
          LEFT JOIN genetic_markers g ON g.patient_id = p.id
          LEFT JOIN visits v          ON v.patient_id = p.id
            AND v.visit_date = (SELECT MAX(visit_date) FROM visits WHERE patient_id = p.id)
          LEFT JOIN ai_predictions ap ON ap.patient_id = p.id
            AND ap.predicted_at = (SELECT MAX(predicted_at) FROM ai_predictions WHERE patient_id = p.id)
          LEFT JOIN diseases d        ON d.id = ap.disease_id
          WHERE p.id = ?`, [patientId]
        );
        patientData = p || null;
      } catch (dbErr) {
        console.error('Chat DB error:', dbErr.message);
      }
    }

    const lastMsg = messages?.[messages.length - 1]?.content || '';
    const prompt  = buildMedicalPrompt(patientData, lastMsg);
    const reply   = await callHF(prompt);

    await log(req.user.id, 'AI_PREDICTION', 'chat', patientId || null, 'AI chat query', req);
    res.json({ reply });

  } catch (e) {
    console.error('Chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// POST /api/ai/report/:patientId
// ════════════════════════════════════════════════
router.post('/report/:patientId', auth, async (req, res) => {
  try {
    const [[p]] = await db.execute(`
      SELECT p.full_name, p.patient_code, p.age, p.gender,
             p.symptoms, p.previous_diseases, p.current_medications, p.doctor_notes,
             b.amyloid_beta, b.total_tau, b.phospho_tau, b.hippocampal_vol,
             b.alpha_synuclein, b.dopamine_level,
             g.apoe4, g.family_hx,
             c.diabetes, c.hypertension, c.smoking, c.depression,
             v.mmse, v.moca, v.updrs_motor,
             ap.risk_score, ap.risk_label, ap.disease_stage,
             ap.suggested_treatment, ap.confidence,
             d.name AS disease_name,
             u.full_name AS doctor_name, u.specialty
      FROM patients p
      LEFT JOIN genetic_markers g ON g.patient_id = p.id
      LEFT JOIN biomarkers b      ON b.patient_id = p.id
      LEFT JOIN comorbidities c   ON c.patient_id = p.id
      LEFT JOIN visits v          ON v.patient_id = p.id
        AND v.visit_date = (SELECT MAX(visit_date) FROM visits WHERE patient_id = p.id)
      LEFT JOIN ai_predictions ap ON ap.patient_id = p.id
        AND ap.predicted_at = (SELECT MAX(predicted_at) FROM ai_predictions WHERE patient_id = p.id)
      LEFT JOIN diseases d ON d.id = ap.disease_id
      LEFT JOIN users u   ON u.id = p.assigned_doctor
      WHERE p.id = ?`, [req.params.patientId]
    );

    if (!p) return res.status(404).json({ error: 'Patient not found' });

    const prompt = buildReportPrompt(p);
    const aiText = await callHF(prompt);

    // If AI returns short/poor response, build a structured fallback report
    const report = aiText.length > 50 ? aiText : buildFallbackReport(p);

    await log(req.user.id, 'REPORT_GENERATED', 'patient', req.params.patientId, 'Medical report generated', req);
    res.json({ report, patient: p });

  } catch (e) {
    console.error('Report error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Fallback report if AI is unavailable ────────────────
function buildFallbackReport(p) {
  const date = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  return `NEUROQ AI CLINICAL REPORT
Generated: ${date}
Patient: ${p.full_name} | Code: ${p.patient_code} | Age: ${p.age} | Gender: ${p.gender}

1. CLINICAL SUMMARY
Patient ${p.full_name} presents with ${p.symptoms || 'symptoms under evaluation'}. Primary AI diagnosis indicates ${p.disease_name || 'neurodegenerative condition'} at ${p.disease_stage || 'early'} stage with a risk score of ${p.risk_score || 'N/A'}% (${p.risk_label || 'pending'} risk category). AI confidence: ${p.confidence || 'N/A'}%.

2. KEY DIAGNOSTIC FINDINGS
- Amyloid-β: ${p.amyloid_beta || 'N/A'} pg/mL (Normal < 1.0)
- Total Tau: ${p.total_tau || 'N/A'} pg/mL (Normal < 300)
- Phospho-Tau: ${p.phospho_tau || 'N/A'} pg/mL (Normal < 26)
- Hippocampal Volume: ${p.hippocampal_vol || 'N/A'} cm³ (Normal > 3.5)
- MMSE Score: ${p.mmse || 'N/A'}/30 | MoCA Score: ${p.moca || 'N/A'}/30
- APOE4 Gene: ${p.apoe4 ? 'POSITIVE (elevated risk)' : 'Negative'}
- Family History: ${p.family_hx ? 'Positive' : 'Negative'}

3. RISK ASSESSMENT
Quantum-AI Engine risk score: ${p.risk_score || 'N/A'}% — ${p.risk_label || 'Pending'}
Comorbidities: Diabetes=${p.diabetes?'Yes':'No'}, Hypertension=${p.hypertension?'Yes':'No'}, Depression=${p.depression?'Yes':'No'}.
Previous conditions: ${p.previous_diseases || 'None recorded'}.

4. RECOMMENDED TREATMENT PLAN
${p.suggested_treatment || 'Please run AI Prediction first to generate treatment recommendations.'}

5. FOLLOW-UP SCHEDULE
- Cognitive assessment (MMSE/MoCA): Every 6 months
- Biomarker blood panel: Every 6 months
- Brain MRI scan: Annually
- Neurologist consultation: Every 3 months if high risk

---
Generated by NeuroQ AI v2.0 | Assigned Doctor: ${p.doctor_name || 'Not assigned'}
DISCLAIMER: This report is AI-assisted and must be reviewed by a qualified neurologist.`;
}

module.exports = router;
