// app.js — UI glue. Vanilla JS, no framework, no build step.

import * as db from './db.js';
import * as identity from './identity.js';
import * as p2p from './p2p.js';
import * as discovery from './discovery.js';
import * as matching from './matching.js';
import * as llm from './llm.js';
import * as extract from './extract.js';
import * as research from './research.js';
import { PROTOCOL_VERSION } from './protocol.js';

/* ------------------------------------------------------------------ */
/* Namespace configuration                                             */
/* ------------------------------------------------------------------ */

const NAMESPACES = ['employment', 'business', 'independant', 'dating', 'research'];

// "twoSided" namespaces match role A against role B (never A-A or B-B).
// "reciprocal" (dating) matches each identity's *search* against the
// other's *profile*, in both directions — a real match needs both sides
// to be interested, not just one.
const NS_CONFIG = {
  employment: { label: 'Employment', color: '#F1552C', kind: 'twoSided',
    roles: [{ key: 'candidate', label: 'Candidate' }, { key: 'recruiter', label: 'Recruiter' }],
    hint: 'Candidates are matched against recruiters, and recruiters against candidates — never against their own kind.' },
  business: { label: 'Business', color: '#59C9B8', kind: 'twoSided',
    roles: [{ key: 'offer', label: 'Offer' }, { key: 'client', label: 'Client' }],
    hint: 'Offers are matched with clients — never offer-to-offer — and a declared rate is checked against each client\'s budget range.' },
  independant: { label: 'Independant', color: '#E8B84B', kind: 'twoSided',
    roles: [{ key: 'provider', label: 'Service' }, { key: 'user', label: 'Utilisateur' }],
    hint: 'Service providers are matched with the users who need them, with a declared rate checked against each user\'s budget range.' },
  dating: { label: 'Dating', color: '#D46FB3', kind: 'reciprocal',
    hint: 'Your "looking for" is matched against their profile, and theirs against yours — a real match needs both directions to work.' },
  research: { label: 'Research', color: '#7C9EF5', kind: 'research',
    hint: 'Agent-to-agent collaboration. Hypothesis and critique are symmetric roles.' },
};

function roleLabel(ns, roleKey) {
  const role = NS_CONFIG[ns].roles?.find((r) => r.key === roleKey);
  return role ? role.label : null;
}

