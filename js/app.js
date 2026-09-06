// app.js — UI glue. Vanilla JS, no framework, no build step.

import * as db from './db.js';
import * as identity from './identity.js';
import * as p2p from './p2p.js';
import * as discovery from './discovery.js';
import * as matching from './matching.js';
import * as llm from './llm.js';
import * as research from './research.js';
import { PROTOCOL_VERSION } from './protocol.js';

/* ------------------------------------------------------------------ */
/* Namespace configuration                                             */
/* ------------------------------------------------------------------ */

const NAMESPACES = ['job_candidate', 'mission', 'service', 'dating', 'research'];

const NS_CONFIG = {
  job_candidate: { label: 'Employment', color: '#F1552C', kind: 'classic',
    hint: 'Candidate and recruiter profiles match symmetrically in this build — paste a résumé or a posting, either works.' },
  mission:       { label: 'Mission', color: '#59C9B8', kind: 'classic',
    hint: 'Short-term engagements. Describe what you need or what you can deliver.' },
  service:       { label: 'Service', color: '#E8B84B', kind: 'classic',
    hint: 'Local services. Category and availability matter more than distance here.' },
  dating:        { label: 'Dating', color: '#D46FB3', kind: 'classic',
    hint: 'Discovery data is minimized — only shared keywords go out, never your source text.' },
  research:      { label: 'Research', color: '#7C9EF5', kind: 'research',
    hint: 'Agent-to-agent collaboration. Hypothesis and critique are symmetric roles.' },
};

function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  activeNamespace: 'job_candidate',
  activeIdentityId: {},   // namespace -> identityId
  identitiesByNs: {},     // namespace -> [identity]
  searchLive: {},         // namespace -> bool
  aiOn: {},                // namespace -> bool
  discovered: {},          // namespace -> Map(peerId -> meta)
  pendingChats: {},         // namespace -> Map(peerId -> {status})
  openChatWith: {},         // namespace -> peerId | null
  chatLog: {},              // namespace -> Map(peerId -> [{from,text,ts,kind}])
  pendingMeetings: {},      // namespace -> Map(peerId -> {status, when, note})
  blocked: {},              // namespace -> Set(identityId)
  researchProjects: [],
  activeProjectId: null,
};

const PEER_TTL_MS = 10 * 60 * 1000; // spec §101 — stale discovery entries expire

/* ------------------------------------------------------------------ */
/* Modal helper (native <dialog>)                                      */
/* ------------------------------------------------------------------ */

function openModal(title, bodyHtml, { submitLabel = 'Save', onOpen, onSubmit } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `
    <form method="dialog" class="modal-form">
      <h3>${title}</h3>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions">
        <button value="cancel" class="btn ghost">Cancel</button>
        <button value="ok" class="btn primary">${submitLabel}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  onOpen && onOpen(dlg);
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'ok' && onSubmit) onSubmit(dlg);
    dlg.remove();
  });
  dlg.showModal();
  return dlg;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

async function boot() {
  for (const ns of NAMESPACES) {
    state.identitiesByNs[ns] = await identity.listIdentities(ns);
    state.discovered[ns] = new Map();
    state.pendingChats[ns] = new Map();
    state.chatLog[ns] = new Map();
    state.pendingMeetings[ns] = new Map();
    state.blocked[ns] = new Set((await db.getAll('blocklist')).filter((b) => b.compoundId.startsWith(ns + ':')).map((b) => b.blockedIdentityId));
  }
  state.researchProjects = await research.listProjects();

  // Passive expiry: while any namespace is searching live, periodically
  // re-render so stale (TTL-expired) discovery entries drop out of results.
  setInterval(() => {
    if (Object.values(state.searchLive).some(Boolean)) renderWorkspace();
  }, 30_000);

  // pick a sensible default active namespace/identity
  const firstNonEmpty = NAMESPACES.find((ns) => state.identitiesByNs[ns].length > 0);
  state.activeNamespace = firstNonEmpty || 'job_candidate';
  for (const ns of NAMESPACES) {
    const list = state.identitiesByNs[ns];
    if (list.length) state.activeIdentityId[ns] = list.find((i) => i.active)?.identityId || list[0].identityId;
  }

  renderAll();
  refreshUsageStat();
  registerServiceWorker();
  reportWebGPU();
}

function registerServiceWorker() {
  const flag = document.getElementById('swFlag');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => { flag.textContent = 'Offline shell ready'; })
      .catch(() => { flag.textContent = 'Offline shell unavailable'; });
  } else {
    flag.textContent = 'Service workers unsupported';
  }
}

function reportWebGPU() {
  document.getElementById('webgpuFlag').textContent = llm.isWebGPUAvailable()
    ? '· Local AI available (WebGPU)'
    : '· Local AI unavailable on this device';
}

async function refreshUsageStat() {
  const bytes = await db.estimateUsage();
  document.getElementById('usageStat').textContent = bytes ? `${(bytes / 1e6).toFixed(1)} MB` : '—';
}

/* ------------------------------------------------------------------ */
/* Render: rail                                                        */
/* ------------------------------------------------------------------ */

function renderRail() {
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
              <span class="nm">${id.displayName}</span>
              <span class="id">#${id.identityId}</span>
            </span>
            <span class="live ${ns === 'research' ? '' : (isLive ? 'on' : '')}"></span>
          </button>
        `).join('')}
      </div>`;
  }).join('');

  root.querySelectorAll('.identity').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeNamespace = btn.dataset.ns;
      state.activeIdentityId[btn.dataset.ns] = btn.dataset.id;
      renderAll();
    });
  });
  root.querySelectorAll('[data-add-ns]').forEach((btn) => {
    btn.addEventListener('click', () => createIdentityFlow(btn.dataset.addNs));
  });
}

function createIdentityFlow(ns) {
  openModal(`New identity — ${NS_CONFIG[ns].label}`, `
      <label for="dn">Display name</label>
      <input type="text" id="dn" placeholder="e.g. Alex Kade" autofocus>
    `, {
    submitLabel: 'Create identity',
    onSubmit: async (dlg) => {
      const name = dlg.querySelector('#dn').value.trim() || 'Unnamed';
      const rec = await identity.createIdentity(ns, name);
      state.identitiesByNs[ns] = await identity.listIdentities(ns);
      state.activeNamespace = ns;
      state.activeIdentityId[ns] = rec.identityId;
      toast(`Identity #${rec.identityId} created for ${NS_CONFIG[ns].label}`);
      renderAll();
    },
  });
}

