// conversations.js — everything that happens once two identities have
// found each other: blocking, meeting proposals, document requests
// (cover letters), chat itself (persisted, identity-keyed, offline-queued),
// and attachments (real offer/accept handshake, no bytes move without
// consent). See state.js's header comment for why this file doesn't import
// discovery-ui.js or research-ui.js even though it's called from both.
//
// Every relationship here is keyed by *both* sides' identity now, not just
// theirs — more than one of my own identities can be live in the same
// namespace at once (state.js's searchLive), so "my chat with peer X" has
// to say which of my identities it's with. Every P2P send below also
// stamps `targetIdentityId: theirIdentityId` (protocol.js) — from the
// sender's point of view that's always "whichever of the recipient's
// identities I mean", the same value whether it's a cold-start request or
// a response to one, so there's no special-casing between the two.

import * as db from './db.js';
import * as p2p from './p2p.js';
import * as credibility from './credibility.js';
import { state, canInitiateChat, resolveLiveIdentity } from './state.js';
import { openModal, toast } from './ui-kit.js';
import { getProfile } from './profiles.js';

/* ---- Blocklist (spec §48 — local only, no global enforcement) -------- */
/* ---- Namespace-wide by design: blocking someone is "I don't want to  -*/
/* ---- hear from them", not a decision one of my personas makes alone. -*/

export async function blockPeer(ns, blockedIdentityId, displayNameHint) {
  const compoundId = `${ns}:${blockedIdentityId}`;
  await db.put('blocklist', { compoundId, namespace: ns, blockedIdentityId, displayNameHint, blockedAt: Date.now() });
  state.blocked[ns].add(blockedIdentityId);
  for (const [peerId, meta] of state.discovered[ns].entries()) {
    if (meta.sender === blockedIdentityId) state.discovered[ns].delete(peerId);
  }
  toast(`Blocked ${blockedIdentityId.slice(0, 10)}… locally`);
  state.render.workspace();
}

export async function unblockPeer(ns, blockedIdentityId) {
  await db.del('blocklist', `${ns}:${blockedIdentityId}`);
  state.blocked[ns].delete(blockedIdentityId);
  state.render.workspace();
}

/* ---- Meetings ---------------------------------------------------------- */

export function proposeMeetingFlow(ns, id, theirIdentityId) {
  openModal('Propose a meeting', `
      <label>Proposed time</label>
      <input type="text" id="when" placeholder="e.g. Thu 14:00 CET">
      <label>Note (optional)</label>
      <input type="text" id="note" placeholder="Video call, coffee, on-site…">
    `, {
    submitLabel: 'Send proposal',
    onSubmit: (dlg) => {
      const when = dlg.querySelector('#when').value.trim();
      const note = dlg.querySelector('#note').value.trim();
      if (!when) return;
      const peerId = state.identityToPeer[ns].get(theirIdentityId);
      if (!peerId) { toast('This peer is not currently connected.'); return; }
      const msg = p2p.getRoom(ns).send('meeting_proposal', id.identityId, { when, note }, peerId, undefined, theirIdentityId);
      state.pendingMeetings[ns].get(id.identityId).set(theirIdentityId, { status: 'outgoing', when, note, requestId: msg.messageId });
      state.render.workspace();
    },
  });
}

export function respondMeeting(ns, id, theirIdentityId, accept) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const m = state.pendingMeetings[ns].get(id.identityId).get(theirIdentityId) || {};
  if (peerId) p2p.getRoom(ns).send(accept ? 'meeting_accept' : 'meeting_decline', id.identityId, { when: m.when }, peerId, m.requestId, theirIdentityId);
  if (accept) {
    state.pendingMeetings[ns].get(id.identityId).set(theirIdentityId, { ...m, status: 'accepted' });
    credibility.recordEvent(ns, theirIdentityId, credibility.EVENT.MEETING_CONFIRMED, `meeting:${m.requestId}`).then(() => state.render.workspace());
  } else {
    state.pendingMeetings[ns].get(id.identityId).delete(theirIdentityId);
    state.render.workspace();
  }
}