function complementaryRole(ns, roleKey) {
  const roles = NS_CONFIG[ns].roles;
  if (!roles) return null;
  return roles.find((r) => r.key !== roleKey)?.key || null;
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function relativeTime(ts, now = Date.now()) {
  if (!ts) return 'never';
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  activeNamespace: 'employment',
  activeIdentityId: {},   // namespace -> identityId
  identitiesByNs: {},     // namespace -> [identity]
  searchLive: {},         // namespace -> bool
  aiOn: {},                // namespace -> bool
  discovered: {},          // namespace -> Map(peerId -> meta)
  pendingChats: {},         // namespace -> Map(theirIdentityId -> {status})
  openChatWith: {},         // namespace -> theirIdentityId | null
  chatLog: {},              // namespace -> Map(theirIdentityId -> [{from,text,ts,kind}]) — hydrated from IndexedDB, see persistMessage/loadConversation
  pendingMeetings: {},      // namespace -> Map(theirIdentityId -> {status, when, note})
  pendingDocs: {},          // namespace -> Map(theirIdentityId -> {status, doc, text?})
  blocked: {},              // namespace -> Set(identityId)
  identityToPeer: {},       // namespace -> Map(theirIdentityId -> current live peerId)
  peerToIdentity: {},       // namespace -> Map(peerId -> theirIdentityId)
  loadedConversations: {},  // namespace -> Set(theirIdentityId) already hydrated from IndexedDB
  researchProjects: [],
  activeProjectId: null,
  pendingJoinRequests: new Map(), // projectId -> [{identityId, displayName, skillMd, peerId}]
  outgoingJoinRequests: new Map(), // projectId -> 'pending' | 'accepted' | 'declined'
  discoverableProjects: new Map(), // projectId -> {problem, chain, filledCount, initiatorDisplayName, fromPeerId}
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

async function migrateLegacyNamespaces() {
  const legacyMap = { job_candidate: 'employment', mission: 'business', service: 'independant' };
  const all = await db.getAll('identities');
  for (const rec of all) {
    if (legacyMap[rec.namespace]) {
      rec.namespace = legacyMap[rec.namespace];
      if (!rec.role && NS_CONFIG[rec.namespace].roles) rec.role = NS_CONFIG[rec.namespace].roles[0].key;
      await db.put('identities', rec);
    }
  }
}

async function boot() {
  await migrateLegacyNamespaces();

  for (const ns of NAMESPACES) {
    state.identitiesByNs[ns] = await identity.listIdentities(ns);
    state.discovered[ns] = new Map();
    state.pendingChats[ns] = new Map();
    state.chatLog[ns] = new Map();
    state.pendingMeetings[ns] = new Map();
    state.pendingDocs[ns] = new Map();
    state.identityToPeer[ns] = new Map();
    state.peerToIdentity[ns] = new Map();
    state.loadedConversations[ns] = new Set();
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
  state.activeNamespace = firstNonEmpty || 'employment';
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
      state.activeNamespace = ns;
      state.activeIdentityId[ns] = rec.identityId;
      toast(`Identity #${rec.identityId} created for ${cfg.label}${role ? ' (' + roleLabel(ns, role) + ')' : ''}`);
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
  return (await db.get('profiles', identityId)) || {
    identityId, sourceText: '', tokens: [], aiTokens: [],
    lookingForText: '', searchTokens: [],
    category: '', languages: [], availableNow: false,
    // Employment-specific (see editEmploymentProfileFlow):
    country: '', city: '',
    coverLetterText: '', cvFileName: '', cvExtractedText: '', earliestYear: null,
    jobPostingText: '', seniorityMin: null, seniorityMax: null,
    // Business / Independant specific:
    rate: null, budgetMin: null, budgetMax: null,
  };
}

function editProfileFlow(ns, id) {
  const cfg = NS_CONFIG[ns];
  const roleTag = id.role ? roleLabel(ns, id.role) : null;
  getProfile(id.identityId).then((profile) => {
    const isDating = cfg.kind === 'reciprocal';
    const sourceLabel = roleTag === 'Recruiter' ? 'Job posting (what you\'re hiring for)'
      : roleTag === 'Client' ? 'What you need (brief / request)'
      : roleTag === 'Utilisateur' ? 'What you need help with'
      : roleTag === 'Service' ? 'Describe the service you offer'
      : roleTag === 'Offer' ? 'Describe your offer'
      : roleTag === 'Candidate' ? 'Résumé / skills'
      : isDating ? 'About me'
      : 'Source text (résumé / offer / listing — stays local, never sent as-is)';

    openModal('Edit profile', `
      <label>Category / title</label>
      <input type="text" id="cat" value="${profile.category || ''}" placeholder="e.g. Backend Engineer">
      <label>Languages (comma separated)</label>
      <input type="text" id="langs" value="${(profile.languages || []).join(', ')}" placeholder="EN, PT">
      <label><input type="checkbox" id="avail" ${profile.availableNow ? 'checked' : ''}> Available now</label>
      <label>${sourceLabel}</label>
      <textarea id="src" placeholder="Paste text, or load a .txt file below">${profile.sourceText || ''}</textarea>
      <label>Or load from a .txt file</label>
      <input type="file" id="file" accept=".txt,text/plain">
      ${isDating ? `
        <label>What I'm looking for</label>
        <textarea id="looking" placeholder="Describe who/what you're looking for">${profile.lookingForText || ''}</textarea>
      ` : ''}
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
        const lookingForText = isDating ? dlg.querySelector('#looking').value : '';
        const searchTokens = isDating ? matching.tokenize(lookingForText) : [];
        await db.put('profiles', {
          identityId: id.identityId, sourceText, category, languages, availableNow,
          tokens, aiTokens: profile.aiTokens || [], lookingForText, searchTokens,
          updatedAt: Date.now(),
        });
        toast('Profile saved locally');
        renderWorkspace();
      },
    });
  });
}

function editEmploymentProfileFlow(id) {
  getProfile(id.identityId).then((profile) => {
    const isCandidate = id.role === 'candidate';
    const common = `
      <label>${isCandidate ? 'Desired position / title' : 'Position title'}</label>
      <input type="text" id="cat" value="${profile.category || ''}" placeholder="e.g. Backend Engineer">
      <label>Country</label>
      <input type="text" id="country" value="${profile.country || ''}" placeholder="e.g. Switzerland">
      <label>City</label>
      <input type="text" id="city" value="${profile.city || ''}" placeholder="e.g. Lausanne">
    `;

    const candidateFields = `
      <label>Cover letter — shared only when a recruiter requests it, never used for keyword matching</label>
      <textarea id="cover" placeholder="Your motivation letter…">${profile.coverLetterText || ''}</textarea>
      <label>CV file (.docx or .pdf) — this is what keywords are extracted from</label>
      <input type="file" id="cv" accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
      <div id="cvStatus" style="font-size:11.5px;color:var(--low);margin-top:4px">
        ${profile.cvFileName ? `Current file: ${profile.cvFileName} (${profile.tokens.length} keywords, earliest year detected: ${profile.earliestYear ?? '—'})` : 'No CV uploaded yet'}
      </div>
      <label><input type="checkbox" id="avail" ${profile.availableNow ? 'checked' : ''}> Available now</label>
    `;

    const recruiterFields = `
      <label>Seniority range you're hiring for — checked against the earliest year found in each candidate's CV</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="senMin" value="${profile.seniorityMin ?? ''}" placeholder="Min year, e.g. 2010" style="flex:1">
        <input type="text" id="senMax" value="${profile.seniorityMax ?? ''}" placeholder="Max year, e.g. 2020" style="flex:1">
      </div>
      <label>Job posting text — this IS used for keyword matching, and is shown to candidates as-is</label>
      <textarea id="posting" placeholder="Paste the job ad…">${profile.jobPostingText || ''}</textarea>
    `;

    openModal(`Edit profile — ${roleLabel('employment', id.role)}`, common + (isCandidate ? candidateFields : recruiterFields), {
      submitLabel: 'Save profile',
      onSubmit: async (dlg) => {
        const category = dlg.querySelector('#cat').value.trim();
        const country = dlg.querySelector('#country').value.trim();
        const city = dlg.querySelector('#city').value.trim();

        if (isCandidate) {
          const coverLetterText = dlg.querySelector('#cover').value; // never tokenized
          const availableNow = dlg.querySelector('#avail').checked;
          const file = dlg.querySelector('#cv').files[0];

          let { cvFileName, cvExtractedText, tokens, earliestYear } = profile;
          if (file) {
            toast('Extracting text from ' + file.name + '…');
            try {
              cvExtractedText = await extract.extractText(file);
              cvFileName = file.name;
              tokens = matching.tokenize(cvExtractedText + ' ' + category);
              earliestYear = matching.extractEarliestYear(cvExtractedText);
              toast(`Extracted ${tokens.length} keywords from ${file.name}${earliestYear ? `, earliest year ${earliestYear}` : ''}`);
            } catch (e) {
              toast('Could not read that file: ' + e.message);
              return;
            }
          }

          await db.put('profiles', {
            ...profile, category, country, city, coverLetterText, availableNow,
            cvFileName, cvExtractedText, tokens, earliestYear,
            updatedAt: Date.now(),
          });
        } else {
          const jobPostingText = dlg.querySelector('#posting').value;
          const seniorityMin = dlg.querySelector('#senMin').value.trim();
          const seniorityMax = dlg.querySelector('#senMax').value.trim();
          const tokens = matching.tokenize(jobPostingText + ' ' + category);
          await db.put('profiles', {
            ...profile, category, country, city, jobPostingText, tokens,
            seniorityMin: seniorityMin ? parseInt(seniorityMin, 10) : null,
            seniorityMax: seniorityMax ? parseInt(seniorityMax, 10) : null,
            updatedAt: Date.now(),
          });
        }
        toast('Profile saved locally');
        renderWorkspace();
      },
    });
  });
}

// Business / Independant profile editor — same asymmetric mechanic as
// Employment (a single declared value on the supply side, checked against
// a range declared on the demand side) but with a rate/budget instead of a
// seniority year, and the attachment is optional and additive rather than
// the sole keyword source: the description text always gets tokenized,
// and a file — if provided — adds to it rather than replacing it.
function editSupplyDemandProfileFlow(ns, id) {
  const cfg = NS_CONFIG[ns];
  const isSupply = id.role === cfg.roles[0].key; // offer / provider
  getProfile(id.identityId).then((profile) => {
    const common = `
      <label>${isSupply ? 'What you offer — category' : 'What you need — category'}</label>
      <input type="text" id="cat" value="${profile.category || ''}" placeholder="e.g. Web development">
      <label>Country</label>
      <input type="text" id="country" value="${profile.country || ''}" placeholder="e.g. Switzerland">
      <label>City</label>
      <input type="text" id="city" value="${profile.city || ''}" placeholder="e.g. Lausanne">
    `;

    const supplyFields = `
      <label>Your rate (numeric — checked against declared budgets)</label>
      <input type="text" id="rate" value="${profile.rate ?? ''}" placeholder="e.g. 650">
      <label>Description of what you offer — this is what gets matched</label>
      <textarea id="desc" placeholder="Describe your expertise or service">${profile.sourceText || ''}</textarea>
      <label>Optional: attach a portfolio/CV (.docx or .pdf) to add more keywords — it enriches the description above, it doesn't replace it</label>
      <input type="file" id="file" accept=".docx,.pdf,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
      <div id="fileStatus" style="font-size:11.5px;color:var(--low);margin-top:4px">${profile.cvFileName ? `Attached: ${profile.cvFileName}` : 'No file attached'}</div>
      <label><input type="checkbox" id="avail" ${profile.availableNow ? 'checked' : ''}> Available now</label>
    `;

    const demandFields = `
      <label>Budget range (numeric — checked against declared rates)</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="budgetMin" value="${profile.budgetMin ?? ''}" placeholder="Min" style="flex:1">
        <input type="text" id="budgetMax" value="${profile.budgetMax ?? ''}" placeholder="Max" style="flex:1">
      </div>
      <label>Describe what you need — this is what gets matched, and is shown to candidates as-is</label>
      <textarea id="desc" placeholder="Describe your request">${profile.sourceText || ''}</textarea>
    `;

    openModal(`Edit profile — ${roleLabel(ns, id.role)}`, common + (isSupply ? supplyFields : demandFields), {
      submitLabel: 'Save profile',
      onSubmit: async (dlg) => {
        const category = dlg.querySelector('#cat').value.trim();
        const country = dlg.querySelector('#country').value.trim();
        const city = dlg.querySelector('#city').value.trim();
        const desc = dlg.querySelector('#desc').value;

        if (isSupply) {
          const availableNow = dlg.querySelector('#avail').checked;
          const rate = dlg.querySelector('#rate').value.trim();
          let { cvFileName, cvExtractedText } = profile;
          const file = dlg.querySelector('#file').files[0];
          if (file) {
            toast('Extracting text from ' + file.name + '…');
            try {
              cvExtractedText = await extract.extractText(file);
              cvFileName = file.name;
              toast(`Extracted text from ${file.name}`);
            } catch (e) {
              toast('Could not read that file: ' + e.message);
              return;
            }
          }
          const tokens = matching.tokenize([desc, category, cvExtractedText].filter(Boolean).join(' '));
          await db.put('profiles', {
            ...profile, category, country, city, sourceText: desc, tokens,
            cvFileName, cvExtractedText, rate: rate ? parseFloat(rate) : null, availableNow,
            updatedAt: Date.now(),
          });
        } else {
          const budgetMin = dlg.querySelector('#budgetMin').value.trim();
          const budgetMax = dlg.querySelector('#budgetMax').value.trim();
          const tokens = matching.tokenize(desc + ' ' + category);
          await db.put('profiles', {
            ...profile, category, country, city, sourceText: desc, tokens,
            budgetMin: budgetMin ? parseFloat(budgetMin) : null,
            budgetMax: budgetMax ? parseFloat(budgetMax) : null,
            updatedAt: Date.now(),
          });
        }
        toast('Profile saved locally');
        renderWorkspace();
      },
    });
  });
}


async function enrichProfileWithAI(ns, id) {
  if (!llm.isWebGPUAvailable()) { toast('WebGPU not available — local AI enrichment is disabled on this device.'); return; }
  const profile = await getProfile(id.identityId);
  const textToEnrich = ns === 'employment'
    ? (id.role === 'candidate' ? profile.cvExtractedText : profile.jobPostingText)
    : profile.sourceText;
  if (!textToEnrich) { toast('Add source text to your profile first.'); return; }
  toast('Loading local model — first run downloads weights, this can take a while…');
  try {
    const extra = await llm.enrichKeywords(textToEnrich, (p) => { if (p.text) toast(p.text); });
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
          const cfg = NS_CONFIG[ns];
          const payload = {
            category: profile.category,
            tokens: [...profile.tokens, ...profile.aiTokens].slice(0, 30),
            languages: profile.languages,
            availableNow: profile.availableNow,
          };
          if (cfg.kind === 'twoSided') payload.role = id.role;
          if (cfg.kind === 'reciprocal') payload.searchTokens = profile.searchTokens.slice(0, 30);
          if (cfg.kind === 'twoSided') {
            payload.country = profile.country;
            payload.city = profile.city;
            const isSupply = id.role === cfg.roles[0].key; // candidate / offer / provider
            if (ns === 'employment') {
              if (isSupply) {
                payload.earliestYear = profile.earliestYear;
              } else {
                payload.seniorityMin = profile.seniorityMin;
                payload.seniorityMax = profile.seniorityMax;
                payload.postingText = profile.jobPostingText; // job ads are public, unlike CVs
              }
            } else if (ns === 'business' || ns === 'independant') {
              if (isSupply) {
                payload.rate = profile.rate;
              } else {
                payload.budgetMin = profile.budgetMin;
                payload.budgetMax = profile.budgetMax;
                payload.postingText = profile.sourceText; // the request/mission text is public
              }
            }
          }
          p2p.getRoom(ns).send('discovery', id.identityId, payload, peerId);
        },
        onPeerLeave: (peerId) => {
          const theirIdentityId = state.peerToIdentity[ns].get(peerId);
          if (theirIdentityId) state.identityToPeer[ns].delete(theirIdentityId);
          state.peerToIdentity[ns].delete(peerId);
          renderWorkspace();
          renderTopbar();
        },
        onMessage: (msg, peerId) => handleIncomingMessage(ns, msg, peerId),
        onBlob: (blob, peerId, metadata) => {
          const theirIdentityId = state.peerToIdentity[ns].get(peerId) || peerId;
          const entry = {
            from: 'them', kind: 'attachment', ts: Date.now(),
            name: metadata.name || 'file', size: blob.size, url: URL.createObjectURL(blob),
          };
          if (!state.chatLog[ns].has(theirIdentityId)) state.chatLog[ns].set(theirIdentityId, []);
          state.chatLog[ns].get(theirIdentityId).push(entry);
          state.loadedConversations[ns].add(theirIdentityId);
          persistMessage(ns, theirIdentityId, { ...entry, url: undefined, blob });
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

function proposeMeetingFlow(ns, id, theirIdentityId) {
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
      const peerId = state.identityToPeer[ns].get(theirIdentityId);
      if (!peerId) { toast('This peer is not currently connected.'); return; }
      p2p.getRoom(ns).send('meeting_proposal', id.identityId, { when, note }, peerId);
      state.pendingMeetings[ns].set(theirIdentityId, { status: 'outgoing', when, note });
      renderWorkspace();
    },
  });
}

function respondMeeting(ns, id, theirIdentityId, accept) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const m = state.pendingMeetings[ns].get(theirIdentityId) || {};
  if (peerId) p2p.getRoom(ns).send(accept ? 'meeting_accept' : 'meeting_decline', id.identityId, { when: m.when }, peerId);
  if (accept) state.pendingMeetings[ns].set(theirIdentityId, { ...m, status: 'accepted' });
  else state.pendingMeetings[ns].delete(theirIdentityId);
  renderWorkspace();
}

/* ---- Document request/offer (Employment cover letter, spec-adjacent) -- */

function requestDocument(ns, id, theirIdentityId, doc) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is not currently connected.'); return; }
  p2p.getRoom(ns).send('document_request', id.identityId, { doc }, peerId);
  state.pendingDocs[ns].set(theirIdentityId, { status: 'outgoing', doc });
  renderWorkspace();
}

async function shareDocument(ns, id, theirIdentityId, doc) {
  const profile = await getProfile(id.identityId);
  const text = doc === 'cover_letter' ? profile.coverLetterText : '';
  if (!text) { toast('Nothing to share yet — write it in your profile first.'); return; }
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is no longer connected.'); return; }
  p2p.getRoom(ns).send('document_offer', id.identityId, { doc, text }, peerId);
  state.pendingDocs[ns].set(theirIdentityId, { status: 'shared', doc });
  renderWorkspace();
}

function declineDocument(ns, theirIdentityId) {
  state.pendingDocs[ns].delete(theirIdentityId);
  renderWorkspace();
}

/* ---- Chat persistence: messages survive reload, keyed by the other ---- */
/* ---- side's stable identity, not their ephemeral WebRTC peer id.   ---- */

function conversationRoom(ns, theirIdentityId) {
  return `${ns}:${theirIdentityId}`;
}

async function persistMessage(ns, theirIdentityId, record) {
  const stored = {
    messageId: crypto.randomUUID(),
    room: conversationRoom(ns, theirIdentityId),
    ns, counterpart: theirIdentityId,
    ...record,
  };
  await db.put('messages', stored);
  return stored;
}

async function loadConversation(ns, theirIdentityId) {
  if (state.loadedConversations[ns].has(theirIdentityId)) return state.chatLog[ns].get(theirIdentityId) || [];
  const rows = await db.getAll('messages', 'room', conversationRoom(ns, theirIdentityId));
  const log = rows.sort((a, b) => a.ts - b.ts).map((r) => ({
    from: r.from, kind: r.kind, ts: r.ts, text: r.text, name: r.name, size: r.size, delivered: r.delivered,
    url: r.blob ? URL.createObjectURL(r.blob) : r.url,
  }));
  state.chatLog[ns].set(theirIdentityId, log);
  state.loadedConversations[ns].add(theirIdentityId);
  return log;
}

// Every persisted conversation in this namespace, most recent first — so a
// past chat can be reopened and read even if that peer isn't online right now.
async function listConversations(ns) {
  const all = await db.getAll('messages');
  const byCounterpart = new Map();
  for (const m of all) {
    if (m.ns !== ns) continue;
    const existing = byCounterpart.get(m.counterpart);
    if (!existing || m.ts > existing.ts) byCounterpart.set(m.counterpart, m);
  }
  return [...byCounterpart.values()].sort((a, b) => b.ts - a.ts);
}

// Any message written while the recipient was offline is saved with
// delivered:false. The moment we see that identity connect again (any
// message from them proves it), flush whatever's queued for them — no
// separate polling, no server, just "did we just learn they're back".
async function flushOutbox(ns, theirIdentityId) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const myIdentityId = state.activeIdentityId[ns];
  const room = p2p.getRoom(ns);
  if (!peerId || !myIdentityId || !room) return;

  const rows = await db.getAll('messages', 'room', conversationRoom(ns, theirIdentityId));
  const pending = rows.filter((r) => r.from === 'me' && r.delivered === false).sort((a, b) => a.ts - b.ts);
  if (!pending.length) return;

  for (const r of pending) {
    if (r.kind === 'attachment' && r.blob) {
      room.sendBlob(r.blob, peerId, { name: r.name, size: r.size, type: r.blob.type });
    } else {
      room.send('chat_message', myIdentityId, { text: r.text }, peerId);
    }
    r.delivered = true;
    await db.put('messages', r);
  }
  state.loadedConversations[ns].delete(theirIdentityId); // force a re-hydrate so delivered state is fresh next open
  toast(`Delivered ${pending.length} queued message${pending.length > 1 ? 's' : ''} to ${theirIdentityId.slice(0, 8)}…`);
  renderWorkspace();
}

function handleIncomingMessage(ns, msg, peerId) {
  if (state.blocked[ns]?.has(msg.sender)) return; // local blocklist — silently drop

  // Keep the identity<->live-peer mapping fresh from every message we see,
  // so chat/meetings/documents can be keyed by stable identity while still
  // being able to resolve who to actually send to right now.
  if (msg.sender && peerId) {
    const wasOffline = !state.identityToPeer[ns].has(msg.sender);
    state.peerToIdentity[ns].set(peerId, msg.sender);
    state.identityToPeer[ns].set(msg.sender, peerId);
    if (wasOffline) flushOutbox(ns, msg.sender);
  }

  if (msg.type === 'discovery') {
    state.discovered[ns].set(peerId, { ...msg.payload, namespace: ns, v: msg.v, sender: msg.sender, peerId, lastSeen: Date.now() });
    renderWorkspace();
  } else if (msg.type === 'meeting_proposal') {
    state.pendingMeetings[ns].set(msg.sender, { status: 'incoming', when: msg.payload.when, note: msg.payload.note });
    toast(`Meeting proposed: ${msg.payload.when}`);
    renderWorkspace();
  } else if (msg.type === 'meeting_accept') {
    state.pendingMeetings[ns].set(msg.sender, { status: 'accepted', when: msg.payload.when });
    toast('Meeting accepted');
    renderWorkspace();
  } else if (msg.type === 'meeting_decline') {
    state.pendingMeetings[ns].delete(msg.sender);
    toast('Meeting declined');
    renderWorkspace();
  } else if (msg.type === 'document_request') {
    state.pendingDocs[ns].set(msg.sender, { status: 'incoming', doc: msg.payload.doc });
    toast(`${msg.sender.slice(0, 6)}… requested your ${msg.payload.doc.replace('_', ' ')}`);
    renderWorkspace();
  } else if (msg.type === 'document_offer') {
    state.pendingDocs[ns].set(msg.sender, { status: 'received', doc: msg.payload.doc, text: msg.payload.text });
    toast(`Received ${msg.payload.doc.replace('_', ' ')}`);
    renderWorkspace();
  } else if (msg.type === 'chat_request') {
    state.pendingChats[ns].set(msg.sender, { status: 'incoming' });
    toast(`Chat request from ${msg.sender.slice(0, 6)}…`);
    renderWorkspace();
  } else if (msg.type === 'chat_accept') {
    state.pendingChats[ns].set(msg.sender, { status: 'accepted' });
    loadConversation(ns, msg.sender).then(() => {
      state.openChatWith[ns] = msg.sender;
      renderWorkspace();
    });
  } else if (msg.type === 'chat_decline') {
    state.pendingChats[ns].delete(msg.sender);
    toast('Chat request declined');
    renderWorkspace();
  } else if (msg.type === 'chat_message') {
    if (!state.chatLog[ns].has(msg.sender)) state.chatLog[ns].set(msg.sender, []);
    const entry = { from: 'them', text: msg.payload.text, ts: msg.timestamp };
    state.chatLog[ns].get(msg.sender).push(entry);
    state.loadedConversations[ns].add(msg.sender); // avoid re-fetching and duplicating on next open
    persistMessage(ns, msg.sender, entry);
    renderWorkspace();
  } else if (msg.type === 'identity_retired') {
    toast(`Peer identity retired: #${msg.payload.retiredId} → #${msg.payload.rotatedTo}`);
  } else if (msg.type === 'research_sync_request') {
    handleResearchSyncRequest(ns, msg, peerId);
  } else if (msg.type === 'research_sync_response') {
    handleResearchSyncResponse(msg);
  } else if (msg.type === 'research_join_request') {
    handleResearchJoinRequest(msg, peerId);
  } else if (msg.type === 'research_join_accept') {
    handleResearchJoinAccept(msg);
  } else if (msg.type === 'research_join_decline') {
    handleResearchJoinDecline(msg);
  } else if (msg.type === 'research_project_update') {
    handleResearchProjectUpdate(msg);
  } else if (msg.type === 'research_project_announce') {
    handleResearchProjectAnnounce(msg, peerId);
  } else if (msg.type === 'research_artifact') {
    research.mergeArtifact(msg.payload.artifact).then(() => {
      if (msg.payload.artifact.projectId === state.activeProjectId) renderWorkspace();
    });
  }
}

function requestChat(ns, id, theirIdentityId) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is not currently connected.'); return; }
  const room = p2p.getRoom(ns);
  room.send('chat_request', id.identityId, {}, peerId);
  state.pendingChats[ns].set(theirIdentityId, { status: 'outgoing' });
  renderWorkspace();
}

function respondChat(ns, id, theirIdentityId, accept) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is no longer connected.'); return; }
  const room = p2p.getRoom(ns);
  room.send(accept ? 'chat_accept' : 'chat_decline', id.identityId, {}, peerId);
  if (accept) { state.pendingChats[ns].set(theirIdentityId, { status: 'accepted' }); state.openChatWith[ns] = theirIdentityId; }
  else state.pendingChats[ns].delete(theirIdentityId);
  renderWorkspace();
}

async function sendChatMessage(ns, id, theirIdentityId, text) {
  if (!text.trim()) return;
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const entry = { from: 'me', text, ts: Date.now(), delivered: !!peerId };
  if (!state.chatLog[ns].has(theirIdentityId)) state.chatLog[ns].set(theirIdentityId, []);
  state.chatLog[ns].get(theirIdentityId).push(entry);
  state.loadedConversations[ns].add(theirIdentityId);
  await persistMessage(ns, theirIdentityId, entry);
  if (peerId) {
    p2p.getRoom(ns).send('chat_message', id.identityId, { text }, peerId);
  } else {
    toast('Saved locally — this peer is offline right now. It\'ll be sent automatically as soon as they\'re seen back online.');
  }
  renderWorkspace();
}

function scoreAgainstPeer(cfg, myTokens, myLookingForTokens, p) {
  if (cfg.kind === 'reciprocal') {
    const forward = matching.matchTokens(myLookingForTokens, p.tokens || []);   // does their profile fit what I want
    const backward = matching.matchTokens(p.searchTokens || [], myTokens);       // does my profile fit what they want
    return { score: Math.min(forward.score, backward.score), forward, backward };
  }
  return matching.matchTokens(myTokens, p.tokens || []);
}

function explainMatch(cfg, match) {
  return cfg.kind === 'reciprocal'
    ? {
        pos: [
          `They fit what you're looking for: ${match.forward.score}%`,
          `You fit what they're looking for: ${match.backward.score}%`,
          ...matching.explain(match.forward).pos.slice(0, 3),
        ],
        neg: matching.explain(match.backward).neg,
      }
    : matching.explain(match);
}

// Real P2P discovery needs a second peer — one browser tab is one WebRTC
// identity, so two identities created in the *same* tab can never discover
// each other over the network. This computes the same match directly from
// local data so you can sanity-check matching without needing a second tab.
async function localTestMatches(ns, cfg, id, myTokens, myLookingForTokens) {
  if (cfg.kind === 'research') return [];
  const wantRole = cfg.kind === 'twoSided' ? complementaryRole(ns, id.role) : null;
  const candidates = state.identitiesByNs[ns].filter((other) =>
    other.identityId !== id.identityId && other.active &&
    (cfg.kind !== 'twoSided' || other.role === wantRole)
  );
  const out = [];
  for (const other of candidates) {
    const p2 = await getProfile(other.identityId);
    const peerLike = {
      sender: other.identityId, displayName: other.displayName, category: p2.category,
      tokens: [...p2.tokens, ...(p2.aiTokens || [])], searchTokens: p2.searchTokens,
      country: p2.country, city: p2.city, earliestYear: p2.earliestYear,
      seniorityMin: p2.seniorityMin, seniorityMax: p2.seniorityMax,
      languages: p2.languages, availableNow: p2.availableNow,
    };
    const match = scoreAgainstPeer(cfg, myTokens, myLookingForTokens, peerLike);
    out.push({ ...peerLike, match });
  }
  return out.sort((a, b) => b.match.score - a.match.score);
}

async function renderClassicWorkspace(ns) {
  const cfg = NS_CONFIG[ns];
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  if (!id) return `<div class="empty-state"><p>Create an identity in ${cfg.label} to get started.</p><button class="btn primary" id="createHere">Create identity</button></div>`;

  const profile = await getProfile(id.identityId);
  const myTokens = [...profile.tokens, ...(state.aiOn[ns] ? profile.aiTokens : [])];
  const myLookingForTokens = profile.searchTokens || [];

  const now = Date.now();
  const peers = [...state.discovered[ns].values()]
    .filter((p) => now - (p.lastSeen || 0) < PEER_TTL_MS)
    .filter((p) => !state.blocked[ns].has(p.sender));

  const hardConstraints = { requiredLanguages: profile.languages };
  if (cfg.kind === 'twoSided') hardConstraints.requiredRole = complementaryRole(ns, id.role);
  const softConstraints = { preferredCategory: profile.category };
  const isSupplySide = cfg.kind === 'twoSided' && id.role === cfg.roles[0].key;
  if (ns === 'employment') {
    softConstraints.country = profile.country;
    softConstraints.city = profile.city;
    if (!isSupplySide && (profile.seniorityMin != null || profile.seniorityMax != null)) {
      hardConstraints.seniorityRange = { min: profile.seniorityMin, max: profile.seniorityMax };
    }
    if (isSupplySide && profile.earliestYear != null) {
      hardConstraints.myEarliestYear = profile.earliestYear;
    }
  } else if (ns === 'business' || ns === 'independant') {
    softConstraints.country = profile.country;
    softConstraints.city = profile.city;
    if (!isSupplySide && (profile.budgetMin != null || profile.budgetMax != null)) {
      hardConstraints.rateRange = { min: profile.budgetMin, max: profile.budgetMax };
    }
    if (isSupplySide && profile.rate != null) {
      hardConstraints.myRate = profile.rate;
    }
  }

  const cascade = discovery.runCascade(peers, {
    myNamespace: ns,
    protocolVersion: PROTOCOL_VERSION,
    hardConstraints,
    softConstraints,
  });

  const scored = cascade.pool
    .map((p) => ({ ...p, match: scoreAgainstPeer(cfg, myTokens, myLookingForTokens, p) }))
    .sort((a, b) => b.match.score - a.match.score);

  const localMatches = await localTestMatches(ns, cfg, id, myTokens, myLookingForTokens);

  const funnelHtml = cascade.stages.map((s, i) => `
      <div class="stage"><div class="n">${s.count}</div><div class="lbl">${s.label}</div></div>
      ${i < cascade.stages.length - 1 ? '<div class="arrow">→</div>' : ''}
    `).join('');

  const myRoleLabel = id.role ? roleLabel(ns, id.role) : null;
  const theirRoleLabel = cfg.kind === 'twoSided' ? roleLabel(ns, complementaryRole(ns, id.role)) : null;

  function metaChips(p) {
    if (ns === 'employment') {
      return `
        <span class="chip">${[p.city, p.country].filter(Boolean).join(', ') || 'no location declared'}</span>
        ${isSupplySide && p.postingText ? `<span class="chip">${p.seniorityMin ?? '…'}–${p.seniorityMax ?? '…'} yrs range</span>` : ''}
        ${!isSupplySide ? `<span class="chip">${p.earliestYear ? 'earliest year ' + p.earliestYear : 'no dates detected'}</span><span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>` : ''}
      `;
    }
    if (ns === 'business' || ns === 'independant') {
      return `
        <span class="chip">${[p.city, p.country].filter(Boolean).join(', ') || 'no location declared'}</span>
        ${isSupplySide && p.postingText ? `<span class="chip">budget ${p.budgetMin ?? '…'}–${p.budgetMax ?? '…'}</span>` : ''}
        ${!isSupplySide ? `<span class="chip">${p.rate != null ? 'rate ' + p.rate : 'no rate declared'}</span><span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>` : ''}
      `;
    }
    return `
      <span class="chip">${(p.languages || []).join(' / ') || 'no language declared'}</span>
      <span class="chip">${p.availableNow ? 'Available now' : 'Availability unknown'}</span>
    `;
  }

  function renderCard(p, { local = false } = {}) {
    const ex = explainMatch(cfg, p.match);
    const chat = local ? null : state.pendingChats[ns].get(p.sender);
    const meeting = local ? null : state.pendingMeetings[ns].get(p.sender);
    const doc = local ? null : state.pendingDocs[ns].get(p.sender);
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
    const docHtml = doc ? `
        <div class="meeting-banner">
          ${doc.status === 'incoming'
            ? `They requested your ${doc.doc.replace('_', ' ')}.
               <button class="btn small primary doc-share" data-doc="${doc.doc}">Share</button>
               <button class="btn small doc-decline">Decline</button>`
            : doc.status === 'outgoing'
              ? `Requested their ${doc.doc.replace('_', ' ')}, awaiting reply…`
              : doc.status === 'shared'
                ? `You shared your ${doc.doc.replace('_', ' ')}.`
                : `Received their ${doc.doc.replace('_', ' ')}: <button class="btn small ghost view-doc">View</button>`}
        </div>` : '';
    const postingPreview = (isSupplySide && p.postingText)
      ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11.5px;color:var(--low)">View ${ns === 'employment' ? 'posting' : 'request'} text</summary><div style="font-size:12px;color:var(--mid);white-space:pre-wrap;margin-top:6px">${p.postingText}</div></details>` : '';

    return `
        <div class="card" data-peer="${p.peerId || ''}" data-identity="${p.sender}">
          <div class="top">
            <span class="avatar">${(p.category || 'PR').slice(0, 2).toUpperCase()}</span>
            <div class="info">
              <div class="name">${local ? (p.displayName || 'Local test identity') : p.sender.slice(0, 10) + '…'}${theirRoleLabel ? ` <span class="role-badge">${theirRoleLabel}</span>` : ''}${local ? ' <span class="role-badge" style="color:var(--low);border-color:var(--border)">local test</span>' : ''}</div>
              <div class="role">${p.category || 'No category declared'}</div>
              <div class="meta">${metaChips(p)}</div>
            </div>
            <div class="score">
              <div class="pct">${p.match.score}%</div>
              <div class="bar"><i style="width:${p.match.score}%"></i></div>
            </div>
          </div>
          <div class="expl">${ex.pos.map((t) => `<div class="p">${t}</div>`).join('')}${ex.neg.map((t) => `<div class="m">${t}</div>`).join('')}</div>
          ${postingPreview}
          ${meetingHtml}
          ${docHtml}
          <div class="actions">
            <button class="btn ghost toggle-expl">Why this score</button>
            ${local ? '' : (chat && chat.status === 'incoming'
              ? `<button class="btn primary respond-yes">Accept chat</button><button class="btn respond-no">Decline</button>`
              : chat && chat.status === 'accepted'
                ? `<button class="btn primary open-chat">Open chat</button><button class="btn ghost propose-meeting">Propose meeting</button>`
                : chat && chat.status === 'outgoing'
                  ? `<button class="btn" disabled>Request sent…</button>`
                  : `<button class="btn primary request-chat">Start conversation</button>`)}
            ${!local && ns === 'employment' && id.role === 'recruiter' && !doc ? `<button class="btn ghost request-doc" data-doc="cover_letter">Request cover letter</button>` : ''}
            ${local ? '' : `<button class="btn ghost block-peer">Block</button>`}
          </div>
        </div>`;
  }

  const resultsHtml = scored.length === 0
    ? `<div class="empty-state">No ${theirRoleLabel ? theirRoleLabel.toLowerCase() + ' ' : ''}peers discovered yet on this namespace.<br>Open Jobber in another browser tab, device, or share this build with someone else — discovery is real WebRTC, it just needs a second peer.</div>`
    : scored.map((p) => renderCard(p)).join('');

  const localHtml = localMatches.length ? `
    <div class="k" style="margin:18px 0 8px">Local test matches</div>
    <p class="section-sub" style="margin-bottom:10px">Other ${theirRoleLabel || ''} identities you created in this browser — useful to sanity-check matching without a second device. These never go over the network.</p>
    <div class="results">${localMatches.map((p) => renderCard(p, { local: true })).join('')}</div>
  ` : '';

  const chatPeer = state.openChatWith[ns];
  if (chatPeer) await loadConversation(ns, chatPeer); // defensive — most entry points already hydrate before opening
  const chatHtml = chatPeer ? renderChatPanel(ns, id, chatPeer) : '';

  const conversations = await listConversations(ns);
  const conversationsHtml = conversations.length ? `
    <div class="panel">
      <div class="k">Conversations</div>
      ${conversations.map((c) => {
        const online = state.identityToPeer[ns].has(c.counterpart);
        const preview = c.kind === 'attachment' ? `📎 ${c.name}` : (c.text || '').slice(0, 60);
        return `
          <div class="agree-row">
            <span class="k2">
              <span class="online-dot ${online ? 'on' : ''}" style="margin-right:6px"></span>
              ${c.counterpart.slice(0, 10)}… — ${preview}
            </span>
            <button class="btn small ghost conv-open" data-identity="${c.counterpart}">Open</button>
          </div>`;
      }).join('')}
    </div>` : '';

  return `
    <h2 class="section-title">${cfg.label}${myRoleLabel ? ` — ${myRoleLabel}` : ''} — ${state.searchLive[ns] ? 'searching live' : 'search paused'}</h2>
    <p class="section-sub">${cfg.hint}</p>

    <div class="panel">
      <div class="k">Your profile${myRoleLabel ? ` (${myRoleLabel})` : ''}</div>
      <div>${profile.category ? `<b>${profile.category}</b>` : '<span style="color:var(--low)">No category set</span>'}</div>
      ${ns === 'employment' || ns === 'business' || ns === 'independant' ? `<div style="font-size:11.5px;color:var(--low);margin-top:2px">${[profile.city, profile.country].filter(Boolean).join(', ') || 'No location set'}${(ns === 'business' || ns === 'independant') ? (isSupplySide ? (profile.rate != null ? ` · rate ${profile.rate}` : '') : ((profile.budgetMin != null || profile.budgetMax != null) ? ` · budget ${profile.budgetMin ?? '…'}–${profile.budgetMax ?? '…'}` : '')) : ''}</div>` : ''}
      <div class="chiprow">
        ${profile.tokens.slice(0, 10).map((t) => `<span class="chip">${t}</span>`).join('')}
        ${(state.aiOn[ns] ? profile.aiTokens : []).slice(0, 10).map((t) => `<span class="chip ai">◆ ${t}</span>`).join('')}
        ${!profile.tokens.length && !profile.aiTokens.length ? '<span style="color:var(--low);font-size:11px">No keywords extracted yet</span>' : ''}
      </div>
      ${cfg.kind === 'reciprocal' ? `
        <div class="k" style="margin-top:10px">Looking for</div>
        <div class="chiprow">
          ${myLookingForTokens.slice(0, 10).map((t) => `<span class="chip" style="border-color:var(--agent);color:var(--agent)">${t}</span>`).join('')}
          ${!myLookingForTokens.length ? '<span style="color:var(--low);font-size:11px">Not set yet</span>' : ''}
        </div>` : ''}
      <div class="actions" style="margin-top:12px">
        <button class="btn" id="editProfile">Edit profile</button>
        <button class="btn" id="enrichAI">Enrich with local AI</button>
      </div>
    </div>

    ${chatHtml}
    ${!chatPeer ? conversationsHtml : ''}
    <div class="funnel">${funnelHtml}</div>
    <div class="results">${resultsHtml}</div>
    ${localHtml}
  `;
}

function renderChatPanel(ns, id, theirIdentityId) {
  const log = state.chatLog[ns].get(theirIdentityId) || [];
  const connected = state.identityToPeer[ns].has(theirIdentityId);
  const bubble = (m) => {
    const queued = m.from === 'me' && m.delivered === false ? ' <span style="opacity:.6;font-size:10px">· queued</span>' : '';
    return m.kind === 'attachment'
      ? `<a class="chat-msg attachment ${m.from === 'me' ? 'mine' : ''}" href="${m.url}" download="${m.name}">📎 ${m.name} <span>(${(m.size / 1024).toFixed(1)} KB)</span>${queued}</a>`
      : `<div class="chat-msg ${m.from === 'me' ? 'mine' : ''}">${m.text}${queued}</div>`;
  };
  return `
    <div class="panel" style="margin-top:16px">
      <div class="chat">
        <div class="chat-head">
          <button class="btn small ghost" id="closeChat" style="margin-right:8px">← Back</button>
          Conversation with ${theirIdentityId.slice(0, 10)}…
          ${connected ? '' : '<span style="color:var(--low);font-weight:400;margin-left:8px">· offline, showing history</span>'}
        </div>
        <div class="chat-log" id="chatLog">
          ${log.map(bubble).join('') || '<div style="color:var(--low);font-size:12px">Say hello — this goes straight over WebRTC, no server in between. Saved locally, so it\'s still here next time you open Jobber.</div>'}
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

async function sendChatFile(ns, id, theirIdentityId, file) {
  const blob = file.slice(0, file.size, file.type); // ensure a real Blob, storable as-is in IndexedDB
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const entry = { from: 'me', kind: 'attachment', ts: Date.now(), name: file.name, size: file.size, url: URL.createObjectURL(file), delivered: !!peerId };
  if (!state.chatLog[ns].has(theirIdentityId)) state.chatLog[ns].set(theirIdentityId, []);
  state.chatLog[ns].get(theirIdentityId).push(entry);
  state.loadedConversations[ns].add(theirIdentityId);
  await persistMessage(ns, theirIdentityId, { ...entry, url: undefined, blob }); // store the Blob itself, not the (session-only) object URL
  if (peerId) {
    p2p.getRoom(ns).sendBlob(file, peerId, { name: file.name, size: file.size, type: file.type });
  } else {
    toast('Saved locally — this peer is offline right now. It\'ll be sent automatically once they\'re seen back online.');
  }
  renderWorkspace();
}

function bindClassicEvents(ns) {
  const id = state.identitiesByNs[ns].find((i) => i.identityId === state.activeIdentityId[ns]);
  const ws = document.getElementById('workspace');

  ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow(ns));
  ws.querySelector('#editProfile')?.addEventListener('click', () => {
    if (ns === 'employment') editEmploymentProfileFlow(id);
    else if (ns === 'business' || ns === 'independant') editSupplyDemandProfileFlow(ns, id);
    else editProfileFlow(ns, id);
  });
  ws.querySelector('#enrichAI')?.addEventListener('click', () => enrichProfileWithAI(ns, id));

  ws.querySelectorAll('.toggle-expl').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.card');
      card.classList.toggle('open');
      btn.textContent = card.classList.contains('open') ? 'Hide explanation' : 'Why this score';
    });
  });
  ws.querySelectorAll('.request-chat').forEach((btn) => {
    btn.addEventListener('click', () => requestChat(ns, id, btn.closest('.card').dataset.identity));
  });
  ws.querySelectorAll('.respond-yes').forEach((btn) => {
    btn.addEventListener('click', () => respondChat(ns, id, btn.closest('.card').dataset.identity, true));
  });
  ws.querySelectorAll('.respond-no').forEach((btn) => {
    btn.addEventListener('click', () => respondChat(ns, id, btn.closest('.card').dataset.identity, false));
  });
  ws.querySelectorAll('.open-chat').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const theirIdentityId = btn.closest('.card').dataset.identity;
      await loadConversation(ns, theirIdentityId);
      state.openChatWith[ns] = theirIdentityId;
      renderWorkspace();
    });
  });
  ws.querySelectorAll('.propose-meeting').forEach((btn) => {
    btn.addEventListener('click', () => proposeMeetingFlow(ns, id, btn.closest('.card').dataset.identity));
  });
  ws.querySelectorAll('.meeting-yes').forEach((btn) => {
    btn.addEventListener('click', () => respondMeeting(ns, id, btn.closest('.card').dataset.identity, true));
  });
  ws.querySelectorAll('.meeting-no').forEach((btn) => {
    btn.addEventListener('click', () => respondMeeting(ns, id, btn.closest('.card').dataset.identity, false));
  });
  ws.querySelectorAll('.block-peer').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.card');
      blockPeer(ns, card.dataset.identity, card.querySelector('.name')?.textContent);
    });
  });
  ws.querySelectorAll('.request-doc').forEach((btn) => {
    btn.addEventListener('click', () => requestDocument(ns, id, btn.closest('.card').dataset.identity, btn.dataset.doc));
  });
  ws.querySelectorAll('.doc-share').forEach((btn) => {
    btn.addEventListener('click', () => shareDocument(ns, id, btn.closest('.card').dataset.identity, btn.dataset.doc));
  });
  ws.querySelectorAll('.doc-decline').forEach((btn) => {
    btn.addEventListener('click', () => declineDocument(ns, btn.closest('.card').dataset.identity));
  });
  ws.querySelectorAll('.view-doc').forEach((btn) => {
    btn.addEventListener('click', () => {
      const theirIdentityId = btn.closest('.card').dataset.identity;
      const doc = state.pendingDocs[ns].get(theirIdentityId);
      openModal(doc.doc.replace('_', ' '), `<div style="white-space:pre-wrap;font-size:13px;color:var(--hi)">${doc.text}</div>`, { submitLabel: 'Close' });
    });
  });
  ws.querySelectorAll('.conv-open').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await loadConversation(ns, btn.dataset.identity);
      state.openChatWith[ns] = btn.dataset.identity;
      renderWorkspace();
    });
  });
  ws.querySelector('#closeChat')?.addEventListener('click', () => { state.openChatWith[ns] = null; renderWorkspace(); });

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

function chainPillsHtml(project) {
  return project.chain.map((mode, i) => {
    const p = project.participants[i];
    return `<span class="chip" style="${mode === 'build' ? 'border-color:var(--agent);color:var(--agent)' : 'border-color:var(--warn);color:var(--warn)'}">
        ${i + 1}. ${mode === 'build' ? 'Build' : 'Critic'}${p ? ` — ${p.displayName}` : ' — open'}
      </span>`;
  }).join(' → ');
}

function newProjectFlow(id) {
  let chain = ['build']; // slot 0 is always the initiator's own role

  function renderChainRow(container) {
    container.innerHTML = chain.map((m, i) => `
        <span class="chip" style="${m === 'build' ? 'border-color:var(--agent);color:var(--agent)' : 'border-color:var(--warn);color:var(--warn)'}">
          ${i + 1}. ${m === 'build' ? 'Build' : 'Critic'} ${i > 0 ? `<button type="button" data-rm="${i}" style="background:none;border:none;color:inherit;cursor:pointer;margin-left:4px">×</button>` : '(you)'}
        </span>`).join(' → ');
    container.querySelectorAll('[data-rm]').forEach((btn) => {
      btn.addEventListener('click', () => { chain.splice(parseInt(btn.dataset.rm, 10), 1); renderChainRow(container); });
    });
  }

  openModal('New research project', `
      <label>Problem statement</label>
      <textarea id="problem" placeholder="What are you trying to figure out?"></textarea>
      <label>Chain — your own first slot, then whoever joins next automatically takes the next one</label>
      <div id="chainRow" style="margin:6px 0"></div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button type="button" class="btn small" id="addBuild">+ Build</button>
        <button type="button" class="btn small" id="addCritic">+ Critic</button>
      </div>
      <label>Publication rule</label>
      <input type="text" id="pub" value="Mutual approval">
      <label>Commercialization rule</label>
      <input type="text" id="com" value="Mutual approval">
    `, {
    submitLabel: 'Create project',
    onOpen: (dlg) => {
      const row = dlg.querySelector('#chainRow');
      renderChainRow(row);
      dlg.querySelector('#addBuild').addEventListener('click', () => { chain.push('build'); renderChainRow(row); });
      dlg.querySelector('#addCritic').addEventListener('click', () => { chain.push('critic'); renderChainRow(row); });
    },
    onSubmit: async (dlg) => {
      const problem = dlg.querySelector('#problem').value.trim();
      if (!problem) return;
      const project = await research.createProject({
        problem,
        chain,
        initiator: { identityId: id.identityId, displayName: id.displayName, skillMd: '' },
        agreement: {
          publication: dlg.querySelector('#pub').value,
          commercialization: dlg.querySelector('#com').value,
        },
      });
      state.researchProjects = await research.listProjects();
      state.activeProjectId = project.projectId;
      if (state.searchLive.research) announceMyOpenProjects(id); // don't wait for the next peer to join
      renderWorkspace();
    },
  });
}

function skillMdFieldHtml() {
  return `
    <label>Your agent's skill / task (optional .md) — shown to the initiator when they review your request</label>
    <textarea id="skillMd" placeholder="e.g. Specialized in statistical critique; will check for sample-size and p-hacking issues."></textarea>
    <label>Or load from a .md file</label>
    <input type="file" id="skillFile" accept=".md,text/markdown,text/plain">`;
}

function bindSkillMdFile(dlg) {
  dlg.querySelector('#skillFile')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) dlg.querySelector('#skillMd').value = await f.text();
  });
}

// Requesting to join a project I already have full local data for (I'm
// already connected to whoever told me about it, e.g. via sync or a shared
// export) — sends the request straight to the initiator's peer if known.
function requestToJoinFlow(project, id, targetPeerId) {
  openModal(`Request to join — ${project.problem.slice(0, 40)}`, skillMdFieldHtml(), {
    submitLabel: 'Send request',
    onOpen: bindSkillMdFile,
    onSubmit: async (dlg) => {
      const skillMd = dlg.querySelector('#skillMd').value.trim();
      const room = p2p.getRoom('research');
      if (!room) { toast('Connect to the research room first.'); return; }
      const applicant = { identityId: id.identityId, displayName: id.displayName, skillMd };
      room.send('research_join_request', id.identityId, { projectId: project.projectId, applicant }, targetPeerId);
      state.outgoingJoinRequests.set(project.projectId, 'pending');
      toast('Join request sent — waiting on the initiator to accept.');
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
      const updatedProject = await research.touchParticipant(projectId, id.identityId);
      const room = p2p.getRoom('research');
      if (room) {
        room.send('research_artifact', id.identityId, { artifact });
        if (updatedProject) room.send('research_project_update', id.identityId, { project: updatedProject });
      }
      renderWorkspace();
    },
  });
}

async function aiAssistFlow(projectId, type, id) {
  if (!llm.isWebGPUAvailable()) { toast('WebGPU not available — write it manually instead.'); return; }
  const project = (await research.listProjects()).find((p) => p.projectId === projectId);
  const me = research.myParticipant(project, id.identityId);
  const artifacts = await research.listArtifacts(projectId);
  const recent = artifacts.slice(-4).map((a) => `[${a.type}] ${a.content.text}`).join('\n');
  const skillContext = me?.skillMd ? `\n\nYour declared skill/task, follow it: ${me.skillMd}` : '';
  const system = `You are a research collaborator in ${me?.mode === 'critic' ? 'critic' : 'build'} mode. The problem is: "${project.problem}". Propose a concise, falsifiable ${type} in 1-3 sentences, grounded in the recent context given.${skillContext}`;
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

  const discoverableHtml = state.discoverableProjects.size ? `
    <div class="panel">
      <div class="k">Open projects on the network</div>
      ${[...state.discoverableProjects.values()]
        .filter((d) => !state.researchProjects.some((p) => p.projectId === d.projectId))
        .map((d) => `
          <div class="agree-row">
            <span class="k2">${d.problem.slice(0, 50)} — by ${d.initiatorDisplayName} (${d.filledCount}/${d.chain.length} filled)</span>
            <button class="btn small ${state.outgoingJoinRequests.get(d.projectId) ? 'ghost' : 'primary'} join-discoverable" data-pid="${d.projectId}" ${state.outgoingJoinRequests.get(d.projectId) ? 'disabled' : ''}>
              ${state.outgoingJoinRequests.get(d.projectId) === 'pending' ? 'Requested…' : state.outgoingJoinRequests.get(d.projectId) === 'declined' ? 'Declined' : 'Request to join'}
            </button>
          </div>`).join('') || '<div style="color:var(--low);font-size:12px">None new right now.</div>'}
    </div>` : '';

  const listHtml = `<div class="project-list">
      ${state.researchProjects.map((p) => `<button class="project-pill ${p.projectId === state.activeProjectId ? 'active' : ''}" data-pid="${p.projectId}">${p.problem.slice(0, 32)}${p.problem.length > 32 ? '…' : ''}</button>`).join('')}
      <button class="project-pill" id="newProjectBtn">+ New project</button>
      <button class="project-pill" id="importBtn">Import .jobber</button>
      <input type="file" id="importFile" accept=".json" style="display:none">
    </div>`;

  if (!project) {
    return `<h2 class="section-title">Research — model-to-model with declared agent skills</h2>
      <p class="section-sub">${NS_CONFIG.research.hint}</p>
      ${listHtml}
      ${discoverableHtml}
      <div class="empty-state">No project yet. Create one to state a problem, define a build/critic chain, and start collaborating.</div>`;
  }

  const me = research.myParticipant(project, id.identityId);
  const isInitiator = project.initiatorId === id.identityId;
  const openSlot = research.nextOpenSlot(project);
  const pendingForThis = state.pendingJoinRequests.get(project.projectId) || [];

  const artifacts = await research.listArtifacts(project.projectId);
  const feedHtml = artifacts.map((a) => `
      <div class="fmsg ${a.type}">
        <div class="bar"></div>
        <div class="body">
          <div class="who">${a.agent ? a.agent : (project.participants.find((p) => p.identityId === a.author)?.displayName || a.author?.slice(0, 8) || 'Unknown')}
            <span class="k">${ARTIFACT_COLOR_LABEL[a.type] || a.type}</span></div>
          <div class="txt">${a.content.text}</div>
          ${a.validatedBy.length ? `<div class="valid">Validated by ${a.validatedBy.length} participant(s)</div>` : `<button class="btn small validate-btn" data-aid="${a.artifactId}">Validate</button>`}
        </div>
      </div>`).join('');

  const joinRequestsHtml = isInitiator && pendingForThis.length ? `
    <div class="panel">
      <div class="k">Join requests — you accept last, and it's final</div>
      ${pendingForThis.map((r) => `
        <div class="agree-row" style="align-items:flex-start;flex-direction:column;gap:6px">
          <div><b>${r.displayName}</b> requests slot ${openSlot ? openSlot.chainIndex + 1 : '?'} (${openSlot ? (openSlot.mode === 'build' ? 'Build' : 'Critic') : 'chain full'})</div>
          ${r.skillMd ? `<details style="font-size:11.5px;color:var(--mid)"><summary style="cursor:pointer">View declared skill</summary><div style="white-space:pre-wrap;margin-top:4px">${r.skillMd}</div></details>` : '<div style="font-size:11px;color:var(--low)">No skill declared</div>'}
          <div style="display:flex;gap:8px">
            <button class="btn small primary accept-join" data-pid="${project.projectId}" data-applicant="${r.identityId}">Accept</button>
            <button class="btn small decline-join" data-pid="${project.projectId}" data-applicant="${r.identityId}">Decline</button>
          </div>
        </div>`).join('')}
    </div>` : '';

  const joinCta = (!me && project.state === 'active')
    ? (openSlot
        ? `<button class="btn primary" id="requestJoin">Request to join (next slot: ${openSlot.mode === 'build' ? 'Build' : 'Critic'})</button>`
        : `<span style="color:var(--low);font-size:12px">This project's chain is full.</span>`)
    : '';

  const modeArtifactButtons = (me && project.state === 'active') ? (research.MODE_ARTIFACT_TYPES[me.mode] || []).map((t) =>
    `<button class="btn ${t === research.MODE_ARTIFACT_TYPES[me.mode][0] ? 'primary' : ''}" data-artifact="${t}">Add ${ARTIFACT_COLOR_LABEL[t] || t}</button>`
  ).join('') : '';

  const aiButton = (me && project.state === 'active') ? `<button class="btn ghost" data-ai="${me.mode === 'build' ? 'hypothesis' : 'critique'}">Ask local AI for a ${me.mode === 'build' ? 'hypothesis' : 'critique'}</button>` : '';

  const closedBanner = project.state === 'closed' ? `
    <div class="panel" style="border-color:var(--bad)">
      <div class="k" style="color:var(--bad)">Closed</div>
      <div style="font-size:12.5px;color:var(--mid)">
        Closed by ${project.participants.find((p) => p.identityId === project.closedBy)?.displayName || 'the initiator'} · ${relativeTime(project.closedAt)}.
        No further artifacts can be added.
      </div>
    </div>` : '';

  const closeCta = (isInitiator && project.state === 'active') ? `<button class="btn ghost" id="closeProject" style="border-color:var(--bad);color:var(--bad)">Close project</button>` : '';

  // Progress: visible to everyone, so a stalled contributor is obvious to
  // all participants, not just the initiator.
  const artifactCounts = artifacts.reduce((acc, a) => { acc[a.type] = (acc[a.type] || 0) + 1; return acc; }, {});
  const countsSummary = Object.entries(artifactCounts).map(([t, n]) => `${n} ${ARTIFACT_COLOR_LABEL[t] || t}${n > 1 ? 's' : ''}`).join(' · ') || 'No artifacts yet';
  const progressHtml = `
    <div class="panel">
      <div class="k">Progress — visible to everyone in this project</div>
      <div style="font-size:12.5px;color:var(--mid);margin-bottom:10px">${countsSummary}</div>
      ${project.participants.map((p) => {
        const count = artifacts.filter((a) => a.author === p.identityId).length;
        const stalled = research.isStalled(p);
        return `
          <div class="agree-row">
            <span class="k2">
              ${p.displayName} <span class="role-badge" style="${p.mode === 'build' ? '' : 'color:var(--warn);border-color:rgba(232,184,75,.4)'}">${p.mode === 'build' ? 'Build' : 'Critic'}</span>
              ${stalled ? '<span style="color:var(--bad);font-size:10.5px;margin-left:6px">⚠ inactive</span>' : ''}
            </span>
            <span class="v" style="font-weight:400">${count} contribution${count === 1 ? '' : 's'} · last active ${relativeTime(p.lastActiveAt)}</span>
          </div>`;
      }).join('')}
    </div>`;

  return `
    <h2 class="section-title">Research — model-to-model with declared agent skills</h2>
    <p class="section-sub">${NS_CONFIG.research.hint}</p>
    ${listHtml}
    ${discoverableHtml}
    ${closedBanner}

    <div class="panel">
      <div class="k">Problem</div>
      <div style="font-family:var(--font-head);font-size:15px;font-weight:500">${project.problem}</div>
      <div class="k" style="margin-top:12px">Chain</div>
      <div class="chiprow">${chainPillsHtml(project)}</div>
      <div class="participants">
        ${project.participants.map((p) => `
          <div class="participant">
            <span class="dot"></span><span>${p.displayName} <span class="role-badge" style="${p.mode === 'build' ? '' : 'color:var(--warn);border-color:rgba(232,184,75,.4)'}">${p.mode === 'build' ? 'Build' : 'Critic'}</span></span>
            ${p.skillMd ? `<button class="btn small ghost view-skill" data-skill="${encodeURIComponent(p.skillMd)}" data-who="${p.displayName}">skill</button>` : ''}
          </div>`).join('')}
      </div>
      <div class="actions" style="margin-top:12px">
        <button class="btn" id="connectPeers">${state.searchLive.research ? 'Connected to research room' : 'Connect with peers'}</button>
        <button class="btn" id="exportProject">Export .jobber</button>
        ${joinCta}
        ${closeCta}
      </div>
    </div>

    ${progressHtml}
    ${joinRequestsHtml}

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
          <div class="agree-row"><span class="k2">Publication</span><span class="v">${project.agreement.publication}</span></div>
          <div class="agree-row"><span class="k2">Commercialization</span><span class="v">${project.agreement.commercialization}</span></div>
        </div>
        ${me ? `
          <div class="research-actions">${modeArtifactButtons}</div>
          <div class="research-actions">${aiButton}</div>
        ` : (project.state === 'active' ? `<p class="section-sub">You're not a participant in this project yet${openSlot ? ' — request to join above.' : '.'}</p>` : '')}
      </div>
      <div>
        <div class="feed">${feedHtml || '<div style="padding:16px;color:var(--low);font-size:12px">No artifacts yet.</div>'}</div>
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
    btn.addEventListener('click', async () => {
      const artifact = await research.validateArtifact(btn.dataset.aid, id.identityId);
      const updatedProject = await research.touchParticipant(state.activeProjectId, id.identityId);
      const room = p2p.getRoom('research');
      if (room) {
        room.send('research_artifact', id.identityId, { artifact }); // propagate the validation, merged by union on receipt
        if (updatedProject) room.send('research_project_update', id.identityId, { project: updatedProject });
      }
      renderWorkspace();
    });
  });
  ws.querySelectorAll('.view-skill').forEach((btn) => {
    btn.addEventListener('click', () => openModal(`Skill — ${btn.dataset.who}`, `<div style="white-space:pre-wrap;font-size:13px">${decodeURIComponent(btn.dataset.skill)}</div>`, { submitLabel: 'Close' }));
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
  ws.querySelector('#closeProject')?.addEventListener('click', () => closeProjectFlow(state.activeProjectId, id));
  ws.querySelector('#requestJoin')?.addEventListener('click', () => {
    const project = state.researchProjects.find((p) => p.projectId === state.activeProjectId);
    requestToJoinFlow(project, id, undefined); // broadcast; initiator filters locally
  });
  ws.querySelectorAll('.accept-join').forEach((btn) => {
    btn.addEventListener('click', () => acceptJoinRequest(id, btn.dataset.pid, btn.dataset.applicant));
  });
  ws.querySelectorAll('.decline-join').forEach((btn) => {
    btn.addEventListener('click', () => declineJoinRequest(id, btn.dataset.pid, btn.dataset.applicant));
  });
  ws.querySelectorAll('.join-discoverable').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = state.discoverableProjects.get(btn.dataset.pid);
      requestToJoinFlow({ projectId: d.projectId, problem: d.problem }, id, d.fromPeerId);
    });
  });
}

