// routes/ai.js - Fixed HuggingFace URL + better error handling
const router  = require('express').Router();
const fetch   = require('node-fetch');
const db      = require('../config/db');
const { auth } = require('../middleware/auth');
const { log }  = require('../utils/logger');
const { predictAll, computeSHAP, _riskLabel } = require('../utils/quantumEngine');

// ─── HuggingFace config ───────────────────────────────────
const HF_KEY   = process.env.HF_API_KEY;
// CORRECT URL — must include api-inference subdomain
const HF_URL   = 'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.3';

// ─── HuggingFace AI call ──────────────────────────────────
async function callHF(prompt) {
  if (!HF_KEY) {
    return 'HuggingFace API key not configured. Add HF_API_KEY=hf_... to your backend .env file. Get free key at https://huggingface.co/settings/tokens';
  }

  try {
    const res = await fetch(HF_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens:  350,
          temperature:     0.4,
          top_p:           0.9,
          do_sample:       true,
          return_full_text: false,
        },
        options: {
          wait_for_model: true,   // waits instead of returning 503
          use_cache:      false,
        }
      }),
    });

    // Model still loading
    if (res.status === 503) {
      return 'AI model is warming up (takes ~20 seconds on first use). Please wait a moment and try again.';
    }

    // Auth error
    if (res.status === 401) {
      return 'Invalid HuggingFace API key. Check HF_API_KEY in your .env file.';
    }

    // Rate limited
    if (res.status === 429) {
      return 'HuggingFace rate limit reached. Please wait 1 minute and try again.';
    }

    if (!res.ok) {
      const errText = await res.text();
      // If response is HTML (error page), extract message
      if (errText.startsWith('<')) {
        return `AI service error (status ${res.status}). Check your HF_API_KEY in .env`;
      }
      throw new Error(errText);
    }

    const data = await res.json();
    const raw  = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
    if (!raw) return 'Model returned empty response. Please try again.';

    // Clean up Mistral instruction echo
    return raw.replace(/^\[\/INST\]/,'').replace(/^Assistant:/,'').trim();

  } catch (e) {
    console.error('HuggingFace error:', e.message);
    return `AI connection error: ${e.message}. Check your internet and HF_API_KEY.`;
  }
}

