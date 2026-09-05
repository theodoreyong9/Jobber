// tests/core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePlainText } from '../src/core/parser/documentParser.js';
import { extractFacts } from '../src/core/extraction/heuristicExtractor.js';
import { buildCandidateProfile, buildJobProfile } from '../src/core/extraction/buildProfile.js';
import { normalizeSkill, compareSkillSets } from '../src/core/normalization/normalize.js';
import { computeMatchScore } from '../src/core/scoring/scoreEngine.js';
import { passesCpuFilter } from '../src/core/matching/matchEngine.js';
import { validateSemanticAnalysis, validateIncomingMessage, validateCandidateBroadcast } from '../src/core/validation/schema.js';

const CURRENT_YEAR = new Date().getFullYear();

const CV_TEXT = `
Jean Dupont

Compétences
Python, SQL, Machine Learning, Docker

Expérience
2018 - 2023 Data Engineer chez Acme Corp

Langues
Français, Anglais
`;

const JOB_TEXT = `
Senior Data Engineer

Compétences
Python, SQL, Kubernetes

Langues
Anglais

Poste basé à Paris.
`;

test('parsePlainText produit des lignes non vides', () => {
  const doc = parsePlainText(CV_TEXT, 'cv', 'cv_1');
  assert.ok(doc.lines.length > 3);
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

test('extractFacts repere competences, langues, annees explicites et implicites', () => {
  const doc = parsePlainText(CV_TEXT, 'cv', 'cv_1');
  const { facts } = extractFacts(doc);
  const skillValues = facts.filter((f) => f.field === 'skill').map((f) => f.value);
  assert.ok(skillValues.some((s) => /python/i.test(s)));
  assert.ok(facts.some((f) => f.field === 'language' && /fran/i.test(f.value)));
  // Pas de "X ans d'experience" explicite dans ce CV -> repli sur la date la plus ancienne (2018).
  assert.ok(facts.some((f) => f.field === 'earliest_year_mention' && f.value === '2018'));
});

test('extractFacts prefere la phrase explicite "X ans d\'experience" quand elle existe', () => {
  const doc = parsePlainText('5 ans d\'experience. 2010 - 2015 poste A.', 'cv', 'cv_x');
  const { facts } = extractFacts(doc);
  assert.ok(facts.some((f) => f.field === 'years_of_experience' && f.value === '5'));
});

test('aucune liste de villes/domaines : extractFacts ne produit plus de location_hint/domain_hint', () => {
  const doc = parsePlainText('Poste a Paris, secteur commerce.', 'job', 'job_no_list');
  const { facts } = extractFacts(doc);
  assert.ok(!facts.some((f) => f.field === 'location_hint'));
  assert.ok(!facts.some((f) => f.field === 'domain_hint'));
});

test('buildCandidateProfile fusionne competences+langues en un seul sac de mots-cles', () => {
  const doc = parsePlainText(CV_TEXT, 'cv', 'cv_1');
  const { facts } = extractFacts(doc);
  const candidate = buildCandidateProfile({ documentId: 'cv_1', facts, city: 'Paris' });

  assert.ok(candidate.keywords.includes('python'));
  assert.ok(candidate.keywords.includes('anglais'));
  assert.deepEqual(candidate.cities, ['paris']);
  assert.equal(candidate.yearsOfExperience, CURRENT_YEAR - 2018);
  assert.equal(candidate.yearsOfExperienceEstimated, true);
});

test('buildJobProfile expose keywords, rawText et minYearsRequired explicite', () => {
  const doc = parsePlainText(JOB_TEXT, 'job', 'job_1');
  const { facts } = extractFacts(doc);
  const job = buildJobProfile({ documentId: 'job_1', facts, rawText: JOB_TEXT, minYearsRequired: 3 });

  assert.ok(job.keywords.includes('python'));
  assert.ok(job.keywords.includes('kubernetes'));
  assert.equal(job.minYearsRequired, 3);
  assert.ok(job.rawText.includes('Paris'));
});

test('computeMatchScore : le score est un compte brut de mots-cles en commun (pas une note sur 100)', () => {
  const candidateDoc = parsePlainText(CV_TEXT, 'cv', 'cv_1');
  const jobDoc = parsePlainText(JOB_TEXT, 'job', 'job_1');
  const candidate = buildCandidateProfile({ documentId: 'cv_1', facts: extractFacts(candidateDoc).facts, city: 'Paris' });
  const job = buildJobProfile({ documentId: 'job_1', facts: extractFacts(jobDoc).facts, rawText: JOB_TEXT, minYearsRequired: 3 });

  const score = computeMatchScore(candidate, job);

  // job.keywords = [python, sql, kubernetes, anglais] ; candidate a python, anglais (+francais) -> 2 matches, 1 manquant (sql), 1 manquant (kubernetes)
  assert.ok(score.matchedKeywords.includes('python'));
  assert.ok(score.matchedKeywords.includes('anglais'));
  assert.ok(score.missingKeywords.includes('kubernetes'));
  assert.equal(score.total, score.matchedKeywords.length);
  assert.equal(score.totalRequired, job.keywords.length);
});

test('computeMatchScore : ville comparee litteralement au texte de l\'annonce, sans aucune liste', () => {
  const candidate = buildCandidateProfile({ documentId: 'c', facts: [{ id: '1', field: 'skill', value: 'python', sourceDocumentId: 'c' }], city: 'Lyon' });
  const job = buildJobProfile({ documentId: 'j', facts: [{ id: '2', field: 'skill', value: 'python', sourceDocumentId: 'j' }], rawText: 'Poste base a Lyon, region Rhone-Alpes.' });

  const score = computeMatchScore(candidate, job);
  assert.equal(score.cityStatus, 'match');
});

test('computeMatchScore : ville non mentionnee dans l\'annonce -> mismatch (pas un score invente)', () => {
  const candidate = buildCandidateProfile({ documentId: 'c', facts: [], city: 'Marseille' });
  const job = buildJobProfile({ documentId: 'j', facts: [], rawText: 'Poste base a Lyon.' });
  const score = computeMatchScore(candidate, job);
  assert.equal(score.cityStatus, 'mismatch');
});

test('computeMatchScore : sans ville declaree, le statut est unknown (jamais mismatch par defaut)', () => {
  const candidate = buildCandidateProfile({ documentId: 'c', facts: [] });
  const job = buildJobProfile({ documentId: 'j', facts: [], rawText: 'Poste a Lyon.' });
  const score = computeMatchScore(candidate, job);
  assert.equal(score.cityStatus, 'unknown');
});

test('computeMatchScore : anciennete comparee au minimum explicite du recruteur', () => {
  const experienced = buildCandidateProfile({ documentId: 'c1', facts: [{ id: '1', field: 'years_of_experience', value: '6', sourceDocumentId: 'c1' }] });
  const junior = buildCandidateProfile({ documentId: 'c2', facts: [{ id: '2', field: 'years_of_experience', value: '1', sourceDocumentId: 'c2' }] });
  const job = buildJobProfile({ documentId: 'j', facts: [], rawText: '', minYearsRequired: 5 });

  assert.equal(computeMatchScore(experienced, job).experienceStatus, 'match');
  assert.equal(computeMatchScore(junior, job).experienceStatus, 'below');
});

test('computeMatchScore : sans exigence d\'anciennete du recruteur, statut unknown', () => {
  const candidate = buildCandidateProfile({ documentId: 'c', facts: [{ id: '1', field: 'years_of_experience', value: '6', sourceDocumentId: 'c' }] });
  const job = buildJobProfile({ documentId: 'j', facts: [], rawText: '' });
  assert.equal(computeMatchScore(candidate, job).experienceStatus, 'unknown');
});

test('computeMatchScore : la liste "pourquoi ce score" n\'est jamais vide quand il y a des mots-cles', () => {
  const candidate = buildCandidateProfile({ documentId: 'c', facts: [{ id: '1', field: 'skill', value: 'python', sourceDocumentId: 'c' }] });
  const job = buildJobProfile({ documentId: 'j', facts: [{ id: '2', field: 'skill', value: 'python', sourceDocumentId: 'j' }], rawText: '' });
  const score = computeMatchScore(candidate, job);
  assert.ok(score.reasons.length > 0);
  assert.ok(score.reasons.some((r) => r.type === 'positive' && r.label === 'python'));
});

test('passesCpuFilter : au moins un mot-cle en commun requis', () => {
  const candidate = buildCandidateProfile({ documentId: 'c', facts: [{ id: '1', field: 'skill', value: 'python', sourceDocumentId: 'c' }] });
  const relevantJob = buildJobProfile({ documentId: 'j1', facts: [{ id: '2', field: 'skill', value: 'python', sourceDocumentId: 'j1' }], rawText: '' });
  const irrelevantJob = buildJobProfile({ documentId: 'j2', facts: [{ id: '3', field: 'skill', value: 'photographie', sourceDocumentId: 'j2' }], rawText: '' });
  assert.equal(passesCpuFilter(candidate, relevantJob), true);
  assert.equal(passesCpuFilter(candidate, irrelevantJob), false);
});

test('validateSemanticAnalysis assainit une sortie WebLLM valide', () => {
  const result = validateSemanticAnalysis({ skills: ['Go'], domains: [], responsibilities: [], languages: [], seniority: 'senior' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.skills, ['Go']);
});

test('validateSemanticAnalysis rejette une sortie malformee', () => {
  const result = validateSemanticAnalysis({ skills: 'not-an-array' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('validateIncomingMessage rejette un message trop volumineux', () => {
  const big = { type: 'chat', version: 1, id: 'm1', timestamp: Date.now(), text: 'x'.repeat(100) };
  const result = validateIncomingMessage(big, 50);
  assert.equal(result.ok, false);
});

test('validateCandidateBroadcast accepte une diffusion minimale valide (avec villes)', () => {
  const result = validateCandidateBroadcast({ peerId: 'abc', displayName: 'Jean', searchKeywords: ['python'], skills: ['python'], cities: ['paris'], cvFileName: 'cv.docx' });
  assert.equal(result.ok, true);
});

test('validateCandidateBroadcast exige au moins un mot-cle de recherche', () => {
  const result = validateCandidateBroadcast({ peerId: 'abc', skills: ['python'] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('searchKeywords')));
});

test('validateCandidateBroadcast refuse une diffusion contenant le texte integral du CV', () => {
  const result = validateCandidateBroadcast({
    peerId: 'abc',
    searchKeywords: ['python'],
    skills: ['python'],
    fullText: 'texte integral du cv...',
  });
  assert.equal(result.ok, false);
});
