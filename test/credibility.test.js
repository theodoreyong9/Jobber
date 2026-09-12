import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreFromTally, EVENT, identityCapFor, nextPalier, BASE_IDENTITY_CAP, IDENTITY_PALIER_STEP, IDENTITY_PALIERS } from '../js/credibility.js';

// scoreFromTally is the pure half of credibility.js — everything that
// actually touches IndexedDB (recordEvent, computeCredibility,
// handleRotation) is exercised separately in the browser (see the
// Playwright checks run alongside this feature), the same split the rest
// of this test suite already uses for anything db.js-backed.

function tally(overrides = {}) {
  return { firstSeenTs: null, counts: {}, ...overrides };
}

test('scoreFromTally: a subject with no events at all scores 0 with an honest negative factor', () => {
  const { score, factors } = scoreFromTally(tally());
  assert.equal(score, 0);
  assert.ok(factors.some((f) => f.sign === '-'));
});

test('scoreFromTally: longevity alone (seen, never interacted with) contributes points but stays capped and honest', () => {
  const now = Date.now();
  const oneYearAgo = now - 365 * 86_400_000;
  const { score, factors } = scoreFromTally(tally({ firstSeenTs: oneYearAgo }), now);
  assert.ok(score > 0, 'longevity alone should count for something');
  assert.ok(score <= 30, 'longevity alone should never reach a high score without real interactions');
  assert.ok(factors.some((f) => f.sign === '-'), 'still flags that nothing was ever actually confirmed');
});

test('scoreFromTally: one real interaction type outscores zero, but diversity matters more than repeating the same one', () => {
  const now = Date.now();
  const oneKind = scoreFromTally(tally({ firstSeenTs: now, counts: { [EVENT.CHAT_ACCEPTED]: 1 } }), now);
  const zeroKinds = scoreFromTally(tally({ firstSeenTs: now }), now);
  assert.ok(oneKind.score > zeroKinds.score);

  const sameKindRepeated = scoreFromTally(tally({ firstSeenTs: now, counts: { [EVENT.CHAT_ACCEPTED]: 50 } }), now);
  const twoDistinctKinds = scoreFromTally(tally({ firstSeenTs: now, counts: { [EVENT.CHAT_ACCEPTED]: 1, [EVENT.MEETING_CONFIRMED]: 1 } }), now);
  assert.ok(twoDistinctKinds.score > sameKindRepeated.score, 'two distinct real milestones should outscore one milestone repeated many times — this is the actual sybil-resistance property: volume alone cannot substitute for diversity of real, distinct interactions');
});

test('scoreFromTally: every interaction type present maxes out the diversity factor, and volume has diminishing returns', () => {
  const now = Date.now();
  const allFour = scoreFromTally(tally({
    firstSeenTs: now,
    counts: { [EVENT.CHAT_ACCEPTED]: 1, [EVENT.MEETING_CONFIRMED]: 1, [EVENT.DOCUMENT_SHARED]: 1, [EVENT.ATTACHMENT_COMPLETED]: 1 },
  }), now);
  const hundredOfOne = scoreFromTally(tally({ firstSeenTs: now, counts: { [EVENT.CHAT_ACCEPTED]: 100 } }), now);
  assert.ok(allFour.score > hundredOfOne.score);
});

test('scoreFromTally: score is always clamped to [0, 100] even with an extreme tally', () => {
  const now = Date.now();
  const extreme = scoreFromTally(tally({
    firstSeenTs: now - 100 * 365 * 86_400_000,
    counts: { [EVENT.CHAT_ACCEPTED]: 100000, [EVENT.MEETING_CONFIRMED]: 100000, [EVENT.DOCUMENT_SHARED]: 100000, [EVENT.ATTACHMENT_COMPLETED]: 100000 },
  }), now);
  assert.ok(extreme.score <= 100);
  assert.ok(extreme.score >= 0);
});

test('scoreFromTally: a rotated-identity history is flagged as a specific, listed factor', () => {
  const now = Date.now();
  const { factors } = scoreFromTally(tally({ firstSeenTs: now, counts: { [EVENT.ROTATED_FROM]: 1, [EVENT.CHAT_ACCEPTED]: 1 } }), now);
  assert.ok(factors.some((f) => /rotated/i.test(f.text)));
});

test('scoreFromTally: never scores negative even with a firstSeenTs in the future (clock skew)', () => {
  const now = Date.now();
  const { score } = scoreFromTally(tally({ firstSeenTs: now + 86_400_000 }), now);
  assert.ok(score >= 0);
});

// identityCapFor / nextPalier — the pure math behind the Bureau's identity
// slot cap (see desktop-ui.js) and identity-ui.js's createIdentityFlow
// gate. computeGlobalCredibility itself touches IndexedDB (via db.js), so
// like recordEvent/computeCredibility it's exercised in the browser
// instead — these two are pure functions of a score, so they belong here.

test('identityCapFor: below every palier, the cap is just the base', () => {
  assert.equal(identityCapFor(0), BASE_IDENTITY_CAP);
  assert.equal(identityCapFor(IDENTITY_PALIERS[0] - 1), BASE_IDENTITY_CAP);
});

test('identityCapFor: reaching a palier unlocks exactly one more step, not a jump to unlimited', () => {
  assert.equal(identityCapFor(IDENTITY_PALIERS[0]), BASE_IDENTITY_CAP + IDENTITY_PALIER_STEP);
  assert.equal(identityCapFor(100), BASE_IDENTITY_CAP + IDENTITY_PALIERS.length * IDENTITY_PALIER_STEP);
});

test('nextPalier: reports the next threshold still ahead, and null once every known one is cleared', () => {
  assert.equal(nextPalier(0), IDENTITY_PALIERS[0]);
  assert.equal(nextPalier(IDENTITY_PALIERS[IDENTITY_PALIERS.length - 1]), null);
});
