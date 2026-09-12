// pricing-ui.js — a page about what Jobber costs, and why. No identity
// picker, no P2P: it reads products.js's attach system (see there for
// what "attached" actually means with no account to scope it to), but
// nothing else — unlike near/agent/messages which at least read what
// other identities discovered.

import { PRODUCTS, hasProduct } from './products.js';

// Each product is a real button — not a purchase flow yet (none of the
// four unshipped ones have one, and Free needs no action from you at
// all), but the right affordance for the day one does exist. `disabled`
// on all of them for now; the status pill is what actually distinguishes
// "already yours" (Free) from "not yet buyable" (the other four) — see
// products.js's header for why Free shows attached without you doing
// anything.
function productHtml({ id, name, body }, attached) {
  return `
    <button type="button" class="product-btn" disabled>
      <div class="product-head">
        <span class="product-name">${name}</span>
        <span class="product-status ${attached ? 'attached' : 'soon'}">${attached ? 'Attached' : 'Soon'}</span>
      </div>
      <p class="product-body">${body}</p>
    </button>`;
}

export async function renderPricingWorkspace() {
  const products = await Promise.all(PRODUCTS.map(async (p) => productHtml(p, await hasProduct(p.id))));

  return `
    <div class="panel" style="max-width:640px;margin:20px auto">
      <h2 class="section-title" style="margin-bottom:6px">Pricing</h2>
      <p class="section-sub">What Jobber costs, and why.</p>

      <p style="font-size:12.5px;color:var(--low);line-height:1.5;margin-top:14px">
        Only Free is real today. The other four cost something real to run — relay
        infrastructure, chain fees, or cloud compute — unlike the free P2P path, where two
        browsers just talk directly. This page will be updated with real pricing, and a real way
        to buy them, the moment each one ships.
      </p>

      <p style="font-size:12.5px;color:var(--low);line-height:1.5;margin-top:10px">
        "Attached" below is just this browser's own local record, not a verified purchase —
        Jobber has no account or server to check one against. That's harmless for Free. For the
        other four, once they're real, the actual check won't live on this page at all: it'll sit
        wherever the cost actually lands — the peer relaying for you, the chain being anchored to,
        or the cloud service running the model — the same way nothing here can be trusted to prove
        anything to anyone but this browser itself.
      </p>

      <div style="margin-top:14px;display:flex;flex-direction:column;gap:10px">
        ${products.join('')}
      </div>
    </div>
  `;
}
