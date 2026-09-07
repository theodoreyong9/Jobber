import test from 'node:test';
import assert from 'node:assert/strict';

// idb.js utilise `indexedDB` global, absent sous Node : on vérifie donc ici
// uniquement que le module s'importe sans erreur et expose l'API attendue,
// le comportement réel étant couvert manuellement en navigateur (README).
import * as blocklist from '../src/storage/blocklist.js';

test('le module blocklist expose les fonctions attendues (§75)', () => {
  assert.equal(typeof blocklist.blockPeer, 'function');
  assert.equal(typeof blocklist.unblockPeer, 'function');
  assert.equal(typeof blocklist.isBlocked, 'function');
  assert.equal(typeof blocklist.listBlockedPeers, 'function');
  assert.equal(typeof blocklist.clearBlocklist, 'function');
});