/* ------------------------------------------------------------------ */
/* Render: topbar                                                      */
/* ------------------------------------------------------------------ */

function renderTopbar() {
  const ns = state.activeNamespace;
  const cfg = NS_CONFIG[ns];
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  const who = document.getElementById('topbarWho');
  const controls = document.getElementById('topbarControls');

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

  controls.innerHTML = `
    <div class="switchctl">Search live <button class="switch live ${state.searchLive[ns] ? 'on' : ''}" id="liveSw"></button></div>
    <div class="switchctl">Local AI enrichment <button class="switch ${state.aiOn[ns] ? 'on' : ''}" id="aiSw"></button></div>
  `;
  document.getElementById('liveSw').addEventListener('click', () => toggleSearchLive(ns));
  document.getElementById('aiSw').addEventListener('click', () => { state.aiOn[ns] = !state.aiOn[ns]; renderTopbar(); });
}

function renameFlow(id) {
  openModal('Rename identity', `<label>Display name</label><input type="text" id="rn" value="${id.displayName}">`, {
    submitLabel: 'Save',
    onSubmit: async (dlg) => {
      await identity.renameIdentity(id.identityId, dlg.querySelector('#rn').value.trim() || id.displayName);
      state.identitiesByNs[id.namespace] = await identity.listIdentities(id.namespace);
      renderAll();
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
      renderAll();
    },
  });
}

function retireFlow(id) {
  openModal('Retire identity', `<p style="font-size:12.5px;color:var(--mid)">This marks #${id.identityId} inactive. It stays visible in your history. This is local only — it can't force other peers to forget a previously seen id.</p>`, {
    submitLabel: 'Retire',
    onSubmit: async () => {
      await identity.retireIdentity(id.identityId);
      state.identitiesByNs[id.namespace] = await identity.listIdentities(id.namespace);
      const remaining = state.identitiesByNs[id.namespace].find((i) => i.active);
      state.activeIdentityId[id.namespace] = remaining ? remaining.identityId : null;
      renderAll();
    },
  });
}

/* ------------------------------------------------------------------ */
/* Classic namespaces: profile, discovery, matching, chat              */
/* ------------------------------------------------------------------ */

async function getProfile(identityId) {
  return (await db.get('profiles', identityId)) || { identityId, sourceText: '', tokens: [], aiTokens: [], category: '', languages: [], availableNow: false };
}

function editProfileFlow(id) {
  getProfile(id.identityId).then((profile) => {
    openModal('Edit profile', `
      <label>Category / title</label>
      <input type="text" id="cat" value="${profile.category || ''}" placeholder="e.g. Backend Engineer">
      <label>Languages (comma separated)</label>
      <input type="text" id="langs" value="${(profile.languages || []).join(', ')}" placeholder="EN, PT">
      <label><input type="checkbox" id="avail" ${profile.availableNow ? 'checked' : ''}> Available now</label>
      <label>Source text (your résumé / posting / description — stays local, never sent as-is)</label>
      <textarea id="src" placeholder="Paste text, or load a .txt file below">${profile.sourceText || ''}</textarea>
      <label>Or load from a .txt file</label>
      <input type="file" id="file" accept=".txt,text/plain">
    `, {
      submitLabel: 'Save profile',
      onOpen: (dlg) => {
        dlg.querySelector('#file').addEventListener('change', async (e) => {
          const f = e.target.files[0];
          if (f) dlg.querySelector('#src').value = await f.text();
        });
      },
      onSubmit: async (dlg) => {
        const sourceText = dlg.querySelector('#src').value;
        const category = dlg.querySelector('#cat').value.trim();
        const languages = dlg.querySelector('#langs').value.split(',').map((s) => s.trim()).filter(Boolean);
        const availableNow = dlg.querySelector('#avail').checked;
        const tokens = matching.tokenize(sourceText + ' ' + category);
        await db.put('profiles', { identityId: id.identityId, sourceText, category, languages, availableNow, tokens, aiTokens: profile.aiTokens || [], updatedAt: Date.now() });
        toast('Profile saved locally');
        renderWorkspace();
      },
    });
  });
}

