// research.js — Research Vault: projects, artifacts, provenance.
// Every artifact lives in IndexedDB. Nothing is sent to a server; sync
// between participants happens directly over the P2P room (see p2p.js and
// the sync functions in app.js).

import { put, get, getAll } from './db.js';

export const ARTIFACT_TYPES = [
  'problem', 'hypothesis', 'critique', 'counter_hypothesis', 'evidence',
  'experiment', 'result', 'analysis', 'synthesis', 'decision',
  'reference', 'dataset', 'code', 'document',
];

export async function createProject({ problem, participants, agreement }) {
  const projectId = crypto.randomUUID();
  const project = {
    projectId,
    problem,
    participants, // [{ identityId, displayName }]
    agreement, // { contribution, ownership, publication, commercialization }
    state: 'active',
    createdAt: Date.now(),
  };
  await put('research_projects', project);
  await createArtifact(projectId, 'problem', { text: problem }, {
    author: participants[0]?.identityId,
  });
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