/* ---- Document request/offer (Employment cover letter, spec-adjacent) -- */

export function requestDocument(ns, id, theirIdentityId, doc) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is not currently connected.'); return; }
  const msg = p2p.getRoom(ns).send('document_request', id.identityId, { doc }, peerId, undefined, theirIdentityId);
  state.pendingDocs[ns].get(id.identityId).set(theirIdentityId, { status: 'outgoing', doc, requestId: msg.messageId });
  state.render.workspace();
}

export async function shareDocument(ns, id, theirIdentityId, doc) {
  const profile = await getProfile(id.identityId);
  const text = doc === 'cover_letter' ? profile.coverLetterText : '';
  if (!text) { toast('Nothing to share yet — write it in your profile first.'); return; }
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is no longer connected.'); return; }
  const requestId = state.pendingDocs[ns].get(id.identityId).get(theirIdentityId)?.requestId;
  p2p.getRoom(ns).send('document_offer', id.identityId, { doc, text }, peerId, requestId, theirIdentityId);
  state.pendingDocs[ns].get(id.identityId).set(theirIdentityId, { status: 'shared', doc });
  await credibility.recordEvent(ns, theirIdentityId, credibility.EVENT.DOCUMENT_SHARED, `document:${requestId}`);
  state.render.workspace();
}

export function declineDocument(ns, myIdentityId, theirIdentityId) {
  state.pendingDocs[ns].get(myIdentityId).delete(theirIdentityId);
  state.render.workspace();
}

/* ---- Chat persistence: messages survive reload, keyed by both my ----- */
/* ---- own identity and the other side's — not their ephemeral peer id. */

export function conversationRoom(ns, myIdentityId, theirIdentityId) {
  return `${ns}:${myIdentityId}:${theirIdentityId}`;
}

// If `record` already carries a `messageId` (e.g. a message arriving via
// conversation resync, see below), that id is reused instead of generating
// a new one — `put` then upserts the same record rather than duplicating
// it, which is what makes resyncing idempotent across repeated attempts.
export async function persistMessage(ns, myIdentityId, theirIdentityId, record) {
  const stored = {
    ...record,
    messageId: record.messageId || crypto.randomUUID(),
    room: conversationRoom(ns, myIdentityId, theirIdentityId),
    ns, mine: myIdentityId, counterpart: theirIdentityId,
  };
  await db.put('messages', stored);
  return stored;
}

export async function loadConversation(ns, myIdentityId, theirIdentityId) {
  const loaded = state.loadedConversations[ns].get(myIdentityId);
  const log = state.chatLog[ns].get(myIdentityId);
  if (loaded.has(theirIdentityId)) return log.get(theirIdentityId) || [];
  const rows = await db.getAll('messages', 'room', conversationRoom(ns, myIdentityId, theirIdentityId));
  const entries = rows.sort((a, b) => a.ts - b.ts).map((r) => ({
    from: r.from, kind: r.kind, ts: r.ts, text: r.text, name: r.name, size: r.size, delivered: r.delivered,
    url: r.blob ? URL.createObjectURL(r.blob) : r.url,
  }));
  log.set(theirIdentityId, entries);
  loaded.add(theirIdentityId);
  return entries;
}

// Every persisted conversation for this identity in this namespace, most
// recent first — so a past chat can be reopened and read even if that peer
// isn't online right now.
export async function listConversations(ns, myIdentityId) {
  const all = await db.getAll('messages');
  const byCounterpart = new Map();
  for (const m of all) {
    if (m.ns !== ns || m.mine !== myIdentityId) continue;
    const existing = byCounterpart.get(m.counterpart);
    if (!existing || m.ts > existing.ts) byCounterpart.set(m.counterpart, m);
  }
  return [...byCounterpart.values()].sort((a, b) => b.ts - a.ts);
}

