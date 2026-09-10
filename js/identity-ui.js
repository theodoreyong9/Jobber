// identity-ui.js — the icon-based mode switcher, the topbar (identity
// picker when there's more than one identity in a namespace, the unified
// edit/rename pencil, and — for classic namespaces — the keyword counts
// plus Search/Enrich controls, since that's what they actually act on).
// Safely imports profiles.js directly (profiles.js has no dependency back
// on this file). Reaches discovery-ui.js only through
// `state.handlers.toggleSearchLive` / `state.handlers.rebroadcastDiscovery`
// — discovery-ui.js imports *this* file for createIdentityFlow, so a
// direct import the other way would be a real cycle. See state.js's header.

import * as identity from './identity.js';
import * as p2p from './p2p.js';
import { state, NAMESPACE_GROUPS, NS_CONFIG, roleLabel, initials, setActiveNamespace, pickActiveIdentityId } from './state.js';
import { openModal, toast } from './ui-kit.js';
import { getProfile, openProfileEditor, enrichProfileWithAI } from './profiles.js';

const MODE_ICONS = {
  employment: '💼',
  business: '🤝',
  independant: '🛠️',
  annonce: '🏷️',
  drive: '🚗',
  outdoor: '🏕️',
  dating: '💗',
  research: '🧠',
  near: '📍',
  agent: '🤖',
  creator: '🎨',
  wallet: '👛',
  tribute: '🕸️',
};

function modeIconHtml(ns) {
  const cfg = NS_CONFIG[ns];
  const isActive = ns === state.activeNamespace;
  const isLive = cfg.kind === 'near' ? state.nearLocationEnabled : !!state.searchLive[ns];
  // Near has no identity of its own (see near-ui.js), and external
  // namespaces (creator/wallet/tribute) just open another app — neither
  // needs the "no identity yet" empty-dot indicator.
  const needsIdentity = cfg.kind !== 'near' && cfg.kind !== 'external';
  const hasIdentity = needsIdentity && (state.identitiesByNs[ns] || []).some((i) => i.active);
  return `
    <button class="mode-icon ${isActive ? 'active' : ''}" data-ns="${ns}" title="${cfg.label}">
      <span class="mode-icon-glyph">${MODE_ICONS[ns] || '●'}</span>
      <span class="mode-icon-label">${cfg.label}</span>
      ${isLive ? '<span class="mode-icon-dot live"></span>' : (needsIdentity && !hasIdentity ? '<span class="mode-icon-dot empty"></span>' : '')}
    </button>`;
}

export function renderModeIcons() {
  const nav = document.getElementById('modeIcons');
  // Grouped into visually separated clusters (NAMESPACE_GROUPS) instead of
  // one flat row — thirteen icons side by side with no structure was the
  // actual problem, not any one icon's own styling.
  nav.innerHTML = NAMESPACE_GROUPS.map((group) => `
    <span class="mode-group">${group.namespaces.map(modeIconHtml).join('')}</span>
  `).join('<span class="mode-group-divider"></span>');

  nav.querySelectorAll('.mode-icon').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cfg = NS_CONFIG[btn.dataset.ns];
      // External namespaces never become the active view — they're a
      // launcher, not a mode with its own workspace/topbar to render.
      if (cfg.kind === 'external') { window.open(cfg.url, '_blank', 'noopener'); return; }
      setActiveNamespace(btn.dataset.ns);
      state.render.all();
    });
  });
}

export function createIdentityFlow(ns) {
  const cfg = NS_CONFIG[ns];
  const roleField = cfg.roles ? `
      <label for="role">Role</label>
      <select id="role">
        ${cfg.roles.map((r) => `<option value="${r.key}">${r.label}</option>`).join('')}
      </select>` : '';
  openModal(`New identity — ${cfg.label}`, `
      <label for="dn">Display name</label>
      <input type="text" id="dn" placeholder="e.g. Alex Kade" autofocus>
      ${roleField}
    `, {
    submitLabel: 'Create identity',
    onSubmit: async (dlg) => {
      const name = dlg.querySelector('#dn').value.trim() || 'Unnamed';
      const role = cfg.roles ? dlg.querySelector('#role').value : null;
      const rec = await identity.createIdentity(ns, name, role);
      state.identitiesByNs[ns] = await identity.listIdentities(ns);
      setActiveNamespace(ns);
      state.activeIdentityId[ns] = rec.identityId;
      toast(`Identity #${rec.identityId} created for ${cfg.label}${role ? ' (' + roleLabel(ns, role) + ')' : ''}`);
      state.render.all();
    },
  });
}

