// tests/core.test.mjs
// Exécuter avec : node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePlainText } from '../src/core/parser/documentParser.js';
import { extractFacts } from '../src/core/extraction/heuristicExtractor.js';
import { buildCandidateProfile, buildJobProfile } from '../src/core/extraction/buildProfile.js';
import { normalizeSkill, compareSkillSets } from '../src/core/normalization/normalize.js';
import { computeMatchScore, TriState } from '../src/core/scoring/scoreEngine.js';
import { passesCpuFilter, matchCandidateAgainstJobs } from '../src/core/matching/matchEngine.js';
import { validateSemanticAnalysis, validateIncomingMessage, validateCandidateBroadcast } from '../src/core/validation/schema.js';

const CV_TEXT = `
Jean Dupont

Compétences
Python, SQL, Machine Learning, Docker

Expérience
5 ans d'expérience en data engineering
Senior Data Engineer chez Acme Corp

Langues
Français, Anglais

Formation
Master informatique
`;

const JOB_TEXT = `
Senior Data Engineer

Compétences
Python, SQL, Kubernetes

Domaine
Data

Langues
Anglais
`;

test('parsePlainText produit des lignes et paragraphes non vides', () => {
  const doc = parsePlainText(CV_TEXT, 'cv', 'cv_1');
  assert.ok(doc.lines.length > 5);
  assert.equal(doc.kind, 'cv');
});

test('normalizeSkill applique les alias connus', () => {
  assert.equal(normalizeSkill('JS').normalized, 'javascript');
  assert.equal(normalizeSkill('ml').normalized, 'machine learning');
  assert.equal(normalizeSkill('Python').normalized, 'python');
});

test('compareSkillSets distingue matched/missing', () => {
  const { matched, missing } = compareSkillSets(['Python', 'SQL'], ['python', 'kubernetes']);
  assert.deepEqual(matched, ['python']);
  assert.deepEqual(missing, ['kubernetes']);
});

test('extractFacts repère compétences, langues, séniorité, années', () => {
  const doc = parsePlainText(CV_TEXT, 'cv', 'cv_1');
  const { facts } = extractFacts(doc);
  const skillValues = facts.filter((f) => f.field === 'skill').map((f) => f.value);
  assert.ok(skillValues.some((s) => /python/i.test(s)));
  assert.ok(facts.some((f) => f.field === 'language' && /fran/i.test(f.value)));
  assert.ok(facts.some((f) => f.field === 'seniority_hint' && f.value === 'senior'));
  assert.ok(facts.some((f) => f.field === 'years_of_experience' && f.value === '5'));
});

test('buildCandidateProfile / buildJobProfile structurent les faits', () => {
  const cvDoc = parsePlainText(CV_TEXT, 'cv', 'cv_1');
  const jobDoc = parsePlainText(JOB_TEXT, 'job', 'job_1');
  const { facts: cvFacts } = extractFacts(cvDoc);
  const { facts: jobFacts } = extractFacts(jobDoc);

  const candidate = buildCandidateProfile({ documentId: 'cv_1', facts: cvFacts });
  const job = buildJobProfile({ documentId: 'job_1', facts: jobFacts });

  assert.ok(candidate.skills.some((s) => s.name === 'python'));
  assert.equal(candidate.yearsOfExperience, 5);
  assert.ok(job.requiredSkills.some((s) => s.name === 'python'));
  assert.ok(job.requiredSkills.some((s) => s.name === 'kubernetes'));
});

test('computeMatchScore est déterministe et explicable', () => {
  const cvDoc = parsePlainText(CV_TEXT, 'cv', 'cv_1');
  const jobDoc = parsePlainText(JOB_TEXT, 'job', 'job_1');
  const candidate = buildCandidateProfile({ documentId: 'cv_1', facts: extractFacts(cvDoc).facts });
  const job = buildJobProfile({ documentId: 'job_1', facts: extractFacts(jobDoc).facts });

  const score1 = computeMatchScore(candidate, job);
  const score2 = computeMatchScore(candidate, job);
  assert.equal(score1.total, score2.total, 'le score doit être déterministe');
  assert.ok(score1.total > 0 && score1.total <= 100);
  assert.ok(Array.isArray(score1.reasons));
  assert.ok(score1.reasons.some((r) => r.label === 'python' && r.type === 'positive'));
  // kubernetes est requis par l'annonce mais absent du CV -> doit apparaître en missing/warning
  assert.ok(score1.reasons.some((r) => r.label === 'kubernetes' && r.type === 'warning'));
});

