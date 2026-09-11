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
  discover: '🧭',
  contribute: '🖋️',
  wallet: '👛',
  tribute: '🌐',
};

function modeSwitcherItemHtml(ns) {
  const cfg = NS_CONFIG[ns];
  const isActive = ns === state.activeNamespace;
  const isLive = cfg.kind === 'near' ? state.nearLocationEnabled : !!state.searchLive[ns];
  // Near has no identity of its own (see near-ui.js), and external
  // namespaces (creator/wallet/tribute) just open another app — neither
  // needs the "no identity yet" empty-dot indicator.
  const needsIdentity = cfg.kind !== 'near' && cfg.kind !== 'external';
  const hasIdentity = needsIdentity && (state.identitiesByNs[ns] || []).some((i) => i.active);
  return `
    <button class="mode-switcher-item ${isActive ? 'active' : ''}" data-ns="${ns}">
      <span class="mode-switcher-item-glyph">${MODE_ICONS[ns] || '●'}</span>
      <span class="mode-switcher-item-label">${cfg.label}</span>
      ${isLive ? '<span class="mode-icon-dot live"></span>' : (needsIdentity && !hasIdentity ? '<span class="mode-icon-dot empty"></span>' : '')}
    </button>`;
}

// A single always-visible "current mode" button that opens a dropdown
// listing every mode with its icon *and* name, grouped under a caption —
// not a permanently-visible grid of icons, which is what actually didn't
// fit/read well on a phone no matter how it was arranged. Built on a
// native <details>/<summary> disclosure, the same pattern already used by
// the status bar's ⚙ storage/backup panel — no custom open/close JS needed
// for the toggle itself, just closing it again on selection.
export function renderModeIcons() {
  const nav = document.getElementById('modeIcons');
  const activeCfg = state.activeNamespace ? NS_CONFIG[state.activeNamespace] : null;
  const currentGlyph = activeCfg ? (MODE_ICONS[state.activeNamespace] || '●') : '☰';
  const currentLabel = activeCfg ? activeCfg.label : 'Choose a mode';

  nav.innerHTML = `
    <details class="mode-switcher">
      <summary class="mode-switcher-current">
        <span class="mode-switcher-item-glyph">${currentGlyph}</span>
        <span>${currentLabel}</span>
        <span class="mode-switcher-chevron">▾</span>
      </summary>
      <div class="mode-switcher-panel">
        ${NAMESPACE_GROUPS.map((group) => `
          <div class="mode-switcher-group">
            <div class="mode-switcher-group-label">${group.label}</div>
            ${group.namespaces.map(modeSwitcherItemHtml).join('')}
          </div>
        `).join('')}
      </div>
    </details>`;

  const details = nav.querySelector('.mode-switcher');
  nav.querySelectorAll('.mode-switcher-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      details.removeAttribute('open');
      const cfg = NS_CONFIG[btn.dataset.ns];
      // External namespaces never become the active view — they're a
      // launcher, not a mode with its own workspace/topbar to render.
      if (cfg.kind === 'external') { window.open(cfg.url, '_blank', 'noopener'); return; }
      setActiveNamespace(btn.dataset.ns);
      state.render.all();
    });
  });
}

