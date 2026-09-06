// research.js — Research Vault: projects, artifacts, provenance.
// Every artifact lives in IndexedDB. Nothing is sent to a server; sync
// between participants happens directly over the P2P room (see p2p.js and
// the sync functions in app.js).
//
// Collaboration model: the initiator defines an ordered *chain* of modes
// (e.g. build → critic → build). Each accepted participant automatically
// takes the next open slot in that chain — nobody picks their own mode.
// A participant's mode determines which artifact types they may add: build
// participants construct (hypotheses, experiments, results...), critic
// participants evaluate (critiques, analyses, decisions). There is no
// ownership split — contribution is simply the recorded provenance
// (author/agent/parents) on each artifact, not a negotiated percentage.

import { put, get, getAll } from './db.js';

export const ARTIFACT_TYPES = [
  'problem', 'hypothesis', 'critique', 'counter_hypothesis', 'evidence',
  'experiment', 'result', 'analysis', 'synthesis', 'decision',
  'reference', 'dataset', 'code', 'document',
];

export const CHAIN_MODES = ['build', 'critic'];

// Which artifact types each chain mode may add. Enforced at the UI layer
// (only the relevant buttons are shown) rather than hard-blocked here, in
// keeping with human-in-the-loop over rigid enforcement elsewhere in the app.
export const MODE_ARTIFACT_TYPES = {
  build: ['hypothesis', 'counter_hypothesis', 'experiment', 'evidence', 'result', 'synthesis', 'dataset', 'code', 'document', 'reference'],
  critic: ['critique', 'analysis', 'decision'],
};

export async function createProject({ problem, chain, initiator, agreement }) {
  if (!Array.isArray(chain) || chain.length === 0) throw new Error('A project needs at least one chain slot');
  if (chain.some((m) => !CHAIN_MODES.includes(m))) throw new Error(`Chain modes must be one of: ${CHAIN_MODES.join(', ')}`);

  const projectId = crypto.randomUUID();
  const now = Date.now();
  const project = {
    projectId,
    problem,
    chain, // e.g. ['build', 'critic', 'build']
    initiatorId: initiator.identityId,
    participants: [{ // slot 0 is always the initiator
      identityId: initiator.identityId,
      displayName: initiator.displayName,
      chainIndex: 0,
      mode: chain[0],
      skillMd: initiator.skillMd || '',
      joinedAt: now,
      lastActiveAt: now,
    }],
    agreement, // { publication, commercialization } — no ownership split
    state: 'active', // 'active' | 'closed'
    closedAt: null,
    closedBy: null,
    createdAt: now,
  };
  await put('research_projects', project);
  await createArtifact(projectId, 'problem', { text: problem }, { author: initiator.identityId });
  return project;
}

// Returns the next unfilled chain slot, or null if the chain is full.
export function nextOpenSlot(project) {
  const index = project.participants.length;
  if (index >= project.chain.length) return null;
  return { chainIndex: index, mode: project.chain[index] };
}

// Only the initiator accepts join requests, and acceptance is the final
// step: the applicant is slotted into whichever position is next in the
// chain, in order — nobody chooses their own mode.
export async function acceptParticipant(projectId, applicant) {
  const project = await get('research_projects', projectId);
  if (!project) throw new Error('Project not found');
  if (project.state === 'closed') throw new Error('This project is closed');
  const slot = nextOpenSlot(project);
  if (!slot) throw new Error('This project\'s chain is already full');
  const now = Date.now();
  project.participants.push({
    identityId: applicant.identityId,
    displayName: applicant.displayName,
    chainIndex: slot.chainIndex,
    mode: slot.mode,
    skillMd: applicant.skillMd || '',
    joinedAt: now,
    lastActiveAt: now,
  });
  await put('research_projects', project);
  return project;
}

export function myParticipant(project, identityId) {
  return project.participants.find((p) => p.identityId === identityId) || null;
}

// A participant is flagged as stalled purely as a display heuristic — not
// enforced anywhere (no auto-removal, no auto-reassignment of their slot).
export const STALLED_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export function isStalled(participant, now = Date.now()) {
  if (!participant || !participant.lastActiveAt) return false;
  return now - participant.lastActiveAt > STALLED_THRESHOLD_MS;
}

// Bumps a participant's last-active timestamp — call this on any real
// contribution (new artifact, validation) so everyone can see who's still
// engaged and who's gone quiet.
export async function touchParticipant(projectId, identityId) {
  const project = await get('research_projects', projectId);
  if (!project) return null;
  const p = project.participants.find((x) => x.identityId === identityId);
  if (p) p.lastActiveAt = Date.now();
  await put('research_projects', project);
  return project;
}

