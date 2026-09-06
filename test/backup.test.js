import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBackup, BACKUP_FORMAT, BACKUP_VERSION } from '../js/backup.js';

test('validateBackup accepts a well-formed bundle', () => {
  const bundle = { format: BACKUP_FORMAT, version: BACKUP_VERSION, identities: [] };
  assert.equal(validateBackup(bundle).ok, true);
});

test('validateBackup rejects the wrong format string', () => {
  const bundle = { format: 'something-else', identities: [] };
  assert.equal(validateBackup(bundle).ok, false);
});

test('validateBackup rejects a missing identities array', () => {
  assert.equal(validateBackup({ format: BACKUP_FORMAT }).ok, false);
});

test('validateBackup rejects non-objects', () => {
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup(undefined).ok, false);
  assert.equal(validateBackup('a string').ok, false);
  assert.equal(validateBackup(42).ok, false);
});

test('validateBackup rejects identities that is not an array', () => {
  assert.equal(validateBackup({ format: BACKUP_FORMAT, identities: 'nope' }).ok, false);
});
