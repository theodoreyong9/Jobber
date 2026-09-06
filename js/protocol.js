// protocol.js — the wire format every peer speaks, and its validation.
// A message that fails validation is dropped before it ever reaches app logic.

export const PROTOCOL_VERSION = '0.4';

export const MESSAGE_TYPES = [
  'discovery',
  'discovery_response',
  'search_request',
  'search_response',
  'match_proposal',
  'chat_request',
  'chat_accept',
  'chat_decline',
  'chat_message',
  'meeting_proposal',
  'meeting_accept',
  'meeting_decline',
  'identity_retired',
  'attachment_offer',
  'attachment_accept',
  'research_sync_request',
  'research_sync_response',
  'research_artifact',
];

const MAX_MESSAGE_BYTES = 200_000;

export function createMessage(type, namespace, senderId, payload = {}, extra = {}) {
  if (!MESSAGE_TYPES.includes(type)) {
    throw new Error(`Unknown message type: ${type}`);
  }
  return {
    v: PROTOCOL_VERSION,
    type,
    namespace,
    sender: senderId,
    messageId: crypto.randomUUID(),
    timestamp: Date.now(),
    payload,
    ...extra,
  };
}

export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'not an object' };
  if (msg.v !== PROTOCOL_VERSION) return { ok: false, reason: `protocol version mismatch (got ${msg.v})` };
  if (!MESSAGE_TYPES.includes(msg.type)) return { ok: false, reason: `unknown type ${msg.type}` };
  if (typeof msg.namespace !== 'string' || !msg.namespace) return { ok: false, reason: 'missing namespace' };
  if (typeof msg.sender !== 'string' || !msg.sender) return { ok: false, reason: 'missing sender' };
  if (typeof msg.messageId !== 'string' || !msg.messageId) return { ok: false, reason: 'missing messageId' };
  if (typeof msg.timestamp !== 'number') return { ok: false, reason: 'missing timestamp' };

  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(msg)).length;
  } catch {
    return { ok: false, reason: 'not serializable' };
  }
  if (size > MAX_MESSAGE_BYTES) return { ok: false, reason: 'message exceeds size limit' };

  return { ok: true };
}
