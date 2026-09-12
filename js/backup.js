// backup.js — a single JSON file covering everything IndexedDB holds
// except conversations/attachments (see the note below), so you can
// recover from a cleared cache, a browser reinstall, or move to another
// device without losing your identities.
//
// This is deliberately separate from Research's per-project
// `project.jobber` export (research.js) — that one is for sharing a single
// project with a collaborator; this one is for backing up *everything you
// are* in this browser.
//
// IMPORTANT: the exported file contains private key material. Anyone who
// gets it can act as every identity in it. Treat it like a password
// manager export, not like a casual settings file.

import * as db from './db.js';
import * as identity from './identity.js';
import * as products from './products.js';

export const BACKUP_FORMAT = 'jobber-backup';
export const BACKUP_VERSION = 1;

export async function exportAllData() {
  const identities = await db.getAll('identities');
  const identityBackups = [];
  for (const id of identities) {
    identityBackups.push(await identity.exportIdentityRecord(id.identityId));
  }

  const profiles = await db.getAll('profiles');
  const blocklist = await db.getAll('blocklist');
  const researchProjects = await db.getAll('research_projects');
  const researchArtifacts = await db.getAll('research_artifacts');

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    identities: identityBackups,
    profiles,
    blocklist,
    researchProjects,
    researchArtifacts,
    // Deliberately not included: chat messages/attachments (they'd need
    // Blob-to-base64 conversion for every attachment, and conversation
    // history is lower-stakes to lose than identities/keys) and the
    // `cache` store (only session preferences like last-active namespace —
    // not worth restoring on a different device anyway).
  };
}

export function validateBackup(bundle) {
  if (!bundle || typeof bundle !== 'object') return { ok: false, reason: 'not a JSON object' };
  if (bundle.format !== BACKUP_FORMAT) return { ok: false, reason: `expected format "${BACKUP_FORMAT}"` };
  if (!Array.isArray(bundle.identities)) return { ok: false, reason: 'missing identities array' };
  return { ok: true };
}

// Imports are additive/idempotent: identityId is re-derived from the key
// on the way in (see identity.importIdentityRecord), so importing the same
// backup twice — or restoring on top of some identities you already
// have — just overwrites with identical data rather than duplicating.
export async function importAllData(bundle) {
  const v = validateBackup(bundle);
  if (!v.ok) throw new Error('Invalid backup file: ' + v.reason);

  const results = { identities: 0, profiles: 0, blocklist: 0, researchProjects: 0, researchArtifacts: 0, errors: [] };

  for (const record of bundle.identities) {
    try {
      await identity.importIdentityRecord(record);
      results.identities++;
    } catch (e) {
      results.errors.push(`identity ${record.identityId}: ${e.message}`);
    }
  }
  // Merges whatever products the imported identities carried into every
  // identity already in this browser, and vice versa — see products.js.
  // Runs even on a partial/failed import: whatever did land should still
  // end up in sync with everything else.
  if (results.identities > 0) await products.syncAllIdentities();
  for (const profile of bundle.profiles || []) {
    await db.put('profiles', profile);
    results.profiles++;
  }
  for (const entry of bundle.blocklist || []) {
    await db.put('blocklist', entry);
    results.blocklist++;
  }
  for (const project of bundle.researchProjects || []) {
    await db.put('research_projects', project);
    results.researchProjects++;
  }
  for (const artifact of bundle.researchArtifacts || []) {
    await db.put('research_artifacts', artifact);
    results.researchArtifacts++;
  }

  return results;
}
