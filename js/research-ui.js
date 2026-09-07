// research-ui.js — the Research namespace end to end: project creation with
// its build/critic chain, the join request/accept flow with declared
// skill.md, artifacts and their graph, progress/activity, closure, and the
// P2P sync/announce handlers. Reaches message-router.js only through
// `state.handlers` (see state.js's header) to avoid a circular import.

import * as db from './db.js';
import * as p2p from './p2p.js';
import * as llm from './llm.js';
import * as research from './research.js';
import { state, NS_CONFIG, relativeTime } from './state.js';
import { openModal, toast } from './ui-kit.js';
import { createIdentityFlow } from './identity-ui.js';

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
      state.render.workspace();
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
      const msg = room.send('research_join_request', id.identityId, { projectId: project.projectId, applicant }, targetPeerId);
      state.outgoingJoinRequests.set(project.projectId, 'pending');
      state.outgoingJoinRequestIds.set(project.projectId, msg.messageId);
      toast('Join request sent — waiting on the initiator to accept.');
      state.render.workspace();
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
      state.render.workspace();
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

export async function renderResearchWorkspace() {
  const id = state.identitiesByNs.research.find((i) => i.identityId === state.activeIdentityId.research);
  if (!id) return `<div class="empty-state"><p>Create an Intelligence identity to start a project.</p><button class="btn primary" id="createHere">Create identity</button></div>`;

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
    return `<h2 class="section-title">Intelligence — model-to-model with declared agent skills</h2>
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
    <h2 class="section-title">Intelligence — model-to-model with declared agent skills</h2>
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
          <div class="k">Intelligence contract</div>
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

export function bindResearchEvents(id) {
  const ws = document.getElementById('workspace');
  ws.querySelector('#createHere')?.addEventListener('click', () => createIdentityFlow('research'));
  ws.querySelector('#newProjectBtn')?.addEventListener('click', () => newProjectFlow(id));
  ws.querySelectorAll('.project-pill[data-pid]').forEach((btn) => {
    btn.addEventListener('click', () => { state.activeProjectId = btn.dataset.pid; state.render.workspace(); });
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
      state.render.workspace();
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
    state.render.workspace();
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
      state.render.workspace();
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
    room.send('research_join_accept', id.identityId, { project }, applicant.peerId, applicant.requestId);
    room.send('research_project_update', id.identityId, { project }); // broadcast to existing participants too
  }
  toast(`${applicant.displayName} accepted as ${project.participants[project.participants.length - 1].mode}`);
  state.render.workspace();
}

function declineJoinRequest(id, projectId, applicantId) {
  const requests = state.pendingJoinRequests.get(projectId) || [];
  const applicant = requests.find((r) => r.identityId === applicantId);
  state.pendingJoinRequests.set(projectId, requests.filter((r) => r.identityId !== applicantId));
  const room = p2p.getRoom('research');
  if (room && applicant) room.send('research_join_decline', id.identityId, { projectId }, applicant.peerId, applicant.requestId);
  state.render.workspace();
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

// Same "connect outright" pattern as discovery-ui.js's setSearchLive — one
// place that actually joins/leaves, called by both the manual button and
// the auto-resume-on-boot path in app.js.
export async function setResearchConnected(id, desired) {
  state.searchLive.research = desired;
  db.put('cache', { key: 'researchConnect', value: desired }); // survives reload
  if (desired) {
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
        onMessage: (msg, peerId) => state.handlers.incomingMessage('research', msg, peerId),
      });
    } catch (e) {
      toast('P2P networking unavailable: ' + e.message);
      state.searchLive.research = false;
    }
  } else {
    p2p.leaveNamespaceRoom('research');
  }
  state.render.all();
}

export async function toggleResearchConnect(id) {
  await setResearchConnected(id, !state.searchLive.research);
}

export async function handleResearchSyncRequest(ns, msg, peerId) {
  const { projectId, knownArtifactIds } = msg.payload;
  if (!projectId || projectId !== state.activeProjectId) return;
  const mine = await research.listArtifacts(projectId);
  const missing = mine.filter((a) => !knownArtifactIds.includes(a.artifactId));
  if (missing.length) {
    const room = p2p.getRoom(ns);
    room.send('research_sync_response', state.activeIdentityId.research, { projectId, artifacts: missing }, peerId);
  }
}

export async function handleResearchSyncResponse(msg) {
  for (const a of msg.payload.artifacts) await research.mergeArtifact(a);
  if (msg.payload.projectId === state.activeProjectId) state.render.workspace();
}

export async function handleResearchJoinRequest(msg, peerId) {
  const { projectId, applicant } = msg.payload;
  const project = (await research.listProjects()).find((p) => p.projectId === projectId);
  const iAmInitiator = state.identitiesByNs.research.some((i) => i.identityId === project?.initiatorId);
  if (!project || !iAmInitiator) return; // not mine to accept
  if (project.state === 'closed') return; // no new joiners once closed
  if (!state.pendingJoinRequests.has(projectId)) state.pendingJoinRequests.set(projectId, []);
  state.pendingJoinRequests.get(projectId).push({ ...applicant, peerId, requestId: msg.messageId });
  toast(`${applicant.displayName} requested to join "${project.problem.slice(0, 30)}…"`);
  state.render.workspace();
}

export async function handleResearchJoinAccept(msg) {
  const { project } = msg.payload;
  const expectedRequestId = state.outgoingJoinRequestIds.get(project.projectId);
  if (msg.correlationId && expectedRequestId && msg.correlationId !== expectedRequestId) {
    console.warn('[jobber] stale research join accept ignored (correlationId mismatch)', msg);
    return;
  }
  await db.put('research_projects', project);
  state.researchProjects = await research.listProjects();
  state.outgoingJoinRequests.set(project.projectId, 'accepted');
  state.activeProjectId = project.projectId;
  const me = research.myParticipant(project, state.activeIdentityId.research);
  toast(`You were accepted — your role is ${me?.mode === 'build' ? 'Build' : 'Critic'}`);
  state.render.workspace();
}

export function handleResearchJoinDecline(msg) {
  const expectedRequestId = state.outgoingJoinRequestIds.get(msg.payload.projectId);
  if (msg.correlationId && expectedRequestId && msg.correlationId !== expectedRequestId) {
    console.warn('[jobber] stale research join decline ignored (correlationId mismatch)', msg);
    return;
  }
  state.outgoingJoinRequests.set(msg.payload.projectId, 'declined');
  toast('Your join request was declined.');
  state.render.workspace();
}

export async function handleResearchProjectUpdate(msg) {
  await db.put('research_projects', msg.payload.project);
  state.researchProjects = await research.listProjects();
  if (msg.payload.project.projectId === state.activeProjectId) state.render.workspace();
}

export function handleResearchProjectAnnounce(msg, peerId) {
  state.discoverableProjects.set(msg.payload.projectId, { ...msg.payload, fromPeerId: peerId });
  state.render.workspace();
}