// Any message written while the recipient was offline is saved with
// delivered:false. The moment we see that identity connect again (any
// message from them proves it), flush whatever's queued for them — no
// separate polling, no server, just "did we just learn they're back".
// Loops every one of *my* currently-live identities in this namespace,
// since the message that revealed the peer is back (often just their
// discovery broadcast) isn't itself addressed to one specific identity of
// mine the way a chat/meeting message would be.
export async function flushOutbox(ns, theirIdentityId) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const room = p2p.getRoom(ns);
  if (!peerId || !room) return;
  for (const myIdentityId of state.searchLive[ns] instanceof Set ? state.searchLive[ns] : []) {
    const rows = await db.getAll('messages', 'room', conversationRoom(ns, myIdentityId, theirIdentityId));
    const pending = rows.filter((r) => r.from === 'me' && r.delivered === false).sort((a, b) => a.ts - b.ts);
    if (!pending.length) continue;

    for (const r of pending) {
      if (r.kind === 'attachment' && r.blob) {
        room.sendBlob(r.blob, peerId, { name: r.name, size: r.size, type: r.blob.type, offerId: r.messageId });
      } else {
        room.send('chat_message', myIdentityId, { text: r.text, messageId: r.messageId }, peerId, undefined, theirIdentityId);
      }
      r.delivered = true;
      await db.put('messages', r);
    }
    state.loadedConversations[ns].get(myIdentityId).delete(theirIdentityId); // force a re-hydrate so delivered state is fresh next open
    toast(`Delivered ${pending.length} queued message${pending.length > 1 ? 's' : ''} to ${theirIdentityId.slice(0, 8)}…`);
  }
  state.render.workspace();
}

/* ---- Conversation resync: recover history from whoever's still got it - */
/* ---- e.g. after restoring identities from a backup with an empty local -*/
/* ---- message store, or just a cache that got cleared.                 -*/

// Sends the list of message ids I already have for this conversation so
// the other side can figure out what I'm missing — same "diff known ids"
// pattern research.js's project sync already uses for artifacts. Loops
// every one of my live identities for the same reason flushOutbox does.
export async function requestConversationSync(ns, theirIdentityId) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const room = p2p.getRoom(ns);
  if (!peerId || !room) return;
  for (const myIdentityId of state.searchLive[ns] instanceof Set ? state.searchLive[ns] : []) {
    const known = await db.getAll('messages', 'room', conversationRoom(ns, myIdentityId, theirIdentityId));
    if (!known.length) continue; // nothing recorded yet under this identity — no history to reconcile
    room.send('conversation_sync_request', myIdentityId, {
      knownMessageIds: known.map((m) => m.messageId),
    }, peerId, undefined, theirIdentityId);
  }
}

// I'm the one who still has the history — send back whatever the
// requester (msg.sender) doesn't have yet, for whichever of my identities
// they addressed (msg.targetIdentityId). Text/metadata goes over the
// normal JSON channel; attachment bytes can't be JSON-serialized, so they
// follow separately over the binary channel, tagged with the same
// messageId so the requester can attach the bytes to the right record
// instead of creating a duplicate entry.
export async function handleConversationSyncRequest(ns, msg, peerId) {
  const myIdentityId = resolveLiveIdentity(ns, msg.targetIdentityId);
  if (!myIdentityId) return;
  const mine = await db.getAll('messages', 'room', conversationRoom(ns, myIdentityId, msg.sender));
  const missing = mine.filter((m) => !msg.payload.knownMessageIds.includes(m.messageId));
  if (!missing.length) return;
  const room = p2p.getRoom(ns);
  const textPayload = missing.map(({ blob, url, ...rest }) => rest); // Blob/object-URL can't cross JSON
  room.send('conversation_sync_response', myIdentityId, { messages: textPayload }, peerId, undefined, msg.sender);
  for (const m of missing) {
    if (m.kind === 'attachment' && m.blob) {
      room.sendBlob(m.blob, peerId, { name: m.name, size: m.size, type: m.blob.type, forMessageId: m.messageId });
    }
  }
}