test('hard constraint bloquante plafonne le score (§26)', () => {
  const candidate = buildCandidateProfile({ documentId: 'c', facts: [] });
  const job = buildJobProfile({
    documentId: 'j',
    facts: [],
    constraints: [{ label: 'Certification requise', value: 'pmp', strict: true }],
  });
  const score = computeMatchScore(candidate, job);
  assert.equal(score.blocked, true);
  assert.ok(score.total <= 20);
  const blockingReason = score.reasons.find((r) => r.type === 'blocking');
  assert.ok(blockingReason);
});

test('UNKNOWN n\'est jamais confondu avec NO (§27, §58)', () => {
  const candidate = buildCandidateProfile({ documentId: 'c', facts: [] }); // pas de langues connues
  const job = buildJobProfile({ documentId: 'j', facts: [] });
  job.languages = ['german'];
  const score = computeMatchScore(candidate, job);
  // Le score ne doit pas être nul juste parce que l'allemand est absent ET inconnu ;
  // la confiance doit refléter l'incertitude plutôt qu'un score à 0 pur.
  assert.ok(score.confidence < 1);
});

test('passesCpuFilter réduit la population avant scoring (§30-31)', () => {
  const candidate = buildCandidateProfile({
    documentId: 'c',
    facts: [{ id: '1', field: 'skill', value: 'python', sourceDocumentId: 'c' }],
  });
  const relevantJob = buildJobProfile({
    documentId: 'j1',
    facts: [{ id: '2', field: 'skill', value: 'python', sourceDocumentId: 'j1' }],
  });
  const irrelevantJob = buildJobProfile({
    documentId: 'j2',
    facts: [{ id: '3', field: 'skill', value: 'photographie', sourceDocumentId: 'j2' }],
  });
  assert.equal(passesCpuFilter(candidate, relevantJob), true);
  assert.equal(passesCpuFilter(candidate, irrelevantJob), false);
});

test('matchCandidateAgainstJobs classe par score décroissant', async () => {
  const cvDoc = parsePlainText(CV_TEXT, 'cv', 'cv_1');
  const candidate = buildCandidateProfile({ documentId: 'cv_1', facts: extractFacts(cvDoc).facts });
  const jobDoc = parsePlainText(JOB_TEXT, 'job', 'job_1');
  const goodJob = buildJobProfile({ documentId: 'job_1', facts: extractFacts(jobDoc).facts });
  const irrelevantJob = buildJobProfile({
    documentId: 'job_2',
    facts: [{ id: 'x', field: 'skill', value: 'photographie', sourceDocumentId: 'job_2' }],
  });

  const ranked = await matchCandidateAgainstJobs(candidate, [goodJob, irrelevantJob]);
  assert.equal(ranked.length, 1); // irrelevantJob éliminé par le filtre CPU
  assert.equal(ranked[0].jobId, 'job_1');
});

test('validateSemanticAnalysis assainit une sortie WebLLM valide', () => {
  const result = validateSemanticAnalysis({ skills: ['Go'], domains: [], responsibilities: [], languages: [], seniority: 'senior' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.skills, ['Go']);
});

test('validateSemanticAnalysis rejette une sortie malformée', () => {
  const result = validateSemanticAnalysis({ skills: 'not-an-array' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('validateIncomingMessage rejette un message trop volumineux', () => {
  const big = { type: 'chat', version: 1, id: 'm1', timestamp: Date.now(), text: 'x'.repeat(100) };
  const result = validateIncomingMessage(big, 50);
  assert.equal(result.ok, false);
});

test('validateCandidateBroadcast refuse une diffusion contenant le texte intégral du CV', () => {
  const result = validateCandidateBroadcast({
    peerId: 'abc',
    skills: ['python'],
    fullText: 'texte intégral du cv...',
  });
  assert.equal(result.ok, false);
});

test('validateCandidateBroadcast accepte une diffusion minimale valide', () => {
  const result = validateCandidateBroadcast({ peerId: 'abc', displayName: 'Jean', searchKeyword: 'python', skills: ['python'], cvFileName: 'cv.docx' });
  assert.equal(result.ok, true);
});

test('validateCandidateBroadcast exige un mot-clé de recherche', () => {
  const result = validateCandidateBroadcast({ peerId: 'abc', skills: ['python'] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('searchKeyword')));
});
