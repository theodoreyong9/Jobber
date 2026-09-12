// products.js — the actual attach system behind Pricing. There's no
// account here, so a product can't be "on your account" the way it would
// be anywhere else — it's attached to this browser's one local identity
// store instead (see state.js's header for the same reasoning behind
// Credibility). Attaching a product therefore isn't scoped to one
// identity: every identity you use in this browser sees the same set of
// attached products, since this local IndexedDB instance already *is*
// "you" — there's no separate account to link several identities
// through. Cumulative (you can hold several different products at once)
// and idempotent (attaching one you already have is a no-op) — a Set is
// exactly this shape, so that's what backs it.
//
// Free is the live proof the system works today, not a special case of
// it: identity-ui.js's createIdentityFlow calls attachProduct('free')
// the same way it would for any real purchase, the very first time you
// ever create an identity. The other four aren't purchasable yet (see
// pricing-ui.js) — attachProduct exists and works for them too, there's
// just no checkout flow wired up to call it.

import * as db from './db.js';

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

const CACHE_KEY = 'ownedProducts';
let cachedOwned = null;

async function loadOwned() {
  if (cachedOwned) return cachedOwned;
  const row = await db.get('cache', CACHE_KEY);
  cachedOwned = new Set(row?.value || []);
  return cachedOwned;
}

export async function attachProduct(productId) {
  const owned = await loadOwned();
  if (owned.has(productId)) return; // idempotent — already attached, nothing to do
  owned.add(productId);
  await db.put('cache', { key: CACHE_KEY, value: [...owned] });
}

export async function hasProduct(productId) {
  return (await loadOwned()).has(productId);
}

export async function ownedProducts() {
  return [...(await loadOwned())];
}