async function enrichProfileWithAI(id) {
  if (!llm.isWebGPUAvailable()) { toast('WebGPU not available — local AI enrichment is disabled on this device.'); return; }
  const profile = await getProfile(id.identityId);
  if (!profile.sourceText) { toast('Add source text to your profile first.'); return; }
  toast('Loading local model — first run downloads weights, this can take a while…');
  try {
    const extra = await llm.enrichKeywords(profile.sourceText, (p) => { if (p.text) toast(p.text); });
    profile.aiTokens = extra;
    await db.put('profiles', profile);
    toast(`AI added ${extra.length} derived keywords (marked separately from source text)`);
    renderWorkspace();
  } catch (e) {
    toast('Local AI failed: ' + e.message);
  }
}

async function toggleSearchLive(ns) {
  state.searchLive[ns] = !state.searchLive[ns];
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  if (state.searchLive[ns]) {
    try {
      await p2p.joinNamespaceRoom(ns, {
        onPeerJoin: async (peerId) => {
          const profile = await getProfile(id.identityId);
          p2p.getRoom(ns).send('discovery', id.identityId, {
            category: profile.category,
            tokens: [...profile.tokens, ...profile.aiTokens].slice(0, 30),
            languages: profile.languages,
            availableNow: profile.availableNow,
          }, peerId);
        },
        onPeerLeave: () => { renderWorkspace(); renderTopbar(); },
        onMessage: (msg, peerId) => handleIncomingMessage(ns, msg, peerId),
        onBlob: (blob, peerId, metadata) => {
          if (!state.chatLog[ns].has(peerId)) state.chatLog[ns].set(peerId, []);
          state.chatLog[ns].get(peerId).push({
            from: 'them', kind: 'attachment', ts: Date.now(),
            name: metadata.name || 'file', size: blob.size, url: URL.createObjectURL(blob),
          });
          toast(`Received attachment: ${metadata.name || 'file'}`);
          renderWorkspace();
        },
      });
    } catch (e) {
      toast('P2P networking unavailable: ' + e.message);
      state.searchLive[ns] = false;
    }
  } else {
    p2p.leaveNamespaceRoom(ns);
    state.discovered[ns].clear();
  }
  renderAll();
}

/* ---- Blocklist (spec §48 — local only, no global enforcement) -------- */

async function blockPeer(ns, blockedIdentityId, displayNameHint) {
  const compoundId = `${ns}:${blockedIdentityId}`;
  await db.put('blocklist', { compoundId, namespace: ns, blockedIdentityId, displayNameHint, blockedAt: Date.now() });
  state.blocked[ns].add(blockedIdentityId);
  for (const [peerId, meta] of state.discovered[ns].entries()) {
    if (meta.sender === blockedIdentityId) state.discovered[ns].delete(peerId);
  }
  toast(`Blocked ${blockedIdentityId.slice(0, 10)}… locally`);
  renderWorkspace();
}

async function unblockPeer(ns, blockedIdentityId) {
  await db.del('blocklist', `${ns}:${blockedIdentityId}`);
  state.blocked[ns].delete(blockedIdentityId);
  renderWorkspace();
}

/* ---- Meetings ---------------------------------------------------------- */

function proposeMeetingFlow(ns, id, peerId) {
  openModal('Propose a meeting', `
      <label>Proposed time</label>
      <input type="text" id="when" placeholder="e.g. Thu 14:00 CET">
      <label>Note (optional)</label>
      <input type="text" id="note" placeholder="Video call, coffee, on-site…">
    `, {
    submitLabel: 'Send proposal',
    onSubmit: (dlg) => {
      const when = dlg.querySelector('#when').value.trim();
      const note = dlg.querySelector('#note').value.trim();
      if (!when) return;
      const room = p2p.getRoom(ns);
      room.send('meeting_proposal', id.identityId, { when, note }, peerId);
      state.pendingMeetings[ns].set(peerId, { status: 'outgoing', when, note });
      renderWorkspace();
    },
  });
}

function respondMeeting(ns, id, peerId, accept) {
  const room = p2p.getRoom(ns);
  const m = state.pendingMeetings[ns].get(peerId) || {};
  room.send(accept ? 'meeting_accept' : 'meeting_decline', id.identityId, { when: m.when }, peerId);
  if (accept) state.pendingMeetings[ns].set(peerId, { ...m, status: 'accepted' });
  else state.pendingMeetings[ns].delete(peerId);
  renderWorkspace();
}