// Only the initiator can close a project. Closing is final in this build —
// no artifacts can be added afterward, by anyone, in any mode.
export async function closeProject(projectId, closedByIdentityId) {
  const project = await get('research_projects', projectId);
  if (!project) throw new Error('Project not found');
  if (project.initiatorId !== closedByIdentityId) throw new Error('Only the initiator can close this project');
  project.state = 'closed';
  project.closedAt = Date.now();
  project.closedBy = closedByIdentityId;
  await put('research_projects', project);
  return project;
}

export async function createArtifact(projectId, type, content, { author, agent, parents = [] } = {}) {
  if (!ARTIFACT_TYPES.includes(type)) throw new Error(`Unknown artifact type: ${type}`);
  const artifact = {
    artifactId: crypto.randomUUID(),
    projectId,
    type,
    content, // { text } at minimum; richer shapes allowed per type
    author,
    agent: agent || null, // e.g. "Plex-7B-Local" if AI-assisted
    parents, // artifactIds this was derived from
    createdAt: Date.now(),
    validatedBy: [],
  };
  await put('research_artifacts', artifact);
  return artifact;
}

// --- Conflict handling ---------------------------------------------------
// Artifacts are append-only and never mutated except `validatedBy`, which
// two participants can add themselves to concurrently before either has
// seen the other's write. `validatedBy` is a grow-only set, so merging two
// versions of the same artifact is just a union — no real CRDT library
// needed, but the semantics matter: a naive last-write-wins `put()` would
// silently drop someone's validation. mergeArtifact() is what every
// incoming copy of an artifact (from a fresh artifact broadcast, a
// validation broadcast, or a sync response) should go through instead of a
// raw put — see app.js's `research_artifact` handling.

export function unionValidatedBy(existing, incoming) {
  return [...new Set([...(existing?.validatedBy || []), ...(incoming?.validatedBy || [])])];
}

export async function mergeArtifact(incoming) {
  const existing = await get('research_artifacts', incoming.artifactId);
  if (!existing) {
    await put('research_artifacts', incoming);
    return incoming;
  }
  const merged = { ...existing, validatedBy: unionValidatedBy(existing, incoming) };
  await put('research_artifacts', merged);
  return merged;
}

export async function validateArtifact(artifactId, byIdentityId) {
  const a = await get('research_artifacts', artifactId);
  if (!a) throw new Error('Artifact not found');
  if (!a.validatedBy.includes(byIdentityId)) a.validatedBy.push(byIdentityId);
  await put('research_artifacts', a);
  return a;
}

export async function listProjects() {
  return getAll('research_projects');
}

export async function listArtifacts(projectId) {
  const items = await getAll('research_artifacts', 'projectId', projectId);
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export async function exportProject(projectId) {
  const project = await get('research_projects', projectId);
  if (!project) throw new Error('Project not found');
  const artifacts = await listArtifacts(projectId);
  return {
    format: 'project.jobber',
    version: 1,
    exportedAt: Date.now(),
    project,
    artifacts,
  };
}

export async function importProject(bundle) {
  if (!bundle || bundle.format !== 'project.jobber') {
    throw new Error('Unsupported or missing project.jobber format');
  }
  await put('research_projects', bundle.project);
  for (const a of bundle.artifacts) await put('research_artifacts', a);
  return bundle.project;
}

// --- Simple layered graph layout for rendering, computed from real data ---
export function layoutGraph(artifacts) {
  const byId = new Map(artifacts.map((a) => [a.artifactId, a]));
  const depth = new Map();

  function depthOf(a) {
    if (depth.has(a.artifactId)) return depth.get(a.artifactId);
    if (!a.parents || a.parents.length === 0) {
      depth.set(a.artifactId, 0);
      return 0;
    }
    const d = 1 + Math.max(...a.parents.map((pid) => (byId.has(pid) ? depthOf(byId.get(pid)) : 0)));
    depth.set(a.artifactId, d);
    return d;
  }

  const nodes = artifacts.map((a) => ({ artifact: a, depth: depthOf(a) }));
  const columns = new Map();
  for (const n of nodes) {
    if (!columns.has(n.depth)) columns.set(n.depth, []);
    columns.get(n.depth).push(n);
  }

  const edges = [];
  for (const a of artifacts) {
    for (const pid of a.parents || []) {
      if (byId.has(pid)) edges.push({ from: pid, to: a.artifactId });
    }
  }

  return { columns, edges, maxDepth: Math.max(0, ...nodes.map((n) => n.depth)) };
}
