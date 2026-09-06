// identity.js — real per-namespace cryptographic identities.
//
// Each identity is an ECDSA (P-256) keypair generated locally with WebCrypto.
// The identityId is derived from a SHA-256 hash of the raw public key, so two
// browsers never collide and nobody but this browser holds the private key.
// Nothing here ever touches a server: keys are generated, used to sign
// protocol messages, and stored only in this browser's IndexedDB.

import { put, get, getAll, del } from './db.js';

async function digestHex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, // extractable — lets the user back up / rotate deliberately
    ['sign', 'verify']
  );
}

export async function createIdentity(namespace, displayName, role = null) {
  const keyPair = await generateKeyPair();
  const rawPublic = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const hash = await digestHex(rawPublic);
  const identityId = hash.slice(0, 12).toUpperCase();

  const record = {
    identityId,
    namespace,
    role, // e.g. "candidate" / "recruiter" — null for single-sided namespaces
    displayName: displayName || 'Unnamed',
    createdAt: Date.now(),
    active: true,
    retiredAt: null,
    rotatedTo: null,
    publicKeyRaw: [...new Uint8Array(rawPublic)], // structured-clone-safe array
    keyPair, // CryptoKey objects — IndexedDB can store these directly
  };
  await put('identities', record);
  return record;
}

export async function listIdentities(namespace) {
  const all = namespace
    ? await getAll('identities', 'namespace', namespace)
    : await getAll('identities');
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getIdentity(identityId) {
  return get('identities', identityId);
}

export async function renameIdentity(identityId, newName) {
  const id = await get('identities', identityId);
  if (!id) throw new Error('Identity not found');
  id.displayName = newName;
  await put('identities', id);
  return id;
}

// Rotation: generate a fresh identity in the same namespace, keep the name,
// mark the old one retired and point it at the new one. Peers who know the
// old id can be told via an `identity_retired` protocol message (see p2p.js).
export async function rotateIdentity(identityId) {
  const old = await get('identities', identityId);
  if (!old) throw new Error('Identity not found');
  const fresh = await createIdentity(old.namespace, old.displayName, old.role);
  old.active = false;
  old.retiredAt = Date.now();
  old.rotatedTo = fresh.identityId;
  await put('identities', old);
  return fresh;
}

export async function retireIdentity(identityId) {
  const id = await get('identities', identityId);
  if (!id) throw new Error('Identity not found');
  id.active = false;
  id.retiredAt = Date.now();
  await put('identities', id);
  return id;
}

export async function deleteIdentity(identityId) {
  await del('identities', identityId);
  await del('profiles', identityId);
}

export async function deleteNamespace(namespace) {
  const ids = await getAll('identities', 'namespace', namespace);
  for (const id of ids) await deleteIdentity(id.identityId);
}

// --- Signing / verification -------------------------------------------

export async function signPayload(identityId, payloadObject) {
  const id = await get('identities', identityId);
  if (!id) throw new Error('Identity not found');
  const data = new TextEncoder().encode(JSON.stringify(payloadObject));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, id.keyPair.privateKey, data);
  return [...new Uint8Array(sig)];
}

export async function verifyPayload(publicKeyRawArray, signatureArray, payloadObject) {
  const publicKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(publicKeyRawArray),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
  const data = new TextEncoder().encode(JSON.stringify(payloadObject));
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    new Uint8Array(signatureArray),
    data
  );
}

export function shortId(identityId) {
  return '#' + identityId;
}

// --- Backup / restore ---------------------------------------------------
// CryptoKey objects can live directly in IndexedDB, but they can't be
// serialized to JSON for a downloadable backup file — exportKey('jwk', ...)
// converts a key to a plain, JSON-safe object; importKey reverses it. Since
// identityId is deterministically derived from the public key, re-importing
// the same keypair always reconstructs the same identityId — imports are
// naturally idempotent, no separate "merge" logic needed.

export async function exportIdentityRecord(identityId) {
  const id = await get('identities', identityId);
  if (!id) throw new Error('Identity not found');
  const [privateKeyJwk, publicKeyJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', id.keyPair.privateKey),
    crypto.subtle.exportKey('jwk', id.keyPair.publicKey),
  ]);
  return {
    identityId: id.identityId, namespace: id.namespace, role: id.role,
    displayName: id.displayName, createdAt: id.createdAt, active: id.active,
    retiredAt: id.retiredAt, rotatedTo: id.rotatedTo,
    publicKeyRaw: id.publicKeyRaw, privateKeyJwk, publicKeyJwk,
  };
}

// Re-derives identityId from the imported public key and refuses to import
// if it doesn't match the claimed one — a corrupted or hand-edited backup
// file should fail loudly here, not silently create a mismatched identity.
export async function importIdentityRecord(record) {
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey('jwk', record.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
    crypto.subtle.importKey('jwk', record.publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
  ]);
  const rawPublic = await crypto.subtle.exportKey('raw', publicKey);
  const hash = await digestHex(rawPublic);
  const derivedId = hash.slice(0, 12).toUpperCase();
  if (derivedId !== record.identityId) {
    throw new Error(`Key/identityId mismatch for ${record.identityId} — backup file may be corrupted`);
  }
  const fullRecord = {
    identityId: record.identityId, namespace: record.namespace, role: record.role,
    displayName: record.displayName, createdAt: record.createdAt, active: record.active,
    retiredAt: record.retiredAt, rotatedTo: record.rotatedTo,
    publicKeyRaw: record.publicKeyRaw, keyPair: { privateKey, publicKey },
  };
  await put('identities', fullRecord);
  return fullRecord;
}
