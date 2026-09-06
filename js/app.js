// app.js — the entry point. Everything real lives in the other modules;
// this file's only job is to wire them together and kick off boot().
//
// Module map (why it's split this way): state.js holds the shared state
// and config that everyone reads; ui-kit.js is generic DOM primitives with
// no app knowledge; identity-ui.js, profiles.js, conversations.js,
// discovery-ui.js, and research-ui.js are the actual feature areas;
// message-router.js decides what an incoming P2P message does;
// render.js is the one place that ties the rail/topbar/workspace together.
// See state.js's header comment for why `state.render` / `state.handlers`
// exist: they let feature modules call back into render.js and
// message-router.js without a circular import.

import * as db from './db.js';
import * as identity from './identity.js';
import * as llm from './llm.js';
import * as research from './research.js';
import { state, NAMESPACES, NS_CONFIG, pickActiveIdentityId } from './state.js';
import { renderTopbar } from './identity-ui.js';
import { setSearchLive } from './discovery-ui.js';
import { setResearchConnected } from './research-ui.js';
import { renderAll, renderWorkspace, refreshUsageStat } from './render.js';
import './message-router.js'; // side effect: registers state.handlers.incomingMessage

state.render.all = renderAll;
state.render.workspace = renderWorkspace;
state.render.topbar = renderTopbar;

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

async function boot() {
  await migrateLegacyNamespaces();

  for (const ns of NAMESPACES) {
    state.identitiesByNs[ns] = await identity.listIdentities(ns);
    state.discovered[ns] = new Map();
    state.pendingChats[ns] = new Map();
    state.chatLog[ns] = new Map();
    state.pendingMeetings[ns] = new Map();
    state.pendingDocs[ns] = new Map();
    state.pendingAttachmentOffers[ns] = new Map();
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

  // Which namespace to land on: remember the last one the person actually
  // opened (persisted, not just in-memory — survives a reload), falling
  // back to "wherever you already have an identity" only if we've never
  // recorded a choice, and to a neutral welcome screen (no namespace
  // preselected) on a genuinely first-ever open with nothing anywhere.
  const lastActive = await db.get('cache', 'lastActiveNamespace');
  const totalIdentities = NAMESPACES.reduce((n, ns) => n + state.identitiesByNs[ns].filter((i) => i.active).length, 0);

  if (lastActive?.value && NAMESPACES.includes(lastActive.value)) {
    state.activeNamespace = lastActive.value;
  } else if (totalIdentities === 0) {
    state.activeNamespace = null; // first open, nothing created yet — show the welcome screen
  } else {
    state.activeNamespace = NAMESPACES.find((ns) => state.identitiesByNs[ns].some((i) => i.active)) || NAMESPACES[0];
  }
  for (const ns of NAMESPACES) {
    const activeId = pickActiveIdentityId(state.identitiesByNs[ns]);
    if (activeId) state.activeIdentityId[ns] = activeId;
    // else: leave unset — a retired identity must never be silently
    // re-selected as if it were still active (this was the actual bug:
    // retiring your last identity in a namespace, then reloading, used to
    // fall back to the first *record* regardless of its active flag).
  }

  renderAll();
  refreshUsageStat();
  registerServiceWorker();
  reportWebGPU();

  // Resume Search Live / research connection automatically if they were on
  // last time — "search live" isn't meant to reset itself just because the
  // page reloaded. Only resumes where there's still an active identity to
  // resume it with.
  for (const ns of NAMESPACES) {
    if (ns === 'research') continue;
    const pref = await db.get('cache', `searchLive:${ns}`);
    if (pref?.value && state.activeIdentityId[ns]) setSearchLive(ns, true);
  }
  const researchPref = await db.get('cache', 'researchConnect');
  if (researchPref?.value && state.activeIdentityId.research) {
    const researchId = state.identitiesByNs.research.find((i) => i.identityId === state.activeIdentityId.research);
    if (researchId) setResearchConnected(researchId, true);
  }
}

boot();