function closeProjectFlow(projectId, id) {
  openModal('Close this project?', `<p style="font-size:12.5px;color:var(--mid)">No further artifacts can be added by anyone once closed — this is final in this build. Everyone currently connected will see it close immediately.</p>`, {
    submitLabel: 'Close project',
    onSubmit: async () => {
      const project = await research.closeProject(projectId, id.identityId);
      state.researchProjects = await research.listProjects();
      const room = p2p.getRoom('research');
      if (room) room.send('research_project_update', id.identityId, { project });
      toast('Project closed.');
      renderWorkspace();
    },
  });
}

async function acceptJoinRequest(id, projectId, applicantId) {
  const requests = state.pendingJoinRequests.get(projectId) || [];
  const applicant = requests.find((r) => r.identityId === applicantId);
  if (!applicant) return;
  const project = await research.acceptParticipant(projectId, applicant);
  state.pendingJoinRequests.set(projectId, requests.filter((r) => r.identityId !== applicantId));
  state.researchProjects = await research.listProjects();
  const room = p2p.getRoom('research');
  if (room) {
    room.send('research_join_accept', id.identityId, { project }, applicant.peerId);
    room.send('research_project_update', id.identityId, { project }); // broadcast to existing participants too
  }
  toast(`${applicant.displayName} accepted as ${project.participants[project.participants.length - 1].mode}`);
  renderWorkspace();
}