function handleIncomingMessage(ns, msg, peerId) {
  if (state.blocked[ns]?.has(msg.sender)) return; // local blocklist — silently drop

  if (msg.type === 'discovery') {
    state.discovered[ns].set(peerId, { ...msg.payload, namespace: ns, v: msg.v, sender: msg.sender, peerId, lastSeen: Date.now() });
    renderWorkspace();
  } else if (msg.type === 'meeting_proposal') {
    state.pendingMeetings[ns].set(peerId, { status: 'incoming', when: msg.payload.when, note: msg.payload.note });
    toast(`Meeting proposed: ${msg.payload.when}`);
    renderWorkspace();
  } else if (msg.type === 'meeting_accept') {
    state.pendingMeetings[ns].set(peerId, { status: 'accepted', when: msg.payload.when });
    toast('Meeting accepted');
    renderWorkspace();
  } else if (msg.type === 'meeting_decline') {
    state.pendingMeetings[ns].delete(peerId);
    toast('Meeting declined');
    renderWorkspace();
  } else if (msg.type === 'chat_request') {
    state.pendingChats[ns].set(peerId, { status: 'incoming', from: msg.sender });
    toast(`Chat request from ${msg.sender.slice(0, 6)}…`);
    renderWorkspace();
  } else if (msg.type === 'chat_accept') {
    state.pendingChats[ns].set(peerId, { status: 'accepted' });
    state.openChatWith[ns] = peerId;
    renderWorkspace();
  } else if (msg.type === 'chat_decline') {
    state.pendingChats[ns].delete(peerId);
    toast('Chat request declined');
    renderWorkspace();
  } else if (msg.type === 'chat_message') {
    if (!state.chatLog[ns].has(peerId)) state.chatLog[ns].set(peerId, []);
    state.chatLog[ns].get(peerId).push({ from: 'them', text: msg.payload.text, ts: msg.timestamp });
    renderWorkspace();
  } else if (msg.type === 'identity_retired') {
    toast(`Peer identity retired: #${msg.payload.retiredId} → #${msg.payload.rotatedTo}`);
  } else if (msg.type === 'research_sync_request') {
    handleResearchSyncRequest(ns, msg, peerId);
  } else if (msg.type === 'research_sync_response') {
    handleResearchSyncResponse(msg);
  } else if (msg.type === 'research_artifact') {
    db.put('research_artifacts', msg.payload.artifact).then(() => {
      if (msg.payload.artifact.projectId === state.activeProjectId) renderWorkspace();
    });
  }
}

function requestChat(ns, id, peerId) {
  const room = p2p.getRoom(ns);
  room.send('chat_request', id.identityId, {}, peerId);
  state.pendingChats[ns].set(peerId, { status: 'outgoing' });
  renderWorkspace();
}

function respondChat(ns, id, peerId, accept) {
  const room = p2p.getRoom(ns);
  room.send(accept ? 'chat_accept' : 'chat_decline', id.identityId, {}, peerId);
  if (accept) { state.pendingChats[ns].set(peerId, { status: 'accepted' }); state.openChatWith[ns] = peerId; }
  else state.pendingChats[ns].delete(peerId);
  renderWorkspace();
}

function sendChatMessage(ns, id, peerId, text) {
  if (!text.trim()) return;
  const room = p2p.getRoom(ns);
  room.send('chat_message', id.identityId, { text }, peerId);
  if (!state.chatLog[ns].has(peerId)) state.chatLog[ns].set(peerId, []);
  state.chatLog[ns].get(peerId).push({ from: 'me', text, ts: Date.now() });
  renderWorkspace();
}

async function renderClassicWorkspace(ns) {
  const cfg = NS_CONFIG[ns];
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  if (!id) return `<div class="empty-state"><p>Create an identity in ${cfg.label} to get started.</p><button class="btn primary" id="createHere">Create identity</button></div>`;

  const profile = await getProfile(id.identityId);
  const myTokens = [...profile.tokens, ...(state.aiOn[ns] ? profile.aiTokens : [])];

  const now = Date.now();
  const peers = [...state.discovered[ns].values()]
    .filter((p) => now - (p.lastSeen || 0) < PEER_TTL_MS)
    .filter((p) => !state.blocked[ns].has(p.sender));
  const cascade = discovery.runCascade(peers, {
    myNamespace: ns,
    protocolVersion: PROTOCOL_VERSION,
    hardConstraints: { requiredLanguages: profile.languages },
    softConstraints: { preferredCategory: profile.category },
  });

  const scored = cascade.pool.map((p) => {
    const m = matching.matchTokens(myTokens, p.tokens || []);
    return { ...p, match: m };
  }).sort((a, b) => b.match.score - a.match.score);

  const funnelHtml = cascade.stages.map((s, i) => `
      <div class="stage"><div class="n">${s.count}</div><div class="lbl">${s.label}</div></div>
      ${i < cascade.stages.length - 1 ? '<div class="arrow">→</div>' : ''}
    `).join('');

  const resultsHtml = scored.length === 0
    ? `<div class="empty-state">No peers discovered yet on this namespace.<br>Open Jobber in another browser tab, device, or share this build with someone else — discovery is real WebRTC, it just needs a second peer.</div>`
    : scored.map((p) => {
        const ex = matching.explain(p.match);
        const chat = state.pendingChats[ns].get(p.peerId);
        const meeting = state.pendingMeetings[ns].get(p.peerId);
        const meetingHtml = meeting ? `
          <div class="meeting-banner">
            ${meeting.status === 'incoming'
              ? `Proposed meeting: <b>${meeting.when}</b>${meeting.note ? ` — ${meeting.note}` : ''}
                 <button class="btn small primary meeting-yes">Accept</button>
                 <button class="btn small meeting-no">Decline</button>`
              : meeting.status === 'accepted'
                ? `Meeting confirmed: <b>${meeting.when}</b>`
                : `Meeting proposed, awaiting reply: <b>${meeting.when}</b>`}
          </div>` : '';
        return `
        <div class="card" data-peer="${p.peerId}" data-identity="${p.sender}">
          <div class="top">
            <span class="avatar">${(p.category || 'PR').slice(0, 2).toUpperCase()}</span>
            <div class="info">
              <div class="name">${p.sender.slice(0, 10)}…</div>
              <div class="role">${p.category || 'No category declared'}</div>
              <div class="meta">
                <span class="chip">${(p.languages || []).join(' / ') || 'no language declared'}</span>
                <span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>
              </div>
            </div>
            <div class="score">
              <div class="pct">${p.match.score}%</div>
              <div class="bar"><i style="width:${p.match.score}%"></i></div>
            </div>
          </div>
          <div class="expl">${ex.pos.map((t) => `<div class="p">${t}</div>`).join('')}${ex.neg.map((t) => `<div class="m">${t}</div>`).join('')}</div>
          ${meetingHtml}
          <div class="actions">
            <button class="btn ghost toggle-expl">Why this score</button>
            ${chat && chat.status === 'incoming'
              ? `<button class="btn primary respond-yes">Accept chat</button><button class="btn respond-no">Decline</button>`
              : chat && chat.status === 'accepted'
                ? `<button class="btn primary open-chat">Open chat</button><button class="btn ghost propose-meeting">Propose meeting</button>`
                : chat && chat.status === 'outgoing'
                  ? `<button class="btn" disabled>Request sent…</button>`
                  : `<button class="btn primary request-chat">Start conversation</button>`}
            <button class="btn ghost block-peer">Block</button>
          </div>
        </div>`;
      }).join('');

  const chatPeer = state.openChatWith[ns];
  const chatHtml = chatPeer ? renderChatPanel(ns, id, chatPeer) : '';

  return `
    <h2 class="section-title">${cfg.label} — ${state.searchLive[ns] ? 'searching live' : 'search paused'}</h2>
    <p class="section-sub">${cfg.hint}</p>

    <div class="panel">
      <div class="k">Your profile</div>
      <div>${profile.category ? `<b>${profile.category}</b>` : '<span style="color:var(--low)">No category set</span>'}</div>
      <div class="chiprow">
        ${profile.tokens.slice(0, 10).map((t) => `<span class="chip">${t}</span>`).join('')}
        ${(state.aiOn[ns] ? profile.aiTokens : []).slice(0, 10).map((t) => `<span class="chip ai">◆ ${t}</span>`).join('')}
        ${!profile.tokens.length && !profile.aiTokens.length ? '<span style="color:var(--low);font-size:11px">No keywords extracted yet</span>' : ''}
      </div>
      <div class="actions" style="margin-top:12px">
        <button class="btn" id="editProfile">Edit profile</button>
        <button class="btn" id="enrichAI">Enrich with local AI</button>
      </div>
    </div>

    <div class="funnel">${funnelHtml}</div>
    <div class="results">${resultsHtml}</div>
    ${chatHtml}
  `;
}

