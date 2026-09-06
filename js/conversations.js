// conversations.js — everything that happens once two identities have
// found each other: blocking, meeting proposals, document requests
// (cover letters), chat itself (persisted, identity-keyed, offline-queued),
// and attachments (real offer/accept handshake, no bytes move without
// consent). See state.js's header comment for why this file doesn't import
// discovery-ui.js or research-ui.js even though it's called from both.

import * as db from './db.js';
import * as p2p from './p2p.js';
import { state } from './state.js';
import { openModal, toast } from './ui-kit.js';
import { getProfile } from './profiles.js';

/* ---- Blocklist (spec §48 — local only, no global enforcement) -------- */

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
      const msg = p2p.getRoom(ns).send('meeting_proposal', id.identityId, { when, note }, peerId);
      state.pendingMeetings[ns].set(theirIdentityId, { status: 'outgoing', when, note, requestId: msg.messageId });
      state.render.workspace();
    },
  });
}

export function respondMeeting(ns, id, theirIdentityId, accept) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const m = state.pendingMeetings[ns].get(theirIdentityId) || {};
  if (peerId) p2p.getRoom(ns).send(accept ? 'meeting_accept' : 'meeting_decline', id.identityId, { when: m.when }, peerId, m.requestId);
  if (accept) state.pendingMeetings[ns].set(theirIdentityId, { ...m, status: 'accepted' });
  else state.pendingMeetings[ns].delete(theirIdentityId);
  state.render.workspace();
}

/* ---- Document request/offer (Employment cover letter, spec-adjacent) -- */

export function requestDocument(ns, id, theirIdentityId, doc) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is not currently connected.'); return; }
  const msg = p2p.getRoom(ns).send('document_request', id.identityId, { doc }, peerId);
  state.pendingDocs[ns].set(theirIdentityId, { status: 'outgoing', doc, requestId: msg.messageId });
  state.render.workspace();
}

export async function shareDocument(ns, id, theirIdentityId, doc) {
  const profile = await getProfile(id.identityId);
  const text = doc === 'cover_letter' ? profile.coverLetterText : '';
  if (!text) { toast('Nothing to share yet — write it in your profile first.'); return; }
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is no longer connected.'); return; }
  const requestId = state.pendingDocs[ns].get(theirIdentityId)?.requestId;
  p2p.getRoom(ns).send('document_offer', id.identityId, { doc, text }, peerId, requestId);
  state.pendingDocs[ns].set(theirIdentityId, { status: 'shared', doc });
  state.render.workspace();
}

export function declineDocument(ns, theirIdentityId) {
  state.pendingDocs[ns].delete(theirIdentityId);
  state.render.workspace();
}

/* ---- Chat persistence: messages survive reload, keyed by the other ---- */
/* ---- side's stable identity, not their ephemeral WebRTC peer id.   ---- */

export function conversationRoom(ns, theirIdentityId) {
  return `${ns}:${theirIdentityId}`;
}

export async function persistMessage(ns, theirIdentityId, record) {
  const stored = {
    messageId: crypto.randomUUID(),
    room: conversationRoom(ns, theirIdentityId),
    ns, counterpart: theirIdentityId,
    ...record,
  };
  await db.put('messages', stored);
  return stored;
}

export async function loadConversation(ns, theirIdentityId) {
  if (state.loadedConversations[ns].has(theirIdentityId)) return state.chatLog[ns].get(theirIdentityId) || [];
  const rows = await db.getAll('messages', 'room', conversationRoom(ns, theirIdentityId));
  const log = rows.sort((a, b) => a.ts - b.ts).map((r) => ({
    from: r.from, kind: r.kind, ts: r.ts, text: r.text, name: r.name, size: r.size, delivered: r.delivered,
    url: r.blob ? URL.createObjectURL(r.blob) : r.url,
  }));
  state.chatLog[ns].set(theirIdentityId, log);
  state.loadedConversations[ns].add(theirIdentityId);
  return log;
}

// Every persisted conversation in this namespace, most recent first — so a
// past chat can be reopened and read even if that peer isn't online right now.
export async function listConversations(ns) {
  const all = await db.getAll('messages');
  const byCounterpart = new Map();
  for (const m of all) {
    if (m.ns !== ns) continue;
    const existing = byCounterpart.get(m.counterpart);
    if (!existing || m.ts > existing.ts) byCounterpart.set(m.counterpart, m);
  }
  return [...byCounterpart.values()].sort((a, b) => b.ts - a.ts);
}

