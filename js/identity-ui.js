// identity-ui.js — the rail, the topbar, and identity create/rename/
// rotate/retire flows. Deliberately has no dependency on discovery-ui.js
// or research-ui.js: the one place it needs to trigger "start searching"
// (the topbar's live switch) goes through `state.handlers.toggleSearchLive`,
// registered by discovery-ui.js itself — see state.js's header comment for
// why that indirection exists.

import * as identity from './identity.js';
import * as p2p from './p2p.js';
import { state, NAMESPACES, NS_CONFIG, roleLabel, initials, setActiveNamespace, pickActiveIdentityId } from './state.js';
import { openModal, toast } from './ui-kit.js';

export function renderRail() {
  const root = document.getElementById('railGroups');
  root.innerHTML = NAMESPACES.map((ns) => {
    const cfg = NS_CONFIG[ns];
    const list = state.identitiesByNs[ns].filter((i) => i.active);
    const activeId = state.activeIdentityId[ns];
    const isLive = !!state.searchLive[ns];
    return `
      <div class="ns-group">
        <div class="ns-group-head">
          <span class="lbl">${cfg.label}</span>
          <button data-add-ns="${ns}" title="New identity in ${cfg.label}">+</button>
        </div>
        ${list.length === 0 ? `<div class="empty-hint">No identity yet</div>` : list.map((id) => `
          <button class="identity ${ns === state.activeNamespace && id.identityId === activeId ? 'active' : ''}"
                  data-ns="${ns}" data-id="${id.identityId}">
            <span class="mono" style="background:${cfg.color}">${initials(id.displayName)}</span>
            <span class="meta">
              <span class="nm">${id.displayName}${id.role ? ` <span class="role-badge">${roleLabel(ns, id.role)}</span>` : ''}</span>
              <span class="id">#${id.identityId}</span>
            </span>
            <span class="live ${ns === 'research' ? '' : (isLive ? 'on' : '')}"></span>
          </button>
        `).join('')}
      </div>`;
  }).join('');

  root.querySelectorAll('.identity').forEach((btn) => {
    btn.addEventListener('click', () => {
      setActiveNamespace(btn.dataset.ns);
      state.activeIdentityId[btn.dataset.ns] = btn.dataset.id;
      state.render.all();
    });
  });
  root.querySelectorAll('[data-add-ns]').forEach((btn) => {
    btn.addEventListener('click', () => createIdentityFlow(btn.dataset.addNs));
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
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);

  if (!id) {
    who.innerHTML = `<div class="name">No identity in ${cfg.label} yet</div>`;
    controls.innerHTML = `<button class="btn primary" id="quickCreate">Create identity</button>`;
    document.getElementById('quickCreate').addEventListener('click', () => createIdentityFlow(ns));
    return;
  }

  who.innerHTML = `
    <span class="avatar" style="background:${cfg.color}">${initials(id.displayName)}</span>
    <div>
      <div class="name">${id.displayName}</div>
      <div class="sub">
        <span class="pill">${ns}</span>
        ${id.role ? `<span class="pill role">${roleLabel(ns, id.role)}</span>` : ''}
        <span class="pill">#${id.identityId}</span>
        <span class="idbtns">
          <button data-act="rename" title="Rename">✎</button>
          <button data-act="rotate" title="Rotate (replace this key, keep the name)">⟲</button>
          <button data-act="retire" title="Retire this identity">⨯</button>
        </span>
      </div>
    </div>`;

  who.querySelector('[data-act=rename]').addEventListener('click', () => renameFlow(id));
  who.querySelector('[data-act=rotate]').addEventListener('click', () => rotateFlow(id));
  who.querySelector('[data-act=retire]').addEventListener('click', () => retireFlow(id));

  if (cfg.kind === 'research') {
    controls.innerHTML = `<div class="switchctl">Human-in-the-loop <button class="switch on" id="hitl"></button></div>`;
    document.getElementById('hitl').addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));
    return;
  }

  // Search live and AI enrichment used to be topbar switches. Moved into
  // the profile panel instead (next to Edit profile / Enrich with local
  // AI) since that's where the controls they affect actually live —
  // having the same feature controllable from two disconnected places was
  // confusing, not useful.
  controls.innerHTML = '';
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
