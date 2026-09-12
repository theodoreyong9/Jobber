// pricing-ui.js — a static page about what Jobber costs, and why. No
// identity, no profile, no P2P: it doesn't read any live state at all,
// unlike near/agent/messages which at least read what other identities
// discovered. Kept as its own module anyway, matching the rest of the
// app's one-file-per-feature-area convention.

export async function renderPricingWorkspace() {
  return `
    <div class="panel" style="max-width:640px;margin:20px auto">
      <h2 class="section-title" style="margin-bottom:6px">Pricing</h2>
      <p class="section-sub">What Jobber costs, and why.</p>

      <div style="margin-top:18px">
        <div class="k">Free while you're connected</div>
        <p style="font-size:13px;color:var(--mid);line-height:1.6;margin-top:6px">
          Jobber has no backend and no server to pay for — discovery, matching,
          chat, meeting proposals, and document/file exchange all happen
          directly between browsers over real WebRTC. There's no relay in the
          middle doing work on your behalf, so there's nothing to charge for
          on that path. As long as you're online and reachable, every feature
          here stays free.
        </p>
      </div>

      <div style="margin-top:18px">
        <div class="k">Coming soon</div>
        <p style="font-size:13px;color:var(--mid);line-height:1.6;margin-top:6px">
          Each of these costs something real to run — relay infrastructure,
          chain fees, or cloud compute — unlike the free P2P path above,
          where two browsers just talk directly and there's nothing to
          charge for. None of them exist yet; this page will be updated
          with real pricing the moment each one ships.
        </p>

        <div style="margin-top:14px;display:flex;flex-direction:column;gap:14px">
          <div>
            <div style="font-size:12.5px;color:var(--hi)"><b>Gossip</b> <span class="role-badge" style="margin-left:6px">Soon</span></div>
            <p style="font-size:12.5px;color:var(--mid);line-height:1.5;margin-top:4px">
              P2P persistence — peers relay and hold messages for you while
              you're offline, instead of both sides needing to be online at
              once the way it works today.
            </p>
          </div>
          <div>
            <div style="font-size:12.5px;color:var(--hi)"><b>AIWA</b> <span class="role-badge" style="margin-left:6px">Soon</span></div>
            <p style="font-size:12.5px;color:var(--mid);line-height:1.5;margin-top:4px">
              DAG persistence — the same event-DAG primitives already behind
              Credibility (see <a href="https://theodoreyong9.github.io/AIWA_chain/" target="_blank" rel="noopener">AIWA</a>),
              extended into a durable, chain-anchored layer for data that
              needs to outlive any one browser tab.
            </p>
          </div>
          <div>
            <div style="font-size:12.5px;color:var(--hi)"><b>Booster AI</b> <span class="role-badge" style="margin-left:6px">Soon</span></div>
            <p style="font-size:12.5px;color:var(--mid);line-height:1.5;margin-top:4px">
              A larger, cloud-hosted model for profile enrichment, for when
              the free local model (which runs entirely on your own device)
              isn't enough.
            </p>
          </div>
          <div>
            <div style="font-size:12.5px;color:var(--hi)"><b>Agent Booster</b> <span class="role-badge" style="margin-left:6px">Soon</span></div>
            <p style="font-size:12.5px;color:var(--mid);line-height:1.5;margin-top:4px">
              A deeper, more thorough pass of Agent's cross-namespace
              matching — and eventually, Agent acting on opportunities on
              your behalf instead of only surfacing them.
            </p>
          </div>
        </div>
      </div>
    </div>
  `;
}
