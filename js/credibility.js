// credibility.js — "how much of a real, observable P2P history does this
// identity have?", computed entirely from what THIS browser has itself
// witnessed — never a number broadcast by Jobber or by the identity being
// scored. Two people can (and will) score the same identity differently,
// because they've each seen a different slice of its real history —
// that's the point, not a bug (see state.js's header for the "no
// backend" philosophy this extends into trust). Kept deliberately
// separate from Match (matching.js): "does this fit what I'm looking
// for" and "can I trust this identity's claimed history" are two
// different questions, and folding them into one number would hide
// exactly the cases worth seeing — brand new but perfectly relevant, or
// long-established but not a fit.
//
// Sybil resistance without an account: identities are free and instant
// to create (identity.js has no cost gate), so credibility can't come
// from "having an account" the way it would in a system with a wallet or
// a burn (see AIWA_chain's identity-cost.js, deliberately NOT ported
// here — that model requires a real financial commitment, which Jobber's
// zero-cost identity model doesn't have and shouldn't gain just for
// this). It comes from milestones that are cheap to have honestly and
// expensive to fake at scale instead: a chat actually accepted, a
// meeting actually confirmed, a file actually exchanged — each needs a
// real two-way P2P round trip with a specific counterpart, not just
// existing. A thousand freshly-spun sybil identities score exactly like
// one: zero, until each of them individually goes through a real
// interaction with a real person. And because scoring is entirely local
// (per browser, per subject), flooding the network with fake identities
// doesn't touch any single observer's own view of anyone else — there is
// no shared ledger to poison.
//
// Built on trust-dag.js's EventDag: one append-only chain per (namespace,
// subject identity), stored as individual rows (credibility_events, see
// db.js) rather than one blob, so a single new milestone is a single
// small write. Not on AI, deliberately — every point in the score traces
// to a specific, listable event (see explainCredibility).

import * as db from './db.js';
import { EventDag } from './trust-dag.js';

export const EVENT = {
  FIRST_SEEN: 'first_seen',
  CHAT_ACCEPTED: 'chat_accepted',
  MEETING_CONFIRMED: 'meeting_confirmed',
  DOCUMENT_SHARED: 'document_shared',
  ATTACHMENT_COMPLETED: 'attachment_completed',
  ROTATED_FROM: 'rotated_from',
};

// Milestones that need a real two-way interaction with this specific
// subject — as opposed to FIRST_SEEN (just a discovery broadcast) or
// ROTATED_FROM (bookkeeping, not itself a signal of anything).
const INTERACTION_EVENTS = [EVENT.CHAT_ACCEPTED, EVENT.MEETING_CONFIRMED, EVENT.DOCUMENT_SHARED, EVENT.ATTACHMENT_COMPLETED];

function subjectKey(ns, identityId) {
  return `${ns}:${identityId}`;
}

async function loadDag(ns, subject) {
  const rows = await db.getAll('credibility_events', 'subjectKey', subjectKey(ns, subject));
  rows.sort((a, b) => a.payload.ts - b.payload.ts); // causal proxy: real time order, since this is a single chain, not a branching DAG (yet — see the header)
  const dag = new EventDag();
  dag.loadTrusted(rows.map((r) => ({ id: r.id, parents: r.parents, payload: r.payload })));
  return dag;
}

// Idempotent by `dedupeKey`, not by the DAG's own content-hash id (which
// would treat "chat_accepted at 10:00" and "chat_accepted at 10:05" as two
// different, both-real events) — replay must give zero additional
// influence: accepting a second chat request from someone you already
// have an accepted chat with is not a second, independent milestone.
export async function recordEvent(ns, subject, type, dedupeKey = type) {
  if (!ns || !subject) return;
  const dag = await loadDag(ns, subject);
  const order = dag.topoOrder();
  if (order.some((ev) => ev.payload.dedupeKey === dedupeKey)) return;
  const parents = order.length ? [order[order.length - 1].id] : [];
  const payload = { type, dedupeKey, ts: Date.now() };
  const id = await dag.addEvent(parents, payload);
  const key = subjectKey(ns, subject);
  await db.put('credibility_events', { rowId: `${key}:${id}`, id, subjectKey: key, ns, subject, parents, payload });
}

