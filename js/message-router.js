// message-router.js — the one function that decides what an incoming,
// already-validated protocol message does. Registers itself into
// `state.handlers.incomingMessage` at the bottom so discovery-ui.js and
// research-ui.js can call it without importing this file directly (which
// would create a cycle, since this file imports their handler functions).

import * as p2p from './p2p.js';
import * as research from './research.js';
import { state } from './state.js';
import { toast } from './ui-kit.js';
import { flushOutbox, loadConversation, persistMessage, requestConversationSync, handleConversationSyncRequest, handleConversationSyncResponse } from './conversations.js';
import {
  handleResearchSyncRequest, handleResearchSyncResponse, handleResearchJoinRequest,
  handleResearchJoinAccept, handleResearchJoinDecline, handleResearchProjectUpdate,
  handleResearchProjectAnnounce,
} from './research-ui.js';

export function handleIncomingMessage(ns, msg, peerId) {
  if (state.blocked[ns]?.has(msg.sender)) return; // local blocklist — silently drop

  // Keep the identity<->live-peer mapping fresh from every message we see,
  // so chat/meetings/documents can be keyed by stable identity while still
  // being able to resolve who to actually send to right now.
  if (msg.sender && peerId) {
    const wasOffline = !state.identityToPeer[ns].has(msg.sender);
    state.peerToIdentity[ns].set(peerId, msg.sender);
    state.identityToPeer[ns].set(msg.sender, peerId);
    if (wasOffline) {
      flushOutbox(ns, msg.sender);
      requestConversationSync(ns, msg.sender); // recover any history they still have that I don't
    }
  }

  if (msg.type === 'discovery') {
    // Reconnecting (a page reload on their end, a dropped/renegotiated
    // WebRTC link, ...) hands the same identity a brand new peerId — the
    // Map is keyed by peerId, so without this it would sit alongside the
    // stale entry as a second "discovery" of the same person, inflating
    // the funnel counts every time either side reloads.
    for (const [existingPeerId, meta] of state.discovered[ns]) {
      if (existingPeerId !== peerId && meta.sender === msg.sender) state.discovered[ns].delete(existingPeerId);
    }
    state.discovered[ns].set(peerId, { ...msg.payload, namespace: ns, v: msg.v, sender: msg.sender, peerId, lastSeen: Date.now() });
    state.render.workspace();
  } else if (msg.type === 'meeting_proposal') {
    state.pendingMeetings[ns].set(msg.sender, { status: 'incoming', when: msg.payload.when, note: msg.payload.note, requestId: msg.messageId });
    toast(`Meeting proposed: ${msg.payload.when}`);
    state.render.workspace();
  } else if (msg.type === 'meeting_accept' || msg.type === 'meeting_decline') {
    const pending = state.pendingMeetings[ns].get(msg.sender);
    if (msg.correlationId && pending?.requestId && msg.correlationId !== pending.requestId) {
      console.warn('[jobber] stale meeting response ignored (correlationId mismatch)', msg);
      return;
    }
    if (msg.type === 'meeting_accept') {
      state.pendingMeetings[ns].set(msg.sender, { status: 'accepted', when: msg.payload.when });
      toast('Meeting accepted');
    } else {
      state.pendingMeetings[ns].delete(msg.sender);
      toast('Meeting declined');
    }
    state.render.workspace();
  } else if (msg.type === 'document_request') {
    state.pendingDocs[ns].set(msg.sender, { status: 'incoming', doc: msg.payload.doc, requestId: msg.messageId });
    toast(`${msg.sender.slice(0, 6)}… requested your ${msg.payload.doc.replace('_', ' ')}`);
    state.render.workspace();
  } else if (msg.type === 'document_offer') {
    const pending = state.pendingDocs[ns].get(msg.sender);
    if (msg.correlationId && pending?.requestId && msg.correlationId !== pending.requestId) {
      console.warn('[jobber] stale document offer ignored (correlationId mismatch)', msg);
      return;
    }
    state.pendingDocs[ns].set(msg.sender, { status: 'received', doc: msg.payload.doc, text: msg.payload.text });
    toast(`Received ${msg.payload.doc.replace('_', ' ')}`);
    state.render.workspace();
  } else if (msg.type === 'attachment_offer') {
    state.pendingAttachmentOffers[ns].set(msg.payload.offerId, {
      status: 'incoming', name: msg.payload.name, size: msg.payload.size, type: msg.payload.type, theirIdentityId: msg.sender,
    });
    toast(`${msg.sender.slice(0, 6)}… wants to send you a file: ${msg.payload.name}`);
    state.render.workspace();
  } else if (msg.type === 'attachment_accept') {
    const offer = state.pendingAttachmentOffers[ns].get(msg.payload.offerId);
    if (offer && offer.status === 'outgoing' && offer.file) {
      const targetPeerId = state.identityToPeer[ns].get(offer.theirIdentityId);
      if (targetPeerId) {
        // offerId is already known to both sides from the handshake, so it
        // doubles as the canonical messageId for the resulting chat entry
        // on both ends — same reasoning as chat_message's messageId.
        p2p.getRoom(ns).sendBlob(offer.file, targetPeerId, { name: offer.name, size: offer.size, type: offer.type, offerId: msg.payload.offerId });
        const entry = { messageId: msg.payload.offerId, from: 'me', kind: 'attachment', ts: Date.now(), name: offer.name, size: offer.size, url: URL.createObjectURL(offer.file), delivered: true };
        if (!state.chatLog[ns].has(offer.theirIdentityId)) state.chatLog[ns].set(offer.theirIdentityId, []);
        state.chatLog[ns].get(offer.theirIdentityId).push(entry);
        state.loadedConversations[ns].add(offer.theirIdentityId);
        persistMessage(ns, offer.theirIdentityId, { ...entry, url: undefined, blob: offer.file });
        toast(`${offer.name} accepted — sending now.`);
      }
    }
    state.pendingAttachmentOffers[ns].delete(msg.payload.offerId);
    state.render.workspace();
  } else if (msg.type === 'attachment_decline') {
    state.pendingAttachmentOffers[ns].delete(msg.payload.offerId);
    toast('Attachment declined.');
    state.render.workspace();
  } else if (msg.type === 'chat_request') {
    state.pendingChats[ns].set(msg.sender, { status: 'incoming', requestId: msg.messageId });
    toast(`Chat request from ${msg.sender.slice(0, 6)}…`);
    state.render.workspace();
  } else if (msg.type === 'chat_accept' || msg.type === 'chat_decline') {
    const pending = state.pendingChats[ns].get(msg.sender);
    if (msg.correlationId && pending?.requestId && msg.correlationId !== pending.requestId) {
      console.warn('[jobber] stale chat response ignored (correlationId mismatch)', msg);
      return;
    }
    if (msg.type === 'chat_accept') {
      state.pendingChats[ns].set(msg.sender, { status: 'accepted' });
      loadConversation(ns, msg.sender).then(() => {
        state.openChatWith[ns] = msg.sender;
        state.render.workspace();
      });
    } else {
      state.pendingChats[ns].delete(msg.sender);
      toast('Chat request declined');
      state.render.workspace();
    }
  } else if (msg.type === 'chat_message') {
    if (!state.chatLog[ns].has(msg.sender)) state.chatLog[ns].set(msg.sender, []);
    // Reuse the sender's canonical messageId (from the payload, not our own
    // random one) so both sides store the same id for the same logical
    // message — see conversations.js's sendChatMessage for why this matters.
    const entry = { messageId: msg.payload.messageId, from: 'them', text: msg.payload.text, ts: msg.timestamp };
    state.chatLog[ns].get(msg.sender).push(entry);
    state.loadedConversations[ns].add(msg.sender); // avoid re-fetching and duplicating on next open
    persistMessage(ns, msg.sender, entry);
    state.render.workspace();
  } else if (msg.type === 'identity_retired') {
    toast(`Peer identity retired: #${msg.payload.retiredId} → #${msg.payload.rotatedTo}`);
  } else if (msg.type === 'research_sync_request') {
    handleResearchSyncRequest(ns, msg, peerId);
  } else if (msg.type === 'research_sync_response') {
    handleResearchSyncResponse(msg);
  } else if (msg.type === 'research_join_request') {
    handleResearchJoinRequest(msg, peerId);
  } else if (msg.type === 'research_join_accept') {
    handleResearchJoinAccept(msg);
  } else if (msg.type === 'research_join_decline') {
    handleResearchJoinDecline(msg);
  } else if (msg.type === 'research_project_update') {
    handleResearchProjectUpdate(msg);
  } else if (msg.type === 'research_project_announce') {
    handleResearchProjectAnnounce(msg, peerId);
  } else if (msg.type === 'research_artifact') {
    research.mergeArtifact(msg.payload.artifact).then(() => {
      if (msg.payload.artifact.projectId === state.activeProjectId) state.render.workspace();
    });
  } else if (msg.type === 'conversation_sync_request') {
    handleConversationSyncRequest(ns, msg, peerId);
  } else if (msg.type === 'conversation_sync_response') {
    handleConversationSyncResponse(ns, msg);
  }
}

state.handlers.incomingMessage = handleIncomingMessage;
