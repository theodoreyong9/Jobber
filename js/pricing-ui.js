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
// shows attached without you doing anything. `price` is indicative only,
// hence the "~" — never presented as a locked-in number.
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

      <h3 class="section-title" style="font-size:14px;margin-top:22px;margin-bottom:10px">How does it work?</h3>
      <div class="pricing-steps">
        <div class="pricing-step">
          <span class="pricing-step-num">1</span>
          <div>
            <div class="pricing-step-title">Create your identity</div>
            <div class="pricing-step-body">No account. Keep your browser, or back up your private key.</div>
          </div>
        </div>
        <div class="pricing-step">
          <span class="pricing-step-num">2</span>
          <div>
            <div class="pricing-step-title">Choose your capabilities</div>
            <div class="pricing-step-body">Free or paid, with automatic renewal for paid capabilities.</div>
          </div>
        </div>
        <div class="pricing-step">
          <span class="pricing-step-num">3</span>
          <div>
            <div class="pricing-step-title">Use Jobber</div>
            <div class="pricing-step-body">Your identity and capabilities follow you — no central customer account.</div>
          </div>
        </div>
      </div>
      <p class="pricing-warning">Important: if you lose your private key and your local data, your identity can't be recovered.</p>

      <div style="margin-top:18px;display:flex;flex-direction:column;gap:10px">
        ${products.join('')}
      </div>
    </div>
  `;
}