// Rotating keeps the name but changes the identityId — without this, the
// entire observed history would silently reset to zero on every rotation,
// which would make rotating (a real security feature — see identity.js)
// actively cost you credibility for no reason. Moves every event onto the
// new identityId's chain and adds one bookkeeping event noting the jump.
export async function handleRotation(ns, oldIdentityId, newIdentityId) {
  const oldKey = subjectKey(ns, oldIdentityId);
  const newKey = subjectKey(ns, newIdentityId);
  const rows = await db.getAll('credibility_events', 'subjectKey', oldKey);
  for (const row of rows) {
    await db.del('credibility_events', row.rowId);
    await db.put('credibility_events', { ...row, rowId: `${newKey}:${row.id}`, subjectKey: newKey, subject: newIdentityId });
  }
  await recordEvent(ns, newIdentityId, EVENT.ROTATED_FROM, `rotated_from:${oldIdentityId}`);
}

function tallyReducer(tally, ev) {
  const { type, ts } = ev.payload;
  if (tally.firstSeenTs === null || ts < tally.firstSeenTs) tally.firstSeenTs = ts;
  tally.counts[type] = (tally.counts[type] || 0) + 1;
  return tally;
}

// Pure — takes a tally, returns a score and the specific, listable
// factors behind it. Split out from computeCredibility() so the actual
// arithmetic is unit-testable without touching IndexedDB at all.
// Longevity: up to 20 points. Interactions: each of the 4 INTERACTION_EVENTS
// types contributes *separately*, sqrt-scaled and capped at 20 points each
// (4 x 20 = 80 max) — deliberately per-type, not one global count. Fifty
// repeats of the one easiest milestone (accepting a chat) saturates its
// own 20-point bucket and stops there; two distinct real milestones (say
// a chat AND a meeting, once each) land in two separate buckets and add
// up to more than fifty of the same one ever could. That's the actual
// sybil-resistance property this needs: an accomplice pair can cheaply
// repeat one interaction as many times as they like, but distinct kinds
// of interaction are harder to fabricate in volume, so they're what the
// score has to reward more.
export function scoreFromTally(tally, now = Date.now()) {
  const factors = [];
  let score = 0;

  const daysKnown = tally.firstSeenTs ? Math.max(0, (now - tally.firstSeenTs) / 86_400_000) : 0;
  const longevityPoints = Math.min(20, Math.round(Math.log2(daysKnown + 1) * 6));
  if (longevityPoints > 0) {
    const wholeDays = Math.floor(daysKnown);
    factors.push({ sign: '+', text: `First seen ${wholeDays <= 0 ? 'today' : `${wholeDays} day${wholeDays === 1 ? '' : 's'} ago`}` });
  }
  score += longevityPoints;

  let totalInteractions = 0;
  let distinctInteractionKinds = 0;
  for (const type of INTERACTION_EVENTS) {
    const count = tally.counts[type] || 0;
    if (!count) continue;
    totalInteractions += count;
    distinctInteractionKinds += 1;
    score += Math.min(20, Math.round(Math.sqrt(count) * 13));
  }
  if (distinctInteractionKinds > 0) {
    factors.push({ sign: '+', text: `${distinctInteractionKinds} kind${distinctInteractionKinds === 1 ? '' : 's'} of real interaction completed (${totalInteractions} total)` });
  }

  if (tally.counts[EVENT.ROTATED_FROM]) factors.push({ sign: '+', text: 'History carried over from a rotated identity' });
  if (totalInteractions === 0) factors.push({ sign: '-', text: 'Seen, but nothing confirmed yet — no chat, meeting, or file exchange completed' });

  return { score: Math.min(100, Math.max(0, Math.round(score))), factors };
}

// Returns null (not 0) when this identity has never been observed at
// all — "no opinion yet" is a real, different state from "observed and
// found wanting", and the UI should be able to tell them apart.
export async function computeCredibility(ns, subject) {
  const dag = await loadDag(ns, subject);
  const events = dag.topoOrder();
  if (!events.length) return null;
  const tally = dag.materialize(tallyReducer, { firstSeenTs: null, counts: {} });
  return scoreFromTally(tally);
}