// Receiving the synced messages back. `from` in the payload is relative to
// whoever sent it (the responder), so it has to be flipped to be relative
// to me before storing — what was their "me" is my "them".
export async function handleConversationSyncResponse(ns, msg) {
  const myIdentityId = resolveLiveIdentity(ns, msg.targetIdentityId);
  if (!myIdentityId) return;
  let restored = 0;
  for (const m of msg.payload.messages) {
    await persistMessage(ns, myIdentityId, msg.sender, { ...m, from: m.from === 'me' ? 'them' : 'me' });
    restored++;
  }
  if (restored) {
    state.loadedConversations[ns].get(myIdentityId).delete(msg.sender); // force a re-hydrate to pick up the restored history
    if (state.openChatWith[ns].get(myIdentityId) === msg.sender) state.render.workspace();
  }
}

export function requestChat(ns, id, theirIdentityId) {
  if (!canInitiateChat(ns, id.role)) { toast('In this namespace, the other side reaches out first.'); return; }
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is not currently connected.'); return; }
  const room = p2p.getRoom(ns);
  const msg = room.send('chat_request', id.identityId, {}, peerId, undefined, theirIdentityId);
  state.pendingChats[ns].get(id.identityId).set(theirIdentityId, { status: 'outgoing', requestId: msg.messageId });
  state.render.workspace();
}

export function respondChat(ns, id, theirIdentityId, accept) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is no longer connected.'); return; }
  const requestId = state.pendingChats[ns].get(id.identityId).get(theirIdentityId)?.requestId;
  const room = p2p.getRoom(ns);
  room.send(accept ? 'chat_accept' : 'chat_decline', id.identityId, {}, peerId, requestId, theirIdentityId);
  if (accept) {
    state.pendingChats[ns].get(id.identityId).set(theirIdentityId, { status: 'accepted' });
    state.openChatWith[ns].set(id.identityId, theirIdentityId);
    credibility.recordEvent(ns, theirIdentityId, credibility.EVENT.CHAT_ACCEPTED).then(() => state.render.workspace());
  } else {
    state.pendingChats[ns].get(id.identityId).delete(theirIdentityId);
    state.render.workspace();
  }
}

// The canonical id for this logical message is generated here and put in
// both the local record and the wire payload, so both sides end up storing
// the same messageId for the same message — required for resync's "diff
// known ids" to actually converge instead of treating every message as
// unknown to the other side forever (each side previously minted its own
// random id independently, so the sets could never meaningfully overlap).
export async function sendChatMessage(ns, id, theirIdentityId, text) {
  if (!text.trim()) return;
  const messageId = crypto.randomUUID();
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const entry = { messageId, from: 'me', text, ts: Date.now(), delivered: !!peerId };
  const log = state.chatLog[ns].get(id.identityId);
  if (!log.has(theirIdentityId)) log.set(theirIdentityId, []);
  log.get(theirIdentityId).push(entry);
  state.loadedConversations[ns].get(id.identityId).add(theirIdentityId);
  await persistMessage(ns, id.identityId, theirIdentityId, entry);
  if (peerId) {
    p2p.getRoom(ns).send('chat_message', id.identityId, { text, messageId }, peerId, undefined, theirIdentityId);
  } else {
    toast('Saved locally — this peer is offline right now. It\'ll be sent automatically as soon as they\'re seen back online.');
  }
  state.render.workspace();
}

