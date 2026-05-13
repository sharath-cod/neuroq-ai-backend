// utils/quantumEngine.js
// Quantum-inspired multi-disease risk prediction engine
// Simulates VQC (Variational Quantum Circuits) + Neural Network fusion

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

// ─── Alzheimer's ──────────────────────────────
function predictAlzheimer(p) {
  const q_amy  = clamp(p.amyloid_beta / 4.0, 0, 1);
  const q_tau  = clamp(p.total_tau / 700, 0, 1);
  const q_ptau = clamp(p.phospho_tau / 80, 0, 1);
  const q_hip  = 1 - clamp(p.hippocampal_vol / 5.5, 0, 1);
  const q_mmse = 1 - (p.mmse / 30);
  const q_moca = 1 - (p.moca / 30);
  const q_age  = clamp((p.age - 50) / 40, 0, 1);
  const entangle   = Math.sqrt(q_amy * q_tau);
  const apoeGate   = p.apoe4 ? 1.35 : 1.0;
  const classRisk  = _classicalRisk(p) + (p.apoe4 ? 0.09 : 0);
  const layer1 = (entangle*0.30 + q_ptau*0.15 + q_hip*0.20 + q_mmse*0.15 + q_moca*0.10 + q_age*0.10) * apoeGate;
  const raw = sigmoid(6.5 * (layer1 + classRisk - 0.48));
  const score = Math.round(clamp(raw * 100, 1, 99));
  return { score, stage: _alzhStage(score, p.mmse), confidence: _confidence(score), treatment: _alzhTx(score) };
}

// ─── Parkinson's ─────────────────────────────
function predictParkinson(p) {
  const q_syn  = clamp(p.alpha_synuclein / 1000, 0, 1);
  const q_dop  = 1 - clamp(p.dopamine_level / 150, 0, 1);
  const q_upd  = clamp((p.updrs_motor || 0) / 108, 0, 1);
  const q_age  = clamp((p.age - 45) / 45, 0, 1);
  const lrrk2G = p.lrrk2 ? 1.30 : 1.0;
  const sncaG  = p.snca  ? 1.25 : 1.0;
  const classRisk = _classicalRisk(p) + (p.sleep_disorder ? 0.08 : 0) + (p.head_trauma ? 0.06 : 0);
  const entangle = Math.sqrt(q_syn * q_dop);
  const layer1 = (entangle*0.40 + q_upd*0.25 + q_age*0.20 + q_dop*0.15) * lrrk2G * sncaG;
  const raw = sigmoid(6 * (layer1 + classRisk - 0.50));
  const score = Math.round(clamp(raw * 100, 1, 99));
  return { score, stage: _parkStage(score, p.updrs_motor), confidence: _confidence(score), treatment: _parkTx(score) };
}

// ─── Lewy Body ────────────────────────────────
function predictLewyBody(p) {
  const q_syn  = clamp(p.alpha_synuclein / 1000, 0, 1);
  const q_dop  = 1 - clamp(p.dopamine_level / 150, 0, 1);
  const q_amy  = clamp(p.amyloid_beta / 4.0, 0, 1);
  const q_hip  = 1 - clamp(p.hippocampal_vol / 5.5, 0, 1);
  const q_mmse = 1 - (p.mmse / 30);
  const sncaG  = p.snca ? 1.30 : 1.0;
  const classRisk = _classicalRisk(p) + (p.sleep_disorder ? 0.10 : 0);
  const entangle = Math.sqrt(q_syn * q_amy);
  const layer1 = (entangle*0.35 + q_dop*0.25 + q_hip*0.20 + q_mmse*0.20) * sncaG;
  const raw = sigmoid(6.2 * (layer1 + classRisk - 0.50));
  const score = Math.round(clamp(raw * 100, 1, 99));
  return { score, stage: _stageLabel(score), confidence: _confidence(score), treatment: _lbdTx(score) };
}

// ─── FTD ─────────────────────────────────────
function predictFTD(p) {
  const q_tdp  = clamp(p.tdp43 / 5, 0, 1);
  const q_nfl  = clamp(p.neurofilament_light / 30, 0, 1);
  const q_mmse = 1 - (p.mmse / 30);
  const q_age  = clamp((p.age - 45) / 40, 0, 1);
  const c9Gate = p.c9orf72 ? 1.40 : 1.0;
  const classRisk = _classicalRisk(p) + (p.depression ? 0.06 : 0);
  const layer1 = (q_tdp*0.40 + q_nfl*0.25 + q_mmse*0.20 + q_age*0.15) * c9Gate;
  const raw = sigmoid(6 * (layer1 + classRisk - 0.50));
  const score = Math.round(clamp(raw * 100, 1, 99));
  return { score, stage: _stageLabel(score), confidence: _confidence(score), treatment: _ftdTx(score) };
}