// Any message written while the recipient was offline is saved with
// delivered:false. The moment we see that identity connect again (any
// message from them proves it), flush whatever's queued for them — no
// separate polling, no server, just "did we just learn they're back".
export async function flushOutbox(ns, theirIdentityId) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const myIdentityId = state.activeIdentityId[ns];
  const room = p2p.getRoom(ns);
  if (!peerId || !myIdentityId || !room) return;

  const rows = await db.getAll('messages', 'room', conversationRoom(ns, theirIdentityId));
  const pending = rows.filter((r) => r.from === 'me' && r.delivered === false).sort((a, b) => a.ts - b.ts);
  if (!pending.length) return;

  for (const r of pending) {
    if (r.kind === 'attachment' && r.blob) {
      room.sendBlob(r.blob, peerId, { name: r.name, size: r.size, type: r.blob.type });
    } else {
      room.send('chat_message', myIdentityId, { text: r.text }, peerId);
    }
    r.delivered = true;
    await db.put('messages', r);
  }
  state.loadedConversations[ns].delete(theirIdentityId); // force a re-hydrate so delivered state is fresh next open
  toast(`Delivered ${pending.length} queued message${pending.length > 1 ? 's' : ''} to ${theirIdentityId.slice(0, 8)}…`);
  state.render.workspace();
}

export function requestChat(ns, id, theirIdentityId) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is not currently connected.'); return; }
  const room = p2p.getRoom(ns);
  const msg = room.send('chat_request', id.identityId, {}, peerId);
  state.pendingChats[ns].set(theirIdentityId, { status: 'outgoing', requestId: msg.messageId });
  state.render.workspace();
}

export function respondChat(ns, id, theirIdentityId, accept) {
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  if (!peerId) { toast('This peer is no longer connected.'); return; }
  const requestId = state.pendingChats[ns].get(theirIdentityId)?.requestId;
  const room = p2p.getRoom(ns);
  room.send(accept ? 'chat_accept' : 'chat_decline', id.identityId, {}, peerId, requestId);
  if (accept) { state.pendingChats[ns].set(theirIdentityId, { status: 'accepted' }); state.openChatWith[ns] = theirIdentityId; }
  else state.pendingChats[ns].delete(theirIdentityId);
  state.render.workspace();
}

export async function sendChatMessage(ns, id, theirIdentityId, text) {
  if (!text.trim()) return;
  const peerId = state.identityToPeer[ns].get(theirIdentityId);
  const entry = { from: 'me', text, ts: Date.now(), delivered: !!peerId };
  if (!state.chatLog[ns].has(theirIdentityId)) state.chatLog[ns].set(theirIdentityId, []);
  state.chatLog[ns].get(theirIdentityId).push(entry);
  state.loadedConversations[ns].add(theirIdentityId);
  await persistMessage(ns, theirIdentityId, entry);
  if (peerId) {
    p2p.getRoom(ns).send('chat_message', id.identityId, { text }, peerId);
  } else {
    toast('Saved locally — this peer is offline right now. It\'ll be sent automatically as soon as they\'re seen back online.');
  }
  state.render.workspace();
}

export function renderChatPanel(ns, id, theirIdentityId) {
  const log = state.chatLog[ns].get(theirIdentityId) || [];
  const connected = state.identityToPeer[ns].has(theirIdentityId);
  const bubble = (m) => {
    const queued = m.from === 'me' && m.delivered === false ? ' <span style="opacity:.6;font-size:10px">· queued</span>' : '';
    return m.kind === 'attachment'
      ? `<a class="chat-msg attachment ${m.from === 'me' ? 'mine' : ''}" href="${m.url}" download="${m.name}">📎 ${m.name} <span>(${(m.size / 1024).toFixed(1)} KB)</span>${queued}</a>`
      : `<div class="chat-msg ${m.from === 'me' ? 'mine' : ''}">${m.text}${queued}</div>`;
  };
  const offers = [...state.pendingAttachmentOffers[ns].entries()].filter(([, o]) => o.theirIdentityId === theirIdentityId);
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
  state.pendingAttachmentOffers[ns].set(offerId, {
    status: 'outgoing', name: file.name, size: file.size, type: file.type, theirIdentityId, file,
  });
  p2p.getRoom(ns).send('attachment_offer', id.identityId, { offerId, name: file.name, size: file.size, type: file.type }, peerId);
  state.render.workspace();
}

export function respondAttachmentOffer(ns, id, offerId, accept) {
  const offer = state.pendingAttachmentOffers[ns].get(offerId);
  if (!offer) return;
  const peerId = state.identityToPeer[ns].get(offer.theirIdentityId);
  if (peerId) {
    p2p.getRoom(ns).send(accept ? 'attachment_accept' : 'attachment_decline', id.identityId, { offerId }, peerId);
  }
  if (accept) state.pendingAttachmentOffers[ns].set(offerId, { ...offer, status: 'incoming-accepted' });
  else state.pendingAttachmentOffers[ns].delete(offerId);
  state.render.workspace();
}
