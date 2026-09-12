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
        <div class="k">Coming soon <span class="role-badge" style="margin-left:6px">Soon</span></div>
        <p style="font-size:13px;color:var(--mid);line-height:1.6;margin-top:6px">
          Paid delivery for when you're <i>not</i> connected — reaching you (or
          keeping your presence alive to others) while your device is offline
          is real infrastructure work, not something two browsers can do for
          free between themselves. That tier doesn't exist yet; this page
          will be updated the moment it does, with real pricing instead of a
          placeholder.
        </p>
      </div>
    </div>
  `;
}