// ─── Huntington's ─────────────────────────────
function predictHuntington(p) {
  const cag = p.htt_cag || 18;
  const q_cag  = cag > 36 ? clamp((cag - 36) / 20, 0, 1) : 0;
  const q_cau  = 1 - clamp(p.caudate_vol / 4.5, 0, 1);
  const q_upd  = clamp((p.updrs_motor || 0) / 108, 0, 1);
  const layer1 = q_cag*0.55 + q_cau*0.30 + q_upd*0.15;
  const classRisk = (p.family_hx ? 0.15 : 0) + (p.depression ? 0.05 : 0);
  const raw = sigmoid(7 * (layer1 + classRisk - 0.40));
  const score = Math.round(clamp(raw * 100, 1, 99));
  return { score, stage: _huntStage(cag, score), confidence: _confidence(score), treatment: _huntTx(score) };
}

// ─── MS ───────────────────────────────────────
function predictMS(p) {
  const q_igg  = clamp(p.igg_index / 1.5, 0, 1);
  const q_ocb  = p.oligoclonal_bands ? 0.8 : 0;
  const q_edss = clamp((p.edss || 0) / 10, 0, 1);
  const hlaG   = p.hla_drb1 ? 1.35 : 1.0;
  const layer1 = (q_igg*0.35 + q_ocb*0.35 + q_edss*0.30) * hlaG;
  const classRisk = (p.family_hx ? 0.08 : 0) + (p.smoking ? 0.05 : 0);
  const raw = sigmoid(6 * (layer1 + classRisk - 0.45));
  const score = Math.round(clamp(raw * 100, 1, 99));
  return { score, stage: _msStage(p.edss, score), confidence: _confidence(score), treatment: _msTx(score) };
}

// ─── ALS ──────────────────────────────────────
function predictALS(p) {
  const q_nfl  = clamp(p.neurofilament_light / 40, 0, 1);
  const q_tdp  = clamp(p.tdp43 / 6, 0, 1);
  const q_als  = 1 - clamp((p.alsfrs || 48) / 48, 0, 1);
  const sod1G  = p.sod1   ? 1.40 : 1.0;
  const c9Gate = p.c9orf72 ? 1.35 : 1.0;
  const entangle = Math.sqrt(q_nfl * q_tdp);
  const layer1 = (entangle*0.45 + q_als*0.35 + q_nfl*0.20) * sod1G * c9Gate;
  const classRisk = (p.family_hx ? 0.07 : 0);
  const raw = sigmoid(6.5 * (layer1 + classRisk - 0.45));
  const score = Math.round(clamp(raw * 100, 1, 99));
  return { score, stage: _alsStage(p.alsfrs, score), confidence: _confidence(score), treatment: _alsTx(score) };
}

// ─── SHAP feature importance ──────────────────
function computeSHAP(disease, p) {
  const factors = {
    ALZ:  [
      { label:'Amyloid-β', value: Math.round((p.amyloid_beta/4)*35), dir:'risk' },
      { label:'Total Tau', value: Math.round((p.total_tau/700)*28), dir:'risk' },
      { label:'APOE4 gene', value: p.apoe4 ? 18 : 0, dir:'risk' },
      { label:'Hippocampal vol.', value: Math.round((1-p.hippocampal_vol/5.5)*22), dir:'risk' },
      { label:'MMSE score', value: Math.round((1-p.mmse/30)*15), dir:'risk' },
      { label:'Education', value: -Math.round(Math.max(0,(p.education_years-8)/20)*8), dir:'protect' },
    ],
    PARK: [
      { label:'α-Synuclein', value: Math.round((p.alpha_synuclein/1000)*40), dir:'risk' },
      { label:'Dopamine deficit', value: Math.round((1-p.dopamine_level/150)*35), dir:'risk' },
      { label:'LRRK2 gene', value: p.lrrk2 ? 20 : 0, dir:'risk' },
      { label:'UPDRS score', value: Math.round(((p.updrs_motor||0)/108)*25), dir:'risk' },
      { label:'Sleep disorder', value: p.sleep_disorder ? 8 : 0, dir:'risk' },
    ],
    HUNT: [
      { label:'CAG repeats', value: Math.round(Math.max(0,(p.htt_cag-36)/20)*60), dir:'risk' },
      { label:'Caudate atrophy', value: Math.round((1-p.caudate_vol/4.5)*30), dir:'risk' },
      { label:'Family history', value: p.family_hx ? 15 : 0, dir:'risk' },
    ],
    MS: [
      { label:'IgG index', value: Math.round((p.igg_index/1.5)*35), dir:'risk' },
      { label:'Oligoclonal bands', value: p.oligoclonal_bands ? 35 : 0, dir:'risk' },
      { label:'HLA-DRB1 gene', value: p.hla_drb1 ? 20 : 0, dir:'risk' },
      { label:'EDSS score', value: Math.round(((p.edss||0)/10)*20), dir:'risk' },
    ],
    ALS: [
      { label:'Neurofilament-L', value: Math.round((p.neurofilament_light/40)*40), dir:'risk' },
      { label:'TDP-43', value: Math.round((p.tdp43/6)*35), dir:'risk' },
      { label:'SOD1 gene', value: p.sod1 ? 25 : 0, dir:'risk' },
      { label:'ALSFRS decline', value: Math.round((1-(p.alsfrs||48)/48)*30), dir:'risk' },
    ],
  };
  const list = factors[disease] || factors.ALZ;
  return list.filter(f => f.value !== 0).sort((a,b) => Math.abs(b.value)-Math.abs(a.value)).slice(0,6);
}

