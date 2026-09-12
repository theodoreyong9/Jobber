import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, validateMessage, PROTOCOL_VERSION, MESSAGE_TYPES } from '../js/protocol.js';

test('createMessage builds a well-formed envelope', () => {
  const msg = createMessage('chat_message', 'job_candidate', 'ABC123', { text: 'hi' });
  assert.equal(msg.v, PROTOCOL_VERSION);
  assert.equal(msg.type, 'chat_message');
  assert.equal(msg.namespace, 'job_candidate');
  assert.equal(msg.sender, 'ABC123');
  assert.equal(msg.payload.text, 'hi');
  assert.ok(msg.messageId);
  assert.equal(typeof msg.timestamp, 'number');
});

test('createMessage rejects unknown types', () => {
  assert.throws(() => createMessage('not_a_type', 'ns', 'id', {}));
});

test('every declared message type round-trips through validateMessage', () => {
  for (const type of MESSAGE_TYPES) {
    const msg = createMessage(type, 'research', 'ID1', { any: 'thing' });
    assert.equal(validateMessage(msg).ok, true, `expected ${type} to validate`);
  }
});

test('validateMessage rejects a wrong protocol version', () => {
  const msg = createMessage('chat_message', 'ns', 'id', {});
  msg.v = '0.1';
  const v = validateMessage(msg);
  assert.equal(v.ok, false);
  assert.match(v.reason, /version/);
});

test('validateMessage rejects missing fields one at a time', () => {
  const base = createMessage('chat_message', 'ns', 'id', {});
  for (const field of ['namespace', 'sender', 'messageId', 'timestamp']) {
    const broken = { ...base, [field]: undefined };
    assert.equal(validateMessage(broken).ok, false, `expected missing ${field} to fail`);
  }
});

test('validateMessage rejects oversized payloads', () => {
  const msg = createMessage('chat_message', 'ns', 'id', { text: 'x'.repeat(300_000) });
  assert.equal(validateMessage(msg).ok, false);
});

test('validateMessage accepts a string correlationId and rejects a non-string one', () => {
  const withId = createMessage('chat_accept', 'ns', 'id', {}, { correlationId: 'abc-123' });
  assert.equal(validateMessage(withId).ok, true);
  const badId = { ...withId, correlationId: 42 };
  assert.equal(validateMessage(badId).ok, false);
});

test('validateMessage accepts a message with no correlationId at all', () => {
  const msg = createMessage('chat_message', 'ns', 'id', {});
  assert.equal(msg.correlationId, undefined);
  assert.equal(validateMessage(msg).ok, true);
});

test('validateMessage accepts a string targetIdentityId and rejects a non-string one', () => {
  const withTarget = createMessage('chat_request', 'ns', 'id', {}, { targetIdentityId: 'CAND1' });
  assert.equal(validateMessage(withTarget).ok, true);
  const badTarget = { ...withTarget, targetIdentityId: 42 };
  assert.equal(validateMessage(badTarget).ok, false);
});

test('validateMessage rejects non-objects', () => {
  assert.equal(validateMessage(null).ok, false);
  assert.equal(validateMessage('hello').ok, false);
  assert.equal(validateMessage(42).ok, false);
});
