// identity.js persists to IndexedDB, which isn't available under plain
// Node. These tests exercise the actual cryptographic primitives it's built
// on (WebCrypto is available globally in modern Node) to prove the
// signing/verification behavior is real, without needing a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function generateKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

async function digestHex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('two generated keypairs never produce the same identityId', async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const idA = (await digestHex(await crypto.subtle.exportKey('raw', a.publicKey))).slice(0, 12);
  const idB = (await digestHex(await crypto.subtle.exportKey('raw', b.publicKey))).slice(0, 12);
  assert.notEqual(idA, idB);
});

test('a signature verifies against its own public key', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const data = new TextEncoder().encode(JSON.stringify({ type: 'chat_message', payload: { text: 'hi' } }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, data);
  assert.equal(ok, true);
});

test('a signature does not verify against a different keypair\'s public key', async () => {
  const kp1 = await generateKeyPair();
  const kp2 = await generateKeyPair();
  const data = new TextEncoder().encode('same payload');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp1.privateKey, data);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp2.publicKey, sig, data);
  assert.equal(ok, false);
});

test('a tampered payload fails verification', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const original = new TextEncoder().encode('transfer: 10');
  const tampered = new TextEncoder().encode('transfer: 10000');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, original);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, tampered);
  assert.equal(ok, false);
});
/* ---- Backup export/import round-trip (real crypto, no IndexedDB needed) ---- */

async function digestHexLocal(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('a keypair exported to JWK and reimported reconstructs the same identityId', async () => {
  const keyPair = await generateKeyPair();
  const rawPublic = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const originalId = (await digestHexLocal(rawPublic)).slice(0, 12).toUpperCase();

  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

  const reimportedPublic = await crypto.subtle.importKey('jwk', publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const reimportedPrivate = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);

  const rawPublicAgain = await crypto.subtle.exportKey('raw', reimportedPublic);
  const reimportedId = (await digestHexLocal(rawPublicAgain)).slice(0, 12).toUpperCase();

  assert.equal(reimportedId, originalId);

  // and the reimported private key still produces valid signatures
  const data = new TextEncoder().encode('backup round-trip test');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, reimportedPrivate, data);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, reimportedPublic, sig, data);
  assert.equal(ok, true);
});

test('tampering with the JWK before import changes the derived identityId (integrity check catches it)', async () => {
  const keyPair = await generateKeyPair();
  const rawPublic = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const originalId = (await digestHexLocal(rawPublic)).slice(0, 12).toUpperCase();

  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const tampered = { ...publicKeyJwk, x: publicKeyJwk.x.slice(0, -2) + 'AA' };

  let derivedId = null;
  try {
    const reimported = await crypto.subtle.importKey('jwk', tampered, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const raw = await crypto.subtle.exportKey('raw', reimported);
    derivedId = (await digestHexLocal(raw)).slice(0, 12).toUpperCase();
  } catch {
    derivedId = 'IMPORT_REJECTED'; // an invalid point is also an acceptable outcome
  }
  assert.notEqual(derivedId, originalId);
});