export function renderChatPanel(ns, id, theirIdentityId) {
  const log = state.chatLog[ns].get(id.identityId).get(theirIdentityId) || [];
  const connected = state.identityToPeer[ns].has(theirIdentityId);
  const bubble = (m) => {
    const queued = m.from === 'me' && m.delivered === false ? ' <span style="opacity:.6;font-size:10px">· queued</span>' : '';
    return m.kind === 'attachment'
      ? `<a class="chat-msg attachment ${m.from === 'me' ? 'mine' : ''}" href="${m.url}" download="${m.name}">📎 ${m.name} <span>(${(m.size / 1024).toFixed(1)} KB)</span>${queued}</a>`
      : `<div class="chat-msg ${m.from === 'me' ? 'mine' : ''}">${m.text}${queued}</div>`;
  };
  const offers = [...state.pendingAttachmentOffers[ns].get(id.identityId).entries()].filter(([, o]) => o.theirIdentityId === theirIdentityId);
  const offersHtml = offers.map(([offerId, o]) => {
    return `
      <div class="meeting-banner">
        ${o.status === 'incoming'
          ? `📎 Incoming file: <b>${o.name}</b> (${(o.size / 1024).toFixed(1)} KB)
             <button class="btn small primary attach-accept" data-offer="${offerId}">Accept</button>
             <button class="btn small attach-decline" data-offer="${offerId}">Decline</button>`
          : o.status === 'incoming-accepted'
            ? `Accepted <b>${o.name}</b> — waiting for it to arrive…`
            : `Offered <b>${o.name}</b> — waiting for them to accept…`}
      </div>`;
  }).join('');

  return `
    <div class="panel" style="margin-top:16px">
      <div class="chat">
        <div class="chat-head">
          <button class="btn small ghost" id="closeChat" style="margin-right:8px">← Back</button>
          Conversation with ${theirIdentityId.slice(0, 10)}…
          ${connected ? '' : '<span style="color:var(--low);font-weight:400;margin-left:8px">· offline, showing history</span>'}
        </div>
        ${offersHtml}
        <div class="chat-log" id="chatLog">
          ${log.map(bubble).join('') || '<div style="color:var(--low);font-size:12px">Say hello — this goes straight over WebRTC, no server in between. Saved locally, so it\'s still here next time you open Jobber.</div>'}
        </div>
        <div class="chat-input">
          <input type="text" id="chatInput" placeholder="Write a message…">
          <label class="btn ghost" style="display:flex;align-items:center" title="Offer a file — sent only if they accept">
            📎<input type="file" id="chatFile" style="display:none">
          </label>
          <button class="btn primary" id="chatSend">Send</button>
        </div>
      </div>
    </div>`;
}

// Attachments go through a real offer/accept handshake — no bytes move
// until the recipient explicitly consents. See message-router.js's
// 'attachment_offer' / 'attachment_accept' / 'attachment_decline' cases for
// the other half of this flow.
export function proposeAttachment(ns, id, theirIdentityId, file) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer isn\'t currently connected — offering a file needs a live connection.'); return; }
  const offerId = crypto.randomUUID();
  state.pendingAttachmentOffers[ns].get(id.identityId).set(offerId, {
    status: 'outgoing', name: file.name, size: file.size, type: file.type, theirIdentityId, file,
  });
  p2p.getRoom(ns).send('attachment_offer', id.identityId, { offerId, name: file.name, size: file.size, type: file.type }, peerId, undefined, theirIdentityId);
  state.render.workspace();
}

export function respondAttachmentOffer(ns, id, offerId, accept) {
  const offer = state.pendingAttachmentOffers[ns].get(id.identityId).get(offerId);
  if (!offer) return;
  const peerId = state.identityToPeer[ns].get(offer.theirIdentityId);
  if (peerId) {
    p2p.getRoom(ns).send(accept ? 'attachment_accept' : 'attachment_decline', id.identityId, { offerId }, peerId, undefined, offer.theirIdentityId);
  }
  if (accept) {
    state.pendingAttachmentOffers[ns].get(id.identityId).set(offerId, { ...offer, status: 'incoming-accepted' });
    credibility.recordEvent(ns, offer.theirIdentityId, credibility.EVENT.ATTACHMENT_COMPLETED, `attachment:${offerId}`).then(() => state.render.workspace());
  } else {
    state.pendingAttachmentOffers[ns].get(id.identityId).delete(offerId);
    state.render.workspace();
  }
}
