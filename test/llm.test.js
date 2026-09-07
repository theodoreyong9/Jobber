import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyLlmError, isWebGPUAvailable } from '../js/llm.js';

test('friendlyLlmError recognizes a WebGPU device-lost error and explains it plainly', () => {
  const msg = friendlyLlmError(new Error('Device was lost. This can happen due to insufficient memory.'));
  assert.match(msg, /GPU reset/i);
  assert.doesNotMatch(msg, /Device was lost/); // shouldn't just echo the raw browser error
});

test('friendlyLlmError matches variants of the device-lost wording', () => {
  assert.match(friendlyLlmError(new Error('device has been lost')), /GPU reset/i);
  assert.match(friendlyLlmError({ message: 'GPUDevice was Lost unexpectedly' }), /GPU reset/i);
});

test('friendlyLlmError passes other errors through unchanged', () => {
  const msg = friendlyLlmError(new Error('model file not found'));
  assert.equal(msg, 'model file not found');
});

test('isWebGPUAvailable does not throw outside a browser (no navigator.gpu in Node)', () => {
  assert.equal(typeof isWebGPUAvailable(), 'boolean');
});
