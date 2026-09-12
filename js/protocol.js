// protocol.js — the wire format every peer speaks, and its validation.
// A message that fails validation is dropped before it ever reaches app logic.
//
// `correlationId` is an optional, recognized field: a response message
// (chat_accept, meeting_decline, document_offer, attachment_accept,
// research_join_accept, ...) sets it to the `messageId` of the request it's
// answering. This matters once more than one request to the same identity
// can be in flight at once — without it, "any accept from sender X" gets
// treated as answering "the request I currently have pending with X",
// which silently misattributes a response if a stale one arrives late or
// a new request superseded an old one.
//
// `targetIdentityId` is the other optional recognized field: once more than
// one of *my own* identities can be live in the same namespace at once (see
// state.js), they all ride the same P2P room/connection — a peer who has
// discovered two of my identities needs a way to say which one a cold-start
// message (chat_request, meeting_proposal, document_request,
// attachment_offer) is actually for, since `sender` on that message is
// *their* identity, not mine. Absent on every other message type, where
// there's already an established, unambiguous conversation to key off of.

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
  'document_request',
  'document_offer',
  'research_sync_request',
  'research_sync_response',
  'research_artifact',
  'research_join_request',
  'research_join_accept',
  'research_join_decline',
  'research_project_update',
  'research_project_announce',
  'conversation_sync_request',
  'conversation_sync_response',
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
  if (msg.correlationId !== undefined && typeof msg.correlationId !== 'string') {
    return { ok: false, reason: 'correlationId must be a string when present' };
  }
  if (msg.targetIdentityId !== undefined && typeof msg.targetIdentityId !== 'string') {
    return { ok: false, reason: 'targetIdentityId must be a string when present' };
  }

  let size = 0;
  try {
    size = new TextEncoder().encode(JSON.stringify(msg)).length;
  } catch {
    return { ok: false, reason: 'not serializable' };
  }
  if (size > MAX_MESSAGE_BYTES) return { ok: false, reason: 'message exceeds size limit' };

  return { ok: true };
}
