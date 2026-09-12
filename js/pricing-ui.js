// pricing-ui.js — a page about what Jobber costs, and why. No identity
// picker, no P2P: it reads products.js's attach system (see there for
// what "attached" actually means with no account to scope it to), but
// nothing else — unlike near/agent/messages which at least read what
// other identities discovered.

import { PRODUCTS, hasProduct } from './products.js';

// Each product is a real button, styled the same way the Bureau's own
// tiles are (a color-tinted glass surface with the product's own emoji
// oversized in the background, see .product-bg-icon) — one consistent
// visual language for "a thing in this app", not a plain bordered box.
// Not a purchase flow yet (none of the four unshipped ones have one, and
// Free needs no action from you at all), but the right affordance for
// the day one does exist — `disabled` on all of them for now. The status
// pill is what actually distinguishes "already yours" (Free) from "not
// yet buyable" (the other four) — see products.js's header for why Free
// shows attached without you doing anything. `price` is indicative only
// (see the disclaimer below it) — never presented as a locked-in number.
function productHtml({ id, name, icon, color, price, body }, attached) {
  const priceLabel = price == null ? '' : `<span class="product-price">~$${price}<span class="product-price-unit">/mo</span></span>`;
  return `
    <button type="button" class="product-btn" style="--tile-color:${color}" disabled>
      <span class="product-bg-icon" aria-hidden="true">${icon}</span>
      <div class="product-head">
        <span class="product-icon-chip">${icon}</span>
        <span class="product-name">${name}</span>
        <span class="product-status ${attached ? 'attached' : 'soon'}">${attached ? 'Attached' : 'Soon'}</span>
      </div>
      <p class="product-body">${body}</p>
      ${priceLabel}
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
        browsers just talk directly. The prices below are indicative — a rough sense of scale,
        not a locked-in number — and this page will be updated with the real ones, and a real way
        to buy them, the moment each product ships.
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