function declineJoinRequest(id, projectId, applicantId) {
  const requests = state.pendingJoinRequests.get(projectId) || [];
  const applicant = requests.find((r) => r.identityId === applicantId);
  state.pendingJoinRequests.set(projectId, requests.filter((r) => r.identityId !== applicantId));
  const room = p2p.getRoom('research');
  if (room && applicant) room.send('research_join_decline', id.identityId, { projectId }, applicant.peerId);
  renderWorkspace();
}

// Broadcasts (or sends to one peer, if given) an announcement for every one
// of my own open-slot projects. Called both when a new peer joins the room
// (so they learn about projects that already existed) and right after I
// create a project while already connected (so peers already in the room
// don't have to wait for a fresh peer-join event to hear about it).
async function announceMyOpenProjects(id, targetPeerId) {
  const room = p2p.getRoom('research');
  if (!room) return;
  for (const p of await research.listProjects()) {
    if (p.initiatorId !== id.identityId) continue;
    if (p.state === 'closed') continue;
    const slot = research.nextOpenSlot(p);
    if (!slot) continue;
    room.send('research_project_announce', id.identityId, {
      projectId: p.projectId, problem: p.problem, chain: p.chain,
      filledCount: p.participants.length, initiatorDisplayName: id.displayName,
    }, targetPeerId);
  }
}