export async function renderTopbar() {
  const ns = state.activeNamespace;
  const who = document.getElementById('topbarWho');
  const controls = document.getElementById('topbarControls');

  if (!ns) {
    who.innerHTML = `<div class="name">Welcome to Jobber</div>`;
    controls.innerHTML = '';
    return;
  }

  const cfg = NS_CONFIG[ns];

  if (cfg.kind === 'near') {
    who.innerHTML = `<div class="name">Near</div><div class="sub" style="color:var(--low);font-size:11.5px">Location is opt-in, set below — no identity needed here.</div>`;
    controls.innerHTML = '';
    return;
  }

  const list = state.identitiesByNs[ns].filter((i) => i.active);
  const id = list.find((i) => i.identityId === state.activeIdentityId[ns]);

  if (!id) {
    who.innerHTML = `<div class="name">No identity in ${cfg.label} yet</div>`;
    controls.innerHTML = `<button class="btn primary" id="quickCreate">Create identity</button>`;
    document.getElementById('quickCreate').addEventListener('click', () => createIdentityFlow(ns));
    return;
  }

  // A native <select> for the identity picker rather than a custom
  // dropdown — renders as a proper picker on mobile with zero extra JS.
  // Options list names only, not "name · #id" — the id pill right next to
  // it already shows the id, so repeating it inside every option was the
  // actual overload, not the pill itself.
  const picker = list.length > 1 ? `
    <select id="identityPicker" title="Switch identity">
      ${list.map((i) => `<option value="${i.identityId}" ${i.identityId === id.identityId ? 'selected' : ''}>${i.displayName}</option>`).join('')}
    </select>` : '';

  who.innerHTML = `
    <span class="avatar" style="background:${cfg.color}">${initials(id.displayName)}</span>
    <div>
      <div class="name">${id.displayName}</div>
      <div class="sub">
        ${id.role ? `<span class="pill role">${roleLabel(ns, id.role)}</span>` : ''}
        <span class="pill">#${id.identityId}</span>
        ${picker}
        <button class="edit-profile-btn" data-act="edit" title="${cfg.kind === 'research' || cfg.kind === 'agent' ? 'Rename' : 'Edit name & profile'}">✎ ${cfg.kind === 'research' || cfg.kind === 'agent' ? 'Rename' : 'Edit profile'}</button>
        <span class="idbtns">
          <button data-act="new" title="New identity in ${cfg.label}">+</button>
          <button data-act="rotate" title="Rotate (replace this key, keep the name)">⟲</button>
          <button data-act="retire" title="Retire this identity">⨯</button>
        </span>
      </div>
    </div>`;

  who.querySelector('[data-act=new]').addEventListener('click', () => createIdentityFlow(ns));
  who.querySelector('[data-act=edit]').addEventListener('click', () => {
    if (cfg.kind === 'research' || cfg.kind === 'agent') renameFlow(id);
    else openProfileEditor(ns, id);
  });
  who.querySelector('[data-act=rotate]').addEventListener('click', () => rotateFlow(id));
  who.querySelector('[data-act=retire]').addEventListener('click', () => retireFlow(id));
  who.querySelector('#identityPicker')?.addEventListener('change', (e) => {
    state.activeIdentityId[ns] = e.target.value;
    state.render.all();
  });

  if (cfg.kind === 'research') {
    controls.innerHTML = `<div class="switchctl">Human-in-the-loop <button class="switch on" id="hitl"></button></div>`;
    document.getElementById('hitl').addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));
    return;
  }
  if (cfg.kind === 'agent') {
    controls.innerHTML = ''; // prototype — nothing to control yet
    return;
  }

  await renderSearchAndEnrichControls(ns, id, cfg, controls);
}

