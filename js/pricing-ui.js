// pricing-ui.js — a static page about what Jobber costs, and why. No
// identity, no profile, no P2P: it doesn't read any live state at all,
// unlike near/agent/messages which at least read what other identities
// discovered. Kept as its own module anyway, matching the rest of the
// app's one-file-per-feature-area convention.

// Every tier gets the same card shape — name, a status badge, and one
// paragraph on what it actually costs (or doesn't) and why. Keeping Free
// in this same list, instead of as separate intro prose above it, is
// deliberate: it's a tier like the other four, not a preamble to them.
function tierHtml(name, badgeClass, badgeLabel, body) {
  return `
    <div>
      <div style="font-size:12.5px;color:var(--hi)"><b>${name}</b> <span class="${badgeClass}" style="margin-left:6px">${badgeLabel}</span></div>
      <p style="font-size:12.5px;color:var(--mid);line-height:1.5;margin-top:4px">${body}</p>
    </div>`;
}

export async function renderPricingWorkspace() {
  const tiers = [
    tierHtml('Free (Connected)', 'tier-badge tier-badge-free', 'Free',
      `Jobber has no backend and no server to pay for — discovery, matching, chat, meeting
       proposals, and document/file exchange all happen directly between browsers over real
       WebRTC. There's no relay in the middle doing work on your behalf, so there's nothing to
       charge for on that path. As long as you're online and reachable, every feature here
       stays free.`),
    tierHtml('Gossip', 'role-badge', 'Soon',
      `P2P persistence — peers relay and hold messages for you while you're offline, instead of
       both sides needing to be online at once the way it works today.`),
    tierHtml('AIWA', 'role-badge', 'Soon',
      `DAG persistence — the same event-DAG primitives already behind Credibility (see
       <a href="https://theodoreyong9.github.io/AIWA_chain/" target="_blank" rel="noopener">AIWA</a>),
       extended into a durable, chain-anchored layer for data that needs to outlive any one
       browser tab.`),
    tierHtml('Booster AI', 'role-badge', 'Soon',
      `A larger, cloud-hosted model for profile enrichment, for when the free local model
       (which runs entirely on your own device) isn't enough.`),
    tierHtml('Agent Booster', 'role-badge', 'Soon',
      `A deeper, more thorough pass of Agent's cross-namespace matching — and eventually, Agent
       acting on opportunities on your behalf instead of only surfacing them.`),
  ].join('');

  return `
    <div class="panel" style="max-width:640px;margin:20px auto">
      <h2 class="section-title" style="margin-bottom:6px">Pricing</h2>
      <p class="section-sub">What Jobber costs, and why.</p>

      <p style="font-size:12.5px;color:var(--low);line-height:1.5;margin-top:14px">
        Only the first tier below exists today. The other four cost something real to run —
        relay infrastructure, chain fees, or cloud compute — unlike the free P2P path, where two
        browsers just talk directly. This page will be updated with real pricing the moment each
        one ships.
      </p>

      <div style="margin-top:14px;display:flex;flex-direction:column;gap:14px">
        ${tiers}
      </div>
    </div>
  `;
}
