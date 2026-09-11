// identity-ui.js — the topbar (identity picker, the unified edit/rename
// pencil, and — for classic namespaces — the Search/Enrich controls, since
// that's what they actually act on) and the create-identity flow. Safely
// imports profiles.js directly (profiles.js has no dependency back on this
// file). Reaches discovery-ui.js only through `state.handlers.toggleSearchLive`
// / `state.handlers.rebroadcastDiscovery` — discovery-ui.js imports *this*
// file for createIdentityFlow, so a direct import the other way would be a
// real cycle. See state.js's header.
//
// Picking *which mode* an identity belongs to no longer happens here — the
// Bureau (desktop-ui.js) is where that decision gets made, before this
// flow ever opens; it just names (and roles) whatever ns it's handed. It's
// still called directly with a fixed ns for "add another identity in this
// same mode" (the topbar's + button, below).

import * as identity from './identity.js';
import * as p2p from './p2p.js';
import { state, NS_CONFIG, roleLabel, initials, setActiveNamespace, pickActiveIdentityId } from './state.js';
import { openModal, toast } from './ui-kit.js';
import { getProfile, openProfileEditor, enrichProfileWithAI } from './profiles.js';

// Two-sided namespaces cap at one *active* identity per role — a
// namespace's roles are fixed slots (Candidate, Recruiter, …), not a list
// you can pile identities into. Retiring one frees its role back up.
function takenRoles(ns) {
  return new Set((state.identitiesByNs[ns] || []).filter((i) => i.active && i.role).map((i) => i.role));
}

export function createIdentityFlow(ns) {
  const cfg = NS_CONFIG[ns];
  let roles = cfg.roles;
  if (roles) {
    const taken = takenRoles(ns);
    roles = roles.filter((r) => !taken.has(r.key));
    if (!roles.length) {
      toast(`You already have an active identity for every role in ${cfg.label} — retire one first to create another.`);
      return;
    }
  }
  const roleField = roles ? `
      <label for="role">Role</label>
      <select id="role">
        ${roles.map((r) => `<option value="${r.key}">${r.label}</option>`).join('')}
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
      state.view = 'workspace'; // land straight in it — a no-op if we were already there (the topbar's own + button)
      toast(`Identity #${rec.identityId} created for ${cfg.label}${role ? ' (' + roleLabel(ns, role) + ')' : ''}`);
      state.render.all();
    },
  });
}

export async function renderTopbar() {
  const who = document.getElementById('topbarWho');
  const controls = document.getElementById('topbarControls');
  const bar = document.querySelector('.topbar');

  // The Bureau (desktop-ui.js) has its own screen and needs no title bar at
  // all — nothing to show until a tile's actually been tapped into, and an
  // empty bar would just be dead space above it.
  if (state.view !== 'workspace' || !state.activeNamespace) {
    bar.hidden = true;
    who.innerHTML = '';
    controls.innerHTML = '';
    return;
  }
  bar.hidden = false;

  const ns = state.activeNamespace;
  const cfg = NS_CONFIG[ns];

  if (cfg.kind === 'near') {
    who.innerHTML = `<div class="name">Near</div><div class="sub" style="color:var(--low);font-size:11.5px">Location is opt-in, set below — no identity needed here.</div>`;
    controls.innerHTML = '';
    return;
  }
  if (cfg.kind === 'agent') {
    who.innerHTML = `<div class="name">Agent</div><div class="sub" style="color:var(--low);font-size:11.5px">Cross-references your other identities' profiles against what they've already discovered — no identity of its own needed here.</div>`;
    controls.innerHTML = '';
    return;
  }
  if (cfg.kind === 'messages') {
    who.innerHTML = `<div class="name">Messages</div><div class="sub" style="color:var(--low);font-size:11.5px">Every conversation and pending request across every mode — no identity of its own needed here.</div>`;
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
        <button class="edit-profile-btn" data-act="edit" title="${cfg.kind === 'research' ? 'Rename' : 'Edit name & profile'}">✎ ${cfg.kind === 'research' ? 'Rename' : 'Edit profile'}</button>
      </div>
    </div>`;

  who.querySelector('[data-act=new]').addEventListener('click', () => createIdentityFlow(ns));
  who.querySelector('[data-act=edit]').addEventListener('click', () => {
    if (cfg.kind === 'research') renameFlow(id);
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
      // Nothing left to show in this workspace — back to the Bureau rather
      // than a dead "no identity here yet" screen.
      if (!state.activeIdentityId[id.namespace]) state.view = 'desktop';
      state.render.all();
    },
  });
}