async function toggleResearchConnect(id) {
  state.searchLive.research = !state.searchLive.research;
  if (state.searchLive.research) {
    try {
      await p2p.joinNamespaceRoom('research', {
        onPeerJoin: async (peerId) => {
          const room = p2p.getRoom('research');
          if (state.activeProjectId) {
            const artifacts = await research.listArtifacts(state.activeProjectId);
            room.send('research_sync_request', id.identityId, {
              projectId: state.activeProjectId,
              knownArtifactIds: artifacts.map((a) => a.artifactId),
            }, peerId);
          }
          // Announce any of my own projects that still have an open chain slot.
          announceMyOpenProjects(id, peerId);
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
  for (const a of msg.payload.artifacts) await research.mergeArtifact(a);
  if (msg.payload.projectId === state.activeProjectId) renderWorkspace();
}

async function handleResearchJoinRequest(msg, peerId) {
  const { projectId, applicant } = msg.payload;
  const project = (await research.listProjects()).find((p) => p.projectId === projectId);
  const iAmInitiator = state.identitiesByNs.research.some((i) => i.identityId === project?.initiatorId);
  if (!project || !iAmInitiator) return; // not mine to accept
  if (project.state === 'closed') return; // no new joiners once closed
  if (!state.pendingJoinRequests.has(projectId)) state.pendingJoinRequests.set(projectId, []);
  state.pendingJoinRequests.get(projectId).push({ ...applicant, peerId });
  toast(`${applicant.displayName} requested to join "${project.problem.slice(0, 30)}…"`);
  renderWorkspace();
}

async function handleResearchJoinAccept(msg) {
  const { project } = msg.payload;
  await db.put('research_projects', project);
  state.researchProjects = await research.listProjects();
  state.outgoingJoinRequests.set(project.projectId, 'accepted');
  state.activeProjectId = project.projectId;
  const me = research.myParticipant(project, state.activeIdentityId.research);
  toast(`You were accepted — your role is ${me?.mode === 'build' ? 'Build' : 'Critic'}`);
  renderWorkspace();
}

function handleResearchJoinDecline(msg) {
  state.outgoingJoinRequests.set(msg.payload.projectId, 'declined');
  toast('Your join request was declined.');
  renderWorkspace();
}

async function handleResearchProjectUpdate(msg) {
  await db.put('research_projects', msg.payload.project);
  state.researchProjects = await research.listProjects();
  if (msg.payload.project.projectId === state.activeProjectId) renderWorkspace();
}

function handleResearchProjectAnnounce(msg, peerId) {
  state.discoverableProjects.set(msg.payload.projectId, { ...msg.payload, fromPeerId: peerId });
  renderWorkspace();
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