// Keyword counts, Search live, and Enrich with local AI used to live in a
// separate "Your profile" panel in the workspace — moved up here, right
// next to the identity actions they actually relate to, instead of a
// second disconnected place to look. Not exported: nothing outside this
// file's topbar needs it.
async function renderSearchAndEnrichControls(ns, id, cfg, controls) {
  const profile = await getProfile(id.identityId);
  const isLive = !!state.searchLive[ns];
  const lookingForCount = cfg.kind === 'reciprocal' ? (profile.searchTokens || []).length : null;
  // tokens is populated by every profile editor as soon as there's
  // anything to match on (category, CV, job posting, description...) — an
  // empty array means "nothing entered yet", the same signal across every
  // namespace kind. Going live with nothing to broadcast wastes a P2P
  // connection and produces meaningless matches, so it's blocked here
  // rather than silently allowed and only failing to matter once results
  // come back empty.
  const profileEmpty = !isLive && profile.tokens.length === 0;

  controls.innerHTML = `
    <span class="chip">${profile.tokens.length} words</span>
    <span class="chip ai">◆ ${profile.aiTokens.length} AI</span>
    ${lookingForCount !== null ? `<span class="chip" style="border-color:var(--agent);color:var(--agent)">${lookingForCount} looking-for</span>` : ''}
    <button class="btn ${isLive ? 'small ghost' : 'primary'}" id="toggleSearch" ${profileEmpty ? 'disabled' : ''} title="${isLive ? 'Stop searching' : profileEmpty ? 'Complete your profile first — add a category, CV, or posting text' : 'Start searching'}">${isLive ? '■' : 'Search'}</button>
    <button class="btn ${profile.aiTokens.length ? 'success' : ''}" id="enrichAI">${profile.aiTokens.length ? `Enriched — ${profile.aiTokens.length}` : 'Enrich with local AI'}</button>
  `;

  controls.querySelector('#toggleSearch').addEventListener('click', () => state.handlers.toggleSearchLive(ns));
  controls.querySelector('#enrichAI').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.classList.remove('success');
    btn.textContent = 'Starting…';
    try {
      const extra = await enrichProfileWithAI(ns, id, (p) => {
        // WebLLM's progress callback reports model *loading* (download +
        // compile), not per-token inference — inference itself is fast
        // enough on a 135M model that a spinner-style label is enough.
        if (typeof p.progress === 'number' && p.progress < 1) {
          btn.textContent = `Loading model… ${Math.round(p.progress * 100)}%`;
        } else {
          btn.textContent = 'Thinking…';
        }
      });
      if (extra === null) { btn.textContent = original; return; } // handled case, already toasted
      toast(`Added ${extra.length} AI-derived keywords.`);
      if (state.searchLive[ns]) await state.handlers.rebroadcastDiscovery(ns); // update anyone already connected, not just future joiners
      state.render.workspace();
      state.render.topbar(); // refresh the counts and the green state
    } catch (err) {
      toast('Local AI failed: ' + err.message);
      btn.textContent = original;
    } finally {
      btn.disabled = false;
    }
  });
}

function renameFlow(id) {
  openModal('Rename identity', `<label>Display name</label><input type="text" id="rn" value="${id.displayName}">`, {
    submitLabel: 'Save',
    onSubmit: async (dlg) => {
      await identity.renameIdentity(id.identityId, dlg.querySelector('#rn').value.trim() || id.displayName);
      state.identitiesByNs[id.namespace] = await identity.listIdentities(id.namespace);
      state.render.all();
    },
  });
}

function rotateFlow(id) {
  openModal('Rotate identity', `<p style="font-size:12.5px;color:var(--mid)">A fresh keypair will be generated with the same name. The old id (#${id.identityId}) will be marked retired, and connected peers on this namespace will receive an <code>identity_retired</code> message.</p>`, {
    submitLabel: 'Rotate',
    onSubmit: async () => {
      const fresh = await identity.rotateIdentity(id.identityId);
      const room = p2p.getRoom(id.namespace);
      if (room) room.send('identity_retired', fresh.identityId, { retiredId: id.identityId, rotatedTo: fresh.identityId });
      state.identitiesByNs[id.namespace] = await identity.listIdentities(id.namespace);
      state.activeIdentityId[id.namespace] = fresh.identityId;
      toast(`Rotated to #${fresh.identityId}`);
      state.render.all();
    },
  });
}

function retireFlow(id) {
  openModal('Retire identity', `<p style="font-size:12.5px;color:var(--mid)">This marks #${id.identityId} inactive. It stays visible in your history. This is local only — it can't force other peers to forget a previously seen id.</p>`, {
    submitLabel: 'Retire',
    onSubmit: async () => {
      await identity.retireIdentity(id.identityId);
      state.identitiesByNs[id.namespace] = await identity.listIdentities(id.namespace);
      state.activeIdentityId[id.namespace] = pickActiveIdentityId(state.identitiesByNs[id.namespace]);
      state.render.all();
    },
  });
}
