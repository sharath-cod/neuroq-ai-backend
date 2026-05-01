// routes/ai.js - AI prediction + HuggingFace chat
const router  = require('express').Router();
const fetch   = require('node-fetch');
const db      = require('../config/db');
const { auth } = require('../middleware/auth');
const { log }  = require('../utils/logger');
const { predictAll, computeSHAP, _riskLabel } = require('../utils/quantumEngine');

const HF_KEY   = process.env.HF_API_KEY;
const HF_MODEL = process.env.HF_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3';
const HF_URL   = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

// ─── HuggingFace AI call ──────────────────────
async function callHF(prompt) {
  if (!HF_KEY) return 'HuggingFace API key not configured. Add HF_API_KEY to .env';
  try {
    const res = await fetch(HF_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${HF_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { max_new_tokens: 400, temperature: 0.4, top_p: 0.9, do_sample: true, return_full_text: false }
      })
    });
    if (res.status === 503) return 'AI model loading (first call takes ~20s). Please retry.';
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const raw  = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
    return raw?.replace(/^\[\/INST\]/,'').trim() || 'No response generated.';
  } catch (e) { return `AI error: ${e.message}`; }
}

// POST /api/ai/predict/:patientId - full disease prediction
router.post('/predict/:patientId', auth, async (req, res) => {
  try {
    const pid = req.params.patientId;

    // Fetch all patient data
    const [[p]] = await db.execute(`
      SELECT p.*, g.apoe4,g.family_hx,g.lrrk2,g.snca,g.c9orf72,g.sod1,g.htt_cag,g.hla_drb1,
             b.amyloid_beta,b.total_tau,b.phospho_tau,b.hippocampal_vol,
             b.alpha_synuclein,b.dopamine_level,b.neurofilament_light,b.tdp43,
             b.oligoclonal_bands,b.igg_index,b.caudate_vol,
             c.diabetes,c.hypertension,c.smoking,c.depression,c.obesity,c.head_trauma,c.sleep_disorder,
             v.mmse,v.moca,v.updrs_motor,v.updrs_total,v.alsfrs,v.edss
      FROM patients p
      LEFT JOIN genetic_markers g ON g.patient_id=p.id
      LEFT JOIN biomarkers b ON b.patient_id=p.id
      LEFT JOIN comorbidities c ON c.patient_id=p.id
      LEFT JOIN visits v ON v.patient_id=p.id
        AND v.visit_date=(SELECT MAX(visit_date) FROM visits WHERE patient_id=p.id)
      WHERE p.id=?`, [pid]
    );
    if (!p) return res.status(404).json({ error: 'Patient not found' });

    // Run quantum engine for all diseases
    const results = predictAll(p);

    // Map disease codes to DB IDs
    const [diseases] = await db.execute('SELECT id, code FROM diseases');
    const diseaseMap = {};
    diseases.forEach(d => { diseaseMap[d.code] = d.id; });

    // Save predictions to DB
    for (const [code, result] of Object.entries(results)) {
      const did = diseaseMap[code];
      if (!did) continue;
      const shap = computeSHAP(code, p);
      await db.execute(`
        INSERT INTO ai_predictions
          (patient_id,disease_id,risk_score,risk_label,confidence,disease_stage,quantum_score,shap_factors,suggested_treatment,predicted_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [pid, did, result.score, _riskLabel(result.score), result.confidence,
         result.stage, (result.score * 0.95 + Math.random()*5).toFixed(1),
         JSON.stringify(shap), result.treatment, req.user.id]
      );
    }

    // Find primary disease (highest score)
    const primary = Object.entries(results).sort((a,b) => b[1].score - a[1].score)[0];

    await log(req.user.id, 'AI_PREDICTION', 'patient', pid,
      `Multi-disease prediction: primary=${primary[0]} score=${primary[1].score}%`, req);

    // Add notification if high risk
    if (primary[1].score >= 70) {
      await db.execute(`
        INSERT INTO notifications (user_id,title,message,type,link) VALUES (?,?,?,?,?)`,
        [p.assigned_doctor||req.user.id,
         'High Risk Alert',
         `${p.full_name} (${p.patient_code}): ${primary[0]} risk ${primary[1].score}% — Very High`,
         'alert', `/patients/${pid}`]
      );
    }

    res.json({
      patient: { id:p.id, name:p.full_name, code:p.patient_code },
      predictions: results,
      primary_disease: primary[0],
      shap: computeSHAP(primary[0], p)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai/chat - medical AI chat
router.post('/chat', auth, async (req, res) => {
  const { patientId, messages } = req.body;
  try {
    let patientContext = '';
    if (patientId) {
      const [[p]] = await db.execute(`
        SELECT p.full_name,p.patient_code,p.age,p.gender,
               b.amyloid_beta,b.total_tau,b.hippocampal_vol,b.alpha_synuclein,b.dopamine_level,
               g.apoe4,g.htt_cag,
               v.mmse,v.moca,
               ap.risk_score,ap.risk_label,ap.disease_stage,
               d.name AS disease_name
        FROM patients p
        LEFT JOIN biomarkers b ON b.patient_id=p.id
        LEFT JOIN genetic_markers g ON g.patient_id=p.id
        LEFT JOIN visits v ON v.patient_id=p.id AND v.visit_date=(SELECT MAX(visit_date) FROM visits WHERE patient_id=p.id)
        LEFT JOIN ai_predictions ap ON ap.patient_id=p.id AND ap.predicted_at=(SELECT MAX(predicted_at) FROM ai_predictions WHERE patient_id=p.id)
        LEFT JOIN diseases d ON d.id=ap.disease_id
        WHERE p.id=?`, [patientId]
      );
      if (p) {
        patientContext = `Patient: ${p.full_name} (${p.patient_code}), ${p.age}y ${p.gender}.
Biomarkers: Amyloid-β=${p.amyloid_beta}, Tau=${p.total_tau}, Hippocampus=${p.hippocampal_vol}cm³, α-Synuclein=${p.alpha_synuclein}, Dopamine=${p.dopamine_level}.
Genetics: APOE4=${p.apoe4?'Positive':'Negative'}, CAG=${p.htt_cag}.
Cognitive: MMSE=${p.mmse}/30, MoCA=${p.moca}/30.
AI Risk: ${p.risk_score}% (${p.risk_label}) — ${p.disease_name}, Stage: ${p.disease_stage}.`;
      }
    }

    const lastMsg = messages[messages.length-1]?.content || '';
    const history = messages.slice(0,-1).map(m => `${m.role==='user'?'User':'Assistant'}: ${m.content}`).join('\n');

    const prompt = `<s>[INST] You are NeuroQ AI, a clinical neurology AI assistant.
${patientContext ? `\nCurrent patient data:\n${patientContext}\n` : ''}
Respond clinically and concisely in under 150 words. Be helpful and professional.
${history ? `\nConversation:\n${history}\n` : ''}
User: ${lastMsg} [/INST]`;

    const reply = await callHF(prompt);
    await log(req.user.id, 'AI_PREDICTION', 'chat', patientId||null, `AI chat: ${lastMsg.slice(0,50)}`, req);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai/report - generate AI medical report text
router.post('/report/:patientId', auth, async (req, res) => {
  try {
    const [[p]] = await db.execute(`
      SELECT p.*,g.apoe4,g.family_hx,b.amyloid_beta,b.total_tau,b.phospho_tau,b.hippocampal_vol,
             b.alpha_synuclein,b.dopamine_level,v.mmse,v.moca,
             ap.risk_score,ap.risk_label,ap.disease_stage,ap.suggested_treatment,ap.confidence,
             d.name AS disease_name, u.full_name AS doctor_name, u.specialty
      FROM patients p
      LEFT JOIN genetic_markers g ON g.patient_id=p.id
      LEFT JOIN biomarkers b ON b.patient_id=p.id
      LEFT JOIN comorbidities c ON c.patient_id=p.id
      LEFT JOIN visits v ON v.patient_id=p.id AND v.visit_date=(SELECT MAX(visit_date) FROM visits WHERE patient_id=p.id)
      LEFT JOIN ai_predictions ap ON ap.patient_id=p.id AND ap.predicted_at=(SELECT MAX(predicted_at) FROM ai_predictions WHERE patient_id=p.id)
      LEFT JOIN diseases d ON d.id=ap.disease_id
      LEFT JOIN users u ON u.id=p.assigned_doctor
      WHERE p.id=?`, [req.params.patientId]
    );
    if (!p) return res.status(404).json({ error: 'Patient not found' });

    const prompt = `<s>[INST] You are a senior neurologist. Write a formal medical report for:
Patient: ${p.full_name}, ${p.age}y ${p.gender}.
Primary Diagnosis: ${p.disease_name} — ${p.disease_stage}.
Risk: ${p.risk_score}% (${p.risk_label}), Confidence: ${p.confidence}%.
Key Biomarkers: Amyloid-β=${p.amyloid_beta}pg/mL, Tau=${p.total_tau}pg/mL, Hippocampus=${p.hippocampal_vol}cm³.
Cognitive: MMSE=${p.mmse}/30, MoCA=${p.moca}/30.
APOE4: ${p.apoe4?'Positive':'Negative'}.
Treatment: ${p.suggested_treatment}.
Write: 1) Clinical Summary 2) Key Findings 3) Risk Assessment 4) Treatment Plan 5) Follow-up.
Keep it under 300 words. Professional medical tone. [/INST]`;

    const report = await callHF(prompt);
    await log(req.user.id, 'REPORT_GENERATED', 'patient', req.params.patientId, 'AI report generated', req);
    res.json({ report, patient: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
