// src/storage/profiles.js
//
// Persistance locale des CandidateProfile / JobProfile déjà analysés, pour
// éviter de réanalyser le même document à chaque match (§32).

import { STORES, put, get, getAll, del, clearStore } from './idb.js';

/** @param {import('../core/extraction/buildProfile.js').CandidateProfile | import('../core/extraction/buildProfile.js').JobProfile} profile */
export function saveProfile(profile) {
  return put(STORES.PROFILES, profile);
}

export function getProfile(id) {
  return get(STORES.PROFILES, id);
}

export function listProfiles() {
  return getAll(STORES.PROFILES);
}

export function deleteProfile(id) {
  return del(STORES.PROFILES, id);
}

export function clearAllProfiles() {
  return clearStore(STORES.PROFILES);
}