function renderChatPanel(ns, id, peerId) {
  const log = state.chatLog[ns].get(peerId) || [];
  const bubble = (m) => m.kind === 'attachment'
    ? `<a class="chat-msg attachment ${m.from === 'me' ? 'mine' : ''}" href="${m.url}" download="${m.name}">📎 ${m.name} <span>(${(m.size / 1024).toFixed(1)} KB)</span></a>`
    : `<div class="chat-msg ${m.from === 'me' ? 'mine' : ''}">${m.text}</div>`;
  return `
    <div class="panel" style="margin-top:16px">
      <div class="chat">
        <div class="chat-head">Conversation with ${peerId.slice(0, 10)}…</div>
        <div class="chat-log" id="chatLog">
          ${log.map(bubble).join('') || '<div style="color:var(--low);font-size:12px">Say hello — this goes straight over WebRTC, no server in between.</div>'}
        </div>
        <div class="chat-input">
          <input type="text" id="chatInput" placeholder="Write a message…">
          <label class="btn ghost" style="display:flex;align-items:center" title="Send a file">
            📎<input type="file" id="chatFile" style="display:none">
          </label>
          <button class="btn primary" id="chatSend">Send</button>
        </div>
      </div>
    </div>`;
}

function sendChatFile(ns, id, peerId, file) {
  const room = p2p.getRoom(ns);
  room.sendBlob(file, peerId, { name: file.name, size: file.size, type: file.type });
  if (!state.chatLog[ns].has(peerId)) state.chatLog[ns].set(peerId, []);
  state.chatLog[ns].get(peerId).push({ from: 'me', kind: 'attachment', ts: Date.now(), name: file.name, size: file.size, url: URL.createObjectURL(file) });
  renderWorkspace();
}

