// products.js — the actual attach system behind Pricing. There's no
// account here, so a product can't be "on your account" the way it would
// be anywhere else — instead, each *identity* record carries its own
// `products` list (see identity.js), and this file's whole job is
// keeping every identity's list in sync with the union of everything any
// of them has ever been attached: attach a product via one identity, and
// it propagates to every other identity in this browser too, and vice
// versa. Cumulative (several different products at once) and idempotent
// (attaching one you already have, or re-syncing, is a no-op) — a Set
// union is exactly this shape.
//
// Storing it on the identity record itself, not a separate browser-wide
// key, is what makes this survive backup/restore (see backup.js):
// identity.exportIdentityRecord/importIdentityRecord already carry
// `products` through, so restoring a backup elsewhere — or on top of
// identities that already exist here — brings the products along and
// syncAllIdentities() (called after every import) merges them into
// everyone, both directions, without duplicates (Set semantics). A
// deleted identity just takes its own copy down with it — the product
// isn't "revoked" from the browser, every surviving identity still has
// its own copy.
//
// Free is the live proof the system works today, not a special case of
// it: identity-ui.js's createIdentityFlow calls attachProduct('free')
// the same way it would for any real purchase, the very first time you
// ever create an identity. The other four aren't purchasable yet (see
// pricing-ui.js) — attachProduct exists and works for them too, there's
// just no checkout flow wired up to call it.

import * as identity from './identity.js';

export const PRODUCTS = [
  { id: 'free', name: 'Free (Connected)', shipped: true,
    body: `Jobber has no backend and no server to pay for — discovery, matching, chat, meeting
           proposals, and document/file exchange all happen directly between browsers over real
           WebRTC. There's no relay in the middle doing work on your behalf, so there's nothing to
           charge for on that path. Attached automatically the moment you create your first
           identity — every identity you use in this browser gets it for free, always.` },
  { id: 'gossip', name: 'Gossip', shipped: false,
    body: `P2P persistence — peers relay and hold messages for you while you're offline, instead of
           both sides needing to be online at once the way it works today.` },
  { id: 'aiwa', name: 'AIWA', shipped: false,
    body: `DAG persistence — the same event-DAG primitives already behind Credibility (see
           <a href="https://theodoreyong9.github.io/AIWA_chain/" target="_blank" rel="noopener">AIWA</a>),
           extended into a durable, chain-anchored layer for data that needs to outlive any one
           browser tab.` },
  { id: 'boosterAi', name: 'Booster AI', shipped: false,
    body: `A larger, cloud-hosted model for profile enrichment, for when the free local model
           (which runs entirely on your own device) isn't enough.` },
  { id: 'agentBooster', name: 'Agent Booster', shipped: false,
    body: `A deeper, more thorough pass of Agent's cross-namespace matching — and eventually, Agent
           acting on opportunities on your behalf instead of only surfacing them.` },
];

// Recomputed from the identity records every time rather than cached —
// they're the one source of truth (that's what makes backup/restore just
// work), and the identity cap (credibility.js) keeps this list small
// enough that re-listing it is never a real cost.
async function currentUnion() {
  const all = await identity.listIdentities();
  const union = new Set();
  for (const rec of all) for (const p of rec.products || []) union.add(p);
  return union;
}

async function writeUnionToAll(union) {
  const all = await identity.listIdentities();
  const arr = [...union];
  for (const rec of all) {
    const current = rec.products || [];
    const alreadySynced = current.length === arr.length && current.every((p) => union.has(p));
    if (!alreadySynced) await identity.setProducts(rec.identityId, arr);
  }
}

export async function attachProduct(productId) {
  const union = await currentUnion();
  union.add(productId);
  await writeUnionToAll(union);
}

// Re-spreads the current union to every identity without adding anything
// new — the other half of attachProduct's job, needed after a backup
// import brings in identities whose own products this browser didn't
// have yet (or that were missing ones this browser already had).
export async function syncAllIdentities() {
  await writeUnionToAll(await currentUnion());
}

export async function hasProduct(productId) {
  return (await currentUnion()).has(productId);
}

export async function ownedProducts() {
  return [...(await currentUnion())];
}