// Registered once, not per-render: closes the dropdown on any click
// outside it. Native <details> only toggles on its own <summary>, so
// without this it would stay open until the next unrelated re-render
// happened to wipe modeIcons' innerHTML.
document.addEventListener('click', (e) => {
  const details = document.querySelector('.mode-switcher[open]');
  if (details && !details.contains(e.target)) details.removeAttribute('open');
});

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

  // A native <select> for the identity picker, always shown — it already
  // says the name (as its selected option), so a separate name line next
  // to it was just repeating the same information twice. Only child in
  // the list is still a picker with one option, not special-cased away:
  // one fewer element type to keep in sync when an identity gets added.
  const picker = `
    <select id="identityPicker" class="identity-picker-main" title="Switch identity">
      ${list.map((i) => `<option value="${i.identityId}" ${i.identityId === id.identityId ? 'selected' : ''}>${i.displayName}</option>`).join('')}
    </select>`;

  who.innerHTML = `
    <span class="avatar" style="background:${cfg.color}">${initials(id.displayName)}</span>
    <div>
      ${picker}
      <div class="sub">
        ${id.role ? `<span class="pill role">${roleLabel(ns, id.role)}</span>` : ''}
        <span class="pill">#${id.identityId}</span>
        <span class="idbtns">
          <button data-act="new" title="New identity in ${cfg.label}">+</button>
          <button data-act="rotate" title="Rotate (replace this key, keep the name)">⟲</button>
          <button data-act="retire" title="Retire this identity">⨯</button>
        </span>
        <button class="edit-profile-btn" data-act="edit" title="${cfg.kind === 'research' || cfg.kind === 'agent' ? 'Rename' : 'Edit name & profile'}">✎ ${cfg.kind === 'research' || cfg.kind === 'agent' ? 'Rename' : 'Edit profile'}</button>
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

// Search live and Enrich with local AI used to live in a separate "Your
// profile" panel in the workspace — moved up here, right next to the
// identity actions they actually relate to. Not exported: nothing outside
// this file's topbar needs it.
//
// There's no "Start searching" button: profiles.js's save handlers start
// or refresh the live broadcast automatically on every edit (see
// editProfileFlow etc.) — the only manual action left here is stopping it.
async function renderSearchAndEnrichControls(ns, id, cfg, controls) {
  const profile = await getProfile(id.identityId);
  const isLive = !!state.searchLive[ns];

  controls.innerHTML = `
    ${isLive ? `<button class="btn small ghost" id="stopSearch" title="Stop searching">■ Stop</button>` : ''}
    <button class="btn ${profile.aiTokens.length ? 'success' : ''}" id="enrichAI">${profile.aiTokens.length ? `Enriched — ${profile.aiTokens.length}` : 'Enrich with local AI'}</button>
  `;

  controls.querySelector('#stopSearch')?.addEventListener('click', () => state.handlers.toggleSearchLive(ns));

  const enrichBtn = controls.querySelector('#enrichAI');
  enrichBtn.addEventListener('click', () => {
    if (enrichBtn.dataset.running === '1') return;
    const original = enrichBtn.textContent;
    enrichBtn.dataset.running = '1';
    enrichBtn.classList.remove('success');
    enrichBtn.disabled = true;
    enrichBtn.textContent = 'Starting…';

    // This can only stop the app from *acting* on the result — WebLLM's
    // engine load/inference has no cancellation hook exposed here, so the
    // model keeps loading in the background even after Stop. What matters
    // is not leaving someone stuck staring at an unresponsive button.
    const cancelled = { value: false };
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn ghost small';
    stopBtn.style.marginLeft = '6px';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', () => {
      cancelled.value = true;
      stopBtn.remove();
      enrichBtn.disabled = false;
      delete enrichBtn.dataset.running;
      enrichBtn.textContent = original;
    });
    enrichBtn.after(stopBtn);

    (async () => {
      try {
        const extra = await enrichProfileWithAI(ns, id, (p) => {
          if (cancelled.value) return;
          // WebLLM's progress callback reports model *loading* (download +
          // compile), not per-token inference — inference itself is fast
          // enough on a 135M model that a spinner-style label is enough.
          if (typeof p.progress === 'number' && p.progress < 1) {
            enrichBtn.textContent = `Loading model… ${Math.round(p.progress * 100)}%`;
          } else {
            enrichBtn.textContent = 'Thinking…';
          }
        });
        if (cancelled.value) return; // Stop already reset the UI
        stopBtn.remove();
        if (extra === null) { enrichBtn.textContent = original; return; } // handled case, already toasted
        toast(`Added ${extra.length} AI-derived keywords.`);
        if (state.searchLive[ns]) await state.handlers.rebroadcastDiscovery(ns); // update anyone already connected, not just future joiners
        state.render.workspace();
        state.render.topbar();
      } catch (err) {
        if (cancelled.value) return;
        stopBtn.remove();
        toast('Local AI failed: ' + err.message);
        enrichBtn.textContent = original;
      } finally {
        if (!cancelled.value) {
          enrichBtn.disabled = false;
          delete enrichBtn.dataset.running;
        }
      }
    })();
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