// POST /api/ai/predict/:patientId
router.post('/predict/:patientId', auth, async (req, res) => {
  try {
    const pid = req.params.patientId;

    const [[p]] = await db.execute(`
      SELECT p.*, g.apoe4,g.family_hx,g.lrrk2,g.snca,g.c9orf72,g.sod1,g.htt_cag,g.hla_drb1,
             b.amyloid_beta,b.total_tau,b.phospho_tau,b.hippocampal_vol,
             b.alpha_synuclein,b.dopamine_level,b.neurofilament_light,b.tdp43,
             b.oligoclonal_bands,b.igg_index,b.caudate_vol,
             c.diabetes,c.hypertension,c.smoking,c.depression,c.obesity,c.head_trauma,c.sleep_disorder,
             v.mmse,v.moca,v.updrs_motor,v.updrs_total,v.alsfrs,v.edss
      FROM patients p
      LEFT JOIN genetic_markers g ON g.patient_id=p.id
      LEFT JOIN biomarkers b      ON b.patient_id=p.id
      LEFT JOIN comorbidities c   ON c.patient_id=p.id
      LEFT JOIN visits v          ON v.patient_id=p.id
        AND v.visit_date=(SELECT MAX(visit_date) FROM visits WHERE patient_id=p.id)
      WHERE p.id=?`, [pid]
    );
    if (!p) return res.status(404).json({ error: 'Patient not found' });

    const results = predictAll(p);

    const [diseases] = await db.execute('SELECT id, code FROM diseases');
    const diseaseMap = {};
    diseases.forEach(d => { diseaseMap[d.code] = d.id; });

    for (const [code, result] of Object.entries(results)) {
      const did = diseaseMap[code];
      if (!did) continue;
      const shap = computeSHAP(code, p);
      await db.execute(`
        INSERT INTO ai_predictions
          (patient_id,disease_id,risk_score,risk_label,confidence,disease_stage,
           quantum_score,shap_factors,suggested_treatment,predicted_by,predicted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
        [pid, did, result.score, _riskLabel(result.score), result.confidence,
         result.stage, (result.score * 0.95 + Math.random()*5).toFixed(1),
         JSON.stringify(shap), result.treatment, req.user.id]
      );
    }

    const primary = Object.entries(results).sort((a,b) => b[1].score - a[1].score)[0];

    await log(req.user.id, 'AI_PREDICTION', 'patient', pid,
      `Multi-disease prediction: primary=${primary[0]} score=${primary[1].score}%`, req);

    if (primary[1].score >= 70) {
      await db.execute(`
        INSERT INTO notifications (user_id,title,message,type,link,created_at)
        VALUES (?,?,?,?,?,NOW())`,
        [p.assigned_doctor || req.user.id,
         'High Risk Alert',
         `${p.full_name} (${p.patient_code}): ${primary[0]} risk ${primary[1].score}% — Very High`,
         'alert', `/patients/${pid}`]
      );
    }

    res.json({
      patient:         { id: p.id, name: p.full_name, code: p.patient_code },
      predictions:     results,
      primary_disease: primary[0],
      shap:            computeSHAP(primary[0], p)
    });
  } catch (e) {
    console.error('Predict error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai/chat
router.post('/chat', auth, async (req, res) => {
  const { patientId, messages } = req.body;
  try {
    let patientContext = '';
    if (patientId) {
      try {
        const [[p]] = await db.execute(`
          SELECT p.full_name,p.patient_code,p.age,p.gender,p.symptoms,
                 b.amyloid_beta,b.total_tau,b.hippocampal_vol,b.alpha_synuclein,b.dopamine_level,
                 g.apoe4,g.htt_cag,
                 v.mmse,v.moca,
                 ap.risk_score,ap.risk_label,ap.disease_stage,
                 d.name AS disease_name
          FROM patients p
          LEFT JOIN biomarkers b      ON b.patient_id=p.id
          LEFT JOIN genetic_markers g ON g.patient_id=p.id
          LEFT JOIN visits v          ON v.patient_id=p.id
            AND v.visit_date=(SELECT MAX(visit_date) FROM visits WHERE patient_id=p.id)
          LEFT JOIN ai_predictions ap ON ap.patient_id=p.id
            AND ap.predicted_at=(SELECT MAX(predicted_at) FROM ai_predictions WHERE patient_id=p.id)
          LEFT JOIN diseases d        ON d.id=ap.disease_id
          WHERE p.id=?`, [patientId]
        );
        if (p) {
          patientContext = `
Patient: ${p.full_name} (${p.patient_code}), ${p.age}y ${p.gender}.
Symptoms: ${p.symptoms || 'Not recorded'}.
Biomarkers: Amyloid-β=${p.amyloid_beta}, Tau=${p.total_tau}, Hippocampus=${p.hippocampal_vol}cm³.
APOE4: ${p.apoe4 ? 'Positive' : 'Negative'}, CAG repeats: ${p.htt_cag}.
Cognitive: MMSE=${p.mmse}/30, MoCA=${p.moca}/30.
AI Risk: ${p.risk_score}% (${p.risk_label}) — ${p.disease_name || 'Not assessed'}, Stage: ${p.disease_stage || 'Unknown'}.`;
        }
      } catch(dbErr) {
        console.error('DB error in chat:', dbErr.message);
      }
    }

    const lastMsg = messages?.[messages.length - 1]?.content || '';
    const history = (messages || []).slice(0, -1)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const prompt = `<s>[INST] You are NeuroQ AI, a clinical neurology assistant.${
      patientContext ? `\n\nPatient data:${patientContext}\n` : ''
    }
Be concise, professional, and clinically accurate. Reply in under 120 words.
${history ? `\nConversation history:\n${history}\n` : ''}
User question: ${lastMsg} [/INST]`;

    const reply = await callHF(prompt);
    await log(req.user.id, 'AI_PREDICTION', 'chat', patientId || null, `AI chat query`, req);
    res.json({ reply });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ai/report/:patientId
router.post('/report/:patientId', auth, async (req, res) => {
  try {
    const [[p]] = await db.execute(`
      SELECT p.full_name,p.patient_code,p.age,p.gender,p.symptoms,p.previous_diseases,
             p.current_medications,p.doctor_notes,
             b.amyloid_beta,b.total_tau,b.phospho_tau,b.hippocampal_vol,
             b.alpha_synuclein,b.dopamine_level,b.neurofilament_light,
             g.apoe4,g.family_hx,g.htt_cag,
             c.diabetes,c.hypertension,c.smoking,c.depression,
             v.mmse,v.moca,v.updrs_motor,
             ap.risk_score,ap.risk_label,ap.disease_stage,
             ap.suggested_treatment,ap.confidence,
             d.name AS disease_name,
             u.full_name AS doctor_name, u.specialty
      FROM patients p
      LEFT JOIN genetic_markers g ON g.patient_id=p.id
      LEFT JOIN biomarkers b      ON b.patient_id=p.id
      LEFT JOIN comorbidities c   ON c.patient_id=p.id
      LEFT JOIN visits v          ON v.patient_id=p.id
        AND v.visit_date=(SELECT MAX(visit_date) FROM visits WHERE patient_id=p.id)
      LEFT JOIN ai_predictions ap ON ap.patient_id=p.id
        AND ap.predicted_at=(SELECT MAX(predicted_at) FROM ai_predictions WHERE patient_id=p.id)
      LEFT JOIN diseases d ON d.id=ap.disease_id
      LEFT JOIN users u   ON u.id=p.assigned_doctor
      WHERE p.id=?`, [req.params.patientId]
    );

    if (!p) return res.status(404).json({ error: 'Patient not found' });

    const prompt = `<s>[INST] You are a senior consultant neurologist. Write a formal clinical report.

Patient Details:
- Name: ${p.full_name}, Age: ${p.age}, Gender: ${p.gender}
- Symptoms: ${p.symptoms || 'Not recorded'}
- Previous conditions: ${p.previous_diseases || 'None'}
- Current medications: ${p.current_medications || 'None'}

Diagnostic Results:
- Primary Diagnosis: ${p.disease_name || 'Pending'} — Stage: ${p.disease_stage || 'Unknown'}
- AI Risk Score: ${p.risk_score || 'N/A'}% (${p.risk_label || 'N/A'}), Confidence: ${p.confidence || 'N/A'}%
- Amyloid-β: ${p.amyloid_beta} pg/mL | Total Tau: ${p.total_tau} pg/mL | Hippocampus: ${p.hippocampal_vol} cm³
- MMSE: ${p.mmse}/30 | MoCA: ${p.moca}/30
- APOE4 Gene: ${p.apoe4 ? 'Positive' : 'Negative'} | Family History: ${p.family_hx ? 'Yes' : 'No'}

Write a structured medical report with these sections:
1. CLINICAL SUMMARY
2. KEY DIAGNOSTIC FINDINGS
3. RISK ASSESSMENT
4. RECOMMENDED TREATMENT PLAN
5. FOLLOW-UP SCHEDULE

Keep it under 280 words. Use formal medical language. [/INST]`;

    const report = await callHF(prompt);
    await log(req.user.id, 'REPORT_GENERATED', 'patient', req.params.patientId, 'Medical report generated', req);
    res.json({ report, patient: p });
  } catch (e) {
    console.error('Report error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