function bindClassicEvents(ns) {
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  const ws = document.getElementById('workspace');

  ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow(ns));
  ws.querySelector('#editProfile')?.addEventListener('click', () => editProfileFlow(id));
  ws.querySelector('#enrichAI')?.addEventListener('click', () => enrichProfileWithAI(id));

  ws.querySelectorAll('.toggle-expl').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.card');
      card.classList.toggle('open');
      btn.textContent = card.classList.contains('open') ? 'Hide explanation' : 'Why this score';
    });
  });
  ws.querySelectorAll('.request-chat').forEach((btn) => {
    btn.addEventListener('click', () => requestChat(ns, id, btn.closest('.card').dataset.peer));
  });
  ws.querySelectorAll('.respond-yes').forEach((btn) => {
    btn.addEventListener('click', () => respondChat(ns, id, btn.closest('.card').dataset.peer, true));
  });
  ws.querySelectorAll('.respond-no').forEach((btn) => {
    btn.addEventListener('click', () => respondChat(ns, id, btn.closest('.card').dataset.peer, false));
  });
  ws.querySelectorAll('.open-chat').forEach((btn) => {
    btn.addEventListener('click', () => { state.openChatWith[ns] = btn.closest('.card').dataset.peer; renderWorkspace(); });
  });
  ws.querySelectorAll('.propose-meeting').forEach((btn) => {
    btn.addEventListener('click', () => proposeMeetingFlow(ns, id, btn.closest('.card').dataset.peer));
  });
  ws.querySelectorAll('.meeting-yes').forEach((btn) => {
    btn.addEventListener('click', () => respondMeeting(ns, id, btn.closest('.card').dataset.peer, true));
  });
  ws.querySelectorAll('.meeting-no').forEach((btn) => {
    btn.addEventListener('click', () => respondMeeting(ns, id, btn.closest('.card').dataset.peer, false));
  });
  ws.querySelectorAll('.block-peer').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.card');
      blockPeer(ns, card.dataset.identity, card.querySelector('.name')?.textContent);
    });
  });

  const sendBtn = ws.querySelector('#chatSend');
  if (sendBtn) {
    const input = ws.querySelector('#chatInput');
    const fire = () => { sendChatMessage(ns, id, state.openChatWith[ns], input.value); input.value = ''; };
    sendBtn.addEventListener('click', fire);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });
    ws.querySelector('#chatFile')?.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) sendChatFile(ns, id, state.openChatWith[ns], f);
    });
    const log = ws.querySelector('#chatLog');
    if (log) log.scrollTop = log.scrollHeight;
  }
}

/* ------------------------------------------------------------------ */
/* Research namespace                                                   */
/* ------------------------------------------------------------------ */

const ARTIFACT_COLOR_LABEL = {
  hypothesis: 'Hypothesis', counter_hypothesis: 'Counter-hypothesis', critique: 'Critique',
  evidence: 'Evidence', experiment: 'Experiment', result: 'Result',
  analysis: 'Analysis', synthesis: 'Synthesis', decision: 'Decision', problem: 'Problem',
};

async function newProjectFlow(id) {
  openModal('New research project', `
      <label>Problem statement</label>
      <textarea id="problem" placeholder="What are you trying to figure out?"></textarea>
      <label>Ownership split</label>
      <input type="text" id="own" value="50 / 50">
      <label>Publication rule</label>
      <input type="text" id="pub" value="Mutual approval">
      <label>Commercialization rule</label>
      <input type="text" id="com" value="Mutual approval">
    `, {
    submitLabel: 'Create project',
    onSubmit: async (dlg) => {
      const problem = dlg.querySelector('#problem').value.trim();
      if (!problem) return;
      const project = await research.createProject({
        problem,
        participants: [{ identityId: id.identityId, displayName: id.displayName }],
        agreement: {
          contribution: 'Joint',
          ownership: dlg.querySelector('#own').value,
          publication: dlg.querySelector('#pub').value,
          commercialization: dlg.querySelector('#com').value,
        },
      });
      state.researchProjects = await research.listProjects();
      state.activeProjectId = project.projectId;
      renderWorkspace();
    },
  });
}

async function addArtifactFlow(projectId, type, id, prefillText = '') {
  const artifacts = await research.listArtifacts(projectId);
  const parentOptions = artifacts.map((a) => `
      <label><input type="checkbox" value="${a.artifactId}"> ${ARTIFACT_COLOR_LABEL[a.type] || a.type} — ${(a.content.text || '').slice(0, 40)}</label>
    `).join('') || '<span style="font-size:11.5px;color:var(--low)">No prior artifacts yet</span>';

  openModal(`Add ${ARTIFACT_COLOR_LABEL[type] || type}`, `
      <label>Content</label>
      <textarea id="content">${prefillText}</textarea>
      <label>Parents (what this builds on)</label>
      <div class="parent-picker">${parentOptions}</div>
    `, {
    submitLabel: 'Add artifact',
    onSubmit: async (dlg) => {
      const text = dlg.querySelector('#content').value.trim();
      if (!text) return;
      const parents = [...dlg.querySelectorAll('.parent-picker input:checked')].map((i) => i.value);
      const artifact = await research.createArtifact(projectId, type, { text }, { author: id.identityId, parents });
      const room = p2p.getRoom('research');
      if (room) room.send('research_artifact', id.identityId, { artifact });
      renderWorkspace();
    },
  });
}

async function aiAssistFlow(projectId, type, id) {
  if (!llm.isWebGPUAvailable()) { toast('WebGPU not available — write it manually instead.'); return; }
  const project = (await research.listProjects()).find((p) => p.projectId === projectId);
  const artifacts = await research.listArtifacts(projectId);
  const recent = artifacts.slice(-4).map((a) => `[${a.type}] ${a.content.text}`).join('\n');
  const system = `You are a research collaborator. The problem is: "${project.problem}". Propose a concise, falsifiable ${type} in 1-3 sentences, grounded in the recent context given.`;
  toast('Local model thinking…');
  try {
    const suggestion = await llm.researchGenerate(recent || project.problem, system);
    addArtifactFlow(projectId, type, id, suggestion);
  } catch (e) {
    toast('Local AI failed: ' + e.message);
  }
}