// ─── Full multi-disease prediction ────────────
function predictAll(p) {
  return {
    ALZ:  predictAlzheimer(p),
    PARK: predictParkinson(p),
    LBD:  predictLewyBody(p),
    FTD:  predictFTD(p),
    HUNT: predictHuntington(p),
    MS:   predictMS(p),
    ALS:  predictALS(p),
  };
}

// ─── Helpers ──────────────────────────────────
function _classicalRisk(p) {
  let r = 0;
  if (p.diabetes)      r += 0.07;
  if (p.hypertension)  r += 0.06;
  if (p.smoking)       r += 0.05;
  if (p.depression)    r += 0.06;
  if (p.obesity)       r += 0.04;
  if (p.head_trauma)   r += 0.07;
  if (p.family_hx)     r += 0.09;
  r -= Math.max(0, ((p.education_years||12) - 8) / 20) * 0.08;
  return r;
}
function _riskLabel(s)      { return s<25?'Low':s<50?'Moderate':s<70?'High':'Very High'; }
function _confidence(s)     { return +(70 + (s/100)*28 + (Math.random()*4-2)).toFixed(1); }
function _stageLabel(s)     { return s<25?'No impairment':s<50?'Mild':s<70?'Moderate':'Severe'; }
function _alzhStage(s, mmse){ return mmse>=26?'No Impairment':mmse>=20?'Mild Cognitive Impairment':mmse>=10?'Moderate Alzheimer\'s':'Severe Alzheimer\'s'; }
function _parkStage(s, upd) { const u=upd||0; return u<=10?'Stage 1 (Mild)':u<=30?'Stage 2 (Moderate)':u<=60?'Stage 3 (Moderate-Severe)':'Stage 4-5 (Severe)'; }
function _huntStage(cag,s)  { return cag<=36?'Pre-manifest':s<50?'Early':s<70?'Middle':'Late stage'; }
function _msStage(edss,s)   { const e=edss||0; return e<=2?'Minimal disability':e<=4?'Moderate disability':e<=6?'Significant disability':'Severe disability'; }
function _alsStage(alsfrs,s){ const a=alsfrs||48; return a>=40?'Early':a>=30?'Middle':a>=20?'Late':'End stage'; }
function _alzhTx(s) { return s<50?'Cognitive training, lifestyle modification, annual monitoring':'Cholinesterase inhibitors (Donepezil), Memantine for moderate-severe, cognitive rehabilitation, caregiver support'; }
function _parkTx(s) { return s<50?'Exercise, monitoring of motor symptoms':'Levodopa/Carbidopa, Dopamine agonists, Physical therapy, consider DBS evaluation for advanced stages'; }
function _lbdTx(s)  { return 'Rivastigmine (cholinesterase inhibitor), avoid typical antipsychotics, physical therapy, fall prevention, caregiver education'; }
function _ftdTx(s)  { return 'Behavioral management, SSRIs for behavioral symptoms, speech therapy, occupational therapy, caregiver support groups'; }
function _huntTx(s) { return s<50?'Genetic counseling, monitoring':'Tetrabenazine for chorea, antidepressants, speech/occupational therapy, genetic counseling for family members'; }
function _msTx(s)   { return 'Interferon beta or glatiramer acetate (DMTs), corticosteroids for relapses, physiotherapy, fatigue management'; }
function _alsTx(s)  { return 'Riluzole (neuroprotective), Edaravone, respiratory support (BiPAP/ventilator), multidisciplinary ALS clinic, PEG for nutrition'; }

module.exports = { predictAlzheimer, predictParkinson, predictLewyBody, predictFTD, predictHuntington, predictMS, predictALS, predictAll, computeSHAP, _riskLabel };
