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
//
// SECURITY NOTE for whoever wires up that checkout flow later: everything
// in this file lives in the user's own browser, so hasProduct()/the
// `products` array can never be trusted by anyone but this browser
// itself — the user can always call attachProduct() from devtools (or a
// worker, or any other code running on their own machine) and grant
// themselves a product for free. That's not a bug here, and it isn't
// fixable here: no code running entirely on someone's own device can ever
// prove anything to a party that doesn't already trust that device.
// It's fine for Free (nothing to steal). It matters for the other four
// because each one spends a real resource that belongs to someone else —
// Gossip spends a relay peer's bandwidth, AIWA spends a chain-anchoring
// fee, Booster AI/Agent Booster spend cloud compute — so the actual
// checkout enforcement has to live wherever that resource is spent, not
// here: the relay peer verifies a payment receipt before agreeing to
// relay for you, the chain only accepts an anchor with a real transaction
// behind it, the cloud endpoint validates a real auth token server-side
// before running the model. `hasProduct()` stays exactly what it is
// today — a local UI signal for "should this browser show itself as
// unlocked" — never the thing a peer, a chain, or a cloud service relies
// on to decide whether to do the work.

import * as identity from './identity.js';

// `price` is per month, in whole dollars, `null` for Free (nothing to
// charge). Explicitly indicative, not a real number anyone can check out
// at yet — see pricing-ui.js, which labels it as such rather than
// presenting it as a locked-in price.
export const PRODUCTS = [
  { id: 'free', name: 'Free (Connected)', shipped: true, icon: '🌐', color: '#2FBF71', price: null,
    body: `Discovery, chat, meetings, and files travel directly between browsers over WebRTC — free
           forever, for every identity in this browser.` },
  { id: 'gossip', name: 'Gossip', shipped: false, icon: '📡', color: '#4DD0E1', price: 1,
    body: `Peers relay and hold your messages while you're offline.` },
  { id: 'aiwa', name: 'AIWA', shipped: false, icon: '⛓️', color: '#5B6EE8', price: 2,
    body: `Chain-anchored persistence, so your data outlives one browser tab — same primitives as
           Credibility, see <a href="https://theodoreyong9.github.io/AIWA_chain/" target="_blank" rel="noopener">AIWA</a>.` },
  { id: 'boosterAi', name: 'Booster AI', shipped: false, icon: '🧠', color: '#9B8AFB', price: 3,
    body: `A bigger, cloud-hosted model for profile enrichment, when the free local one isn't enough.` },
  { id: 'agentBooster', name: 'Agent Booster', shipped: false, icon: '🤖', color: '#F0A830', price: 4,
    body: `Deeper cross-namespace matching — eventually Agent acting for you, not just surfacing.` },
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