function svgGraph(artifacts) {
  const { columns, edges, maxDepth } = research.layoutGraph(artifacts);
  const colW = 130, rowH = 46, pad = 20;
  const width = pad * 2 + (maxDepth + 1) * colW;
  let maxRows = 1;
  for (const col of columns.values()) maxRows = Math.max(maxRows, col.length);
  const height = pad * 2 + maxRows * rowH;

  const posOf = new Map();
  for (const [depth, nodes] of columns.entries()) {
    nodes.forEach((n, row) => {
      posOf.set(n.artifact.artifactId, { x: pad + depth * colW, y: pad + row * rowH });
    });
  }

  const colorFor = {
    problem: '#8A94A3', hypothesis: '#59C9B8', counter_hypothesis: '#59C9B8',
    critique: '#E8B84B', evidence: '#E8B84B', experiment: '#7C9EF5',
    result: '#6FBF73', synthesis: '#6FBF73', analysis: '#6FBF73', decision: '#6FBF73',
  };

  const edgeSvg = edges.map((e) => {
    const a = posOf.get(e.from), b = posOf.get(e.to);
    if (!a || !b) return '';
    return `<path d="M${a.x + 55},${a.y + 15} L${b.x},${b.y + 15}" stroke="#3a424b" stroke-width="1.3" fill="none" marker-end="url(#arrow)"/>`;
  }).join('');

  const nodeSvg = [...posOf.entries()].map(([aid, pos]) => {
    const a = artifacts.find((x) => x.artifactId === aid);
    const label = (a.content.text || a.type).slice(0, 14);
    const color = colorFor[a.type] || '#8A94A3';
    return `<g>
      <rect x="${pos.x}" y="${pos.y}" width="55" height="30" rx="6" fill="#171D23" stroke="${color}" stroke-width="1.3"/>
      <text x="${pos.x + 27.5}" y="${pos.y + 19}" text-anchor="middle" font-family="IBM Plex Mono" font-size="8.5" fill="#EDEFF1">${label}</text>
    </g>`;
  }).join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="display:block">
      <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#3a424b"/></marker></defs>
      ${edgeSvg}${nodeSvg}
    </svg>`;
}

async function renderResearchWorkspace() {
  const id = state.identitiesByNs.research.find((i) => i.identityId === state.activeIdentityId.research);
  if (!id) return `<div class="empty-state"><p>Create a Research identity to start a project.</p><button class="btn primary" id="createHere">Create identity</button></div>`;

  state.researchProjects = await research.listProjects();
  if (!state.activeProjectId && state.researchProjects.length) state.activeProjectId = state.researchProjects[0].projectId;
  const project = state.researchProjects.find((p) => p.projectId === state.activeProjectId);

  const listHtml = `<div class="project-list">
      ${state.researchProjects.map((p) => `<button class="project-pill ${p.projectId === state.activeProjectId ? 'active' : ''}" data-pid="${p.projectId}">${p.problem.slice(0, 32)}${p.problem.length > 32 ? '…' : ''}</button>`).join('')}
      <button class="project-pill" id="newProjectBtn">+ New project</button>
      <button class="project-pill" id="importBtn">Import .jobber</button>
      <input type="file" id="importFile" accept=".json" style="display:none">
    </div>`;

  if (!project) {
    return `<h2 class="section-title">Research — agent-to-agent collaboration</h2>
      <p class="section-sub">${NS_CONFIG.research.hint}</p>
      ${listHtml}
      <div class="empty-state">No project yet. Create one to state a problem and start collaborating.</div>`;
  }

  const artifacts = await research.listArtifacts(project.projectId);
  const feedHtml = artifacts.map((a) => `
      <div class="fmsg ${a.type}">
        <div class="bar"></div>
        <div class="body">
          <div class="who">${a.agent ? a.agent : (state.identitiesByNs.research.find((i) => i.identityId === a.author)?.displayName || a.author?.slice(0, 8) || 'Unknown')}
            <span class="k">${ARTIFACT_COLOR_LABEL[a.type] || a.type}</span></div>
          <div class="txt">${a.content.text}</div>
          ${a.validatedBy.length ? `<div class="valid">Validated by ${a.validatedBy.length} participant(s)</div>` : `<button class="btn small validate-btn" data-aid="${a.artifactId}">Validate</button>`}
        </div>
      </div>`).join('');

  return `
    <h2 class="section-title">Research — agent-to-agent collaboration</h2>
    <p class="section-sub">${NS_CONFIG.research.hint}</p>
    ${listHtml}

    <div class="panel">
      <div class="k">Problem</div>
      <div style="font-family:var(--font-head);font-size:15px;font-weight:500">${project.problem}</div>
      <div class="participants">
        ${project.participants.map((p) => `<div class="participant"><span class="dot"></span><span>${p.displayName}</span></div>`).join('')}
      </div>
      <div class="actions" style="margin-top:12px">
        <button class="btn" id="connectPeers">${state.searchLive.research ? 'Connected to research room' : 'Connect with peers'}</button>
        <button class="btn" id="exportProject">Export .jobber</button>
      </div>
    </div>

    <div class="rgrid">
      <div>
        <div class="panel">
          <div class="k">Artifact graph</div>
          ${artifacts.length ? svgGraph(artifacts) : '<div style="color:var(--low);font-size:12px">No artifacts yet.</div>'}
          <div class="graph-legend">
            <span><i style="background:#59C9B8"></i>Hypothesis</span>
            <span><i style="background:#E8B84B"></i>Critique / Evidence</span>
            <span><i style="background:#7C9EF5"></i>Experiment</span>
            <span><i style="background:#6FBF73"></i>Result / Synthesis</span>
          </div>
        </div>
        <div class="panel">
          <div class="k">Research contract</div>
          <div class="agree-row"><span class="k2">Contribution</span><span class="v">${project.agreement.contribution}</span></div>
          <div class="agree-row"><span class="k2">Ownership</span><span class="v">${project.agreement.ownership}</span></div>
          <div class="agree-row"><span class="k2">Publication</span><span class="v">${project.agreement.publication}</span></div>
          <div class="agree-row"><span class="k2">Commercialization</span><span class="v">${project.agreement.commercialization}</span></div>
        </div>
        <div class="research-actions">
          <button class="btn primary" data-artifact="hypothesis">Add hypothesis</button>
          <button class="btn" data-artifact="critique">Add critique</button>
          <button class="btn" data-artifact="experiment">Add experiment</button>
          <button class="btn" data-artifact="result">Add result</button>
          <button class="btn" data-artifact="synthesis">Add synthesis</button>
        </div>
        <div class="research-actions">
          <button class="btn ghost" data-ai="hypothesis">Ask local AI for a hypothesis</button>
          <button class="btn ghost" data-ai="critique">Ask local AI for a critique</button>
        </div>
      </div>
      <div>
        <div class="feed">${feedHtml || '<div style="padding:16px;color:var(--low);font-size:12px">No artifacts yet — add a hypothesis to begin.</div>'}</div>
      </div>
    </div>
  `;
}

function bindResearchEvents(id) {
  const ws = document.getElementById('workspace');
  ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow('research'));
  ws.querySelector('#newProjectBtn')?.addEventListener('click', () => newProjectFlow(id));
  ws.querySelectorAll('.project-pill[data-pid]').forEach((btn) => {
    btn.addEventListener('click', () => { state.activeProjectId = btn.dataset.pid; renderWorkspace(); });
  });
  ws.querySelectorAll('[data-artifact]').forEach((btn) => {
    btn.addEventListener('click', () => addArtifactFlow(state.activeProjectId, btn.dataset.artifact, id));
  });
  ws.querySelectorAll('[data-ai]').forEach((btn) => {
    btn.addEventListener('click', () => aiAssistFlow(state.activeProjectId, btn.dataset.ai, id));
  });
  ws.querySelectorAll('.validate-btn').forEach((btn) => {
    btn.addEventListener('click', async () => { await research.validateArtifact(btn.dataset.aid, id.identityId); renderWorkspace(); });
  });
  ws.querySelector('#exportProject')?.addEventListener('click', async () => {
    const bundle = await research.exportProject(state.activeProjectId);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.activeProjectId}.jobber.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  ws.querySelector('#importBtn')?.addEventListener('click', () => ws.querySelector('#importFile').click());
  ws.querySelector('#importFile')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const bundle = JSON.parse(await f.text());
    const project = await research.importProject(bundle);
    state.researchProjects = await research.listProjects();
    state.activeProjectId = project.projectId;
    renderWorkspace();
  });
  ws.querySelector('#connectPeers')?.addEventListener('click', () => toggleResearchConnect(id));
}

async function toggleResearchConnect(id) {
  state.searchLive.research = !state.searchLive.research;
  if (state.searchLive.research) {
    try {
      await p2p.joinNamespaceRoom('research', {
        onPeerJoin: async () => {
          const artifacts = state.activeProjectId ? await research.listArtifacts(state.activeProjectId) : [];
          p2p.getRoom('research').send('research_sync_request', id.identityId, {
            projectId: state.activeProjectId,
            knownArtifactIds: artifacts.map((a) => a.artifactId),
          });
        },
        onMessage: (msg, peerId) => handleIncomingMessage('research', msg, peerId),
      });
    } catch (e) {
      toast('P2P networking unavailable: ' + e.message);
      state.searchLive.research = false;
    }
  } else {
    p2p.leaveNamespaceRoom('research');
  }
  renderAll();
}

async function handleResearchSyncRequest(ns, msg, peerId) {
  const { projectId, knownArtifactIds } = msg.payload;
  if (!projectId || projectId !== state.activeProjectId) return;
  const mine = await research.listArtifacts(projectId);
  const missing = mine.filter((a) => !knownArtifactIds.includes(a.artifactId));
  if (missing.length) {
    const room = p2p.getRoom(ns);
    room.send('research_sync_response', state.activeIdentityId.research, { projectId, artifacts: missing }, peerId);
  }
}

async function handleResearchSyncResponse(msg) {
  for (const a of msg.payload.artifacts) await db.put('research_artifacts', a);
  if (msg.payload.projectId === state.activeProjectId) renderWorkspace();
}

/* ------------------------------------------------------------------ */
/* Root render                                                         */
/* ------------------------------------------------------------------ */

async function renderWorkspace() {
  const ns = state.activeNamespace;
  const ws = document.getElementById('workspace');
  const id = state.identitiesByNs[ns]?.find((i) => i.identityId === state.activeIdentityId[ns]);

  if (NS_CONFIG[ns].kind === 'research') {
    ws.innerHTML = await renderResearchWorkspace();
    if (id) bindResearchEvents(id);
    else ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow(ns));
  } else {
    ws.innerHTML = await renderClassicWorkspace(ns);
    bindClassicEvents(ns);
  }

  document.getElementById('peerCount').textContent = p2p.peerCountAcrossRooms();
}

function renderAll() {
  renderRail();
  renderTopbar();
  renderWorkspace();
  refreshUsageStat();
}

boot();
