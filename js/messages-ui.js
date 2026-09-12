// messages-ui.js — the centralized inbox: every pending request (chat,
// meeting, document, attachment) and every ongoing conversation, across
// every mode, in one place. Messages has no identity of its own — like
// Near and Agent, it just reads state your other identities already
// accumulated (see state.js's header for why cross-cutting tools reach
// into per-namespace state directly instead of duplicating it).
//
// Deliberately doesn't reimplement the chat panel itself: "Open" on a
// conversation jumps you into that namespace's own workspace, where
// discovery-ui.js's existing chat UI (and all its handling of
// offline-queueing, attachments, resync, …) already works. Centralizing
// here is about *finding* the conversation, not re-rendering it twice.

import { state, NAMESPACES, NS_CONFIG, setActiveNamespace } from './state.js';
import {
  respondChat, respondMeeting, shareDocument, declineDocument, respondAttachmentOffer,
  listConversations, loadConversation,
} from './conversations.js';

// Only namespaces where the generic chat/meeting/document/attachment
// mechanic in conversations.js actually applies — Research has its own
// separate collaboration model, and Near/Agent/Messages/external kinds
// have no identities to hold a conversation in the first place.
function chatCapableNamespaces() {
  return NAMESPACES.filter((ns) => NS_CONFIG[ns].kind === 'twoSided' || NS_CONFIG[ns].kind === 'reciprocal');
}

function findIdentity(ns, identityId) {
  return state.identitiesByNs[ns]?.find((i) => i.identityId === identityId) || null;
}

// Every active identity in a namespace can have its own pending requests
// and conversations now, independent of which one happens to be "active"
// (viewed) or live — so this loops all of them, not just one.
function myIdentitiesOf(ns) {
  return (state.identitiesByNs[ns] || []).filter((i) => i.active);
}

// Synchronous and cheap (no IndexedDB reads) — safe to call from the
// Bureau's tile render on every re-render, unlike the conversation list.
export function gatherPending() {
  const items = [];
  for (const ns of chatCapableNamespaces()) {
    for (const my of myIdentitiesOf(ns)) {
      const myId = my.identityId;
      for (const [theirId, c] of state.pendingChats[ns]?.get(myId) || []) {
        if (c.status === 'incoming') items.push({ ns, myId, theirId, type: 'chat', label: 'wants to start a conversation' });
      }
      for (const [theirId, m] of state.pendingMeetings[ns]?.get(myId) || []) {
        if (m.status === 'incoming') items.push({ ns, myId, theirId, type: 'meeting', label: `proposed a meeting: ${m.when}${m.note ? ' — ' + m.note : ''}` });
      }
      for (const [theirId, d] of state.pendingDocs[ns]?.get(myId) || []) {
        if (d.status === 'incoming') items.push({ ns, myId, theirId, type: 'document', doc: d.doc, label: `requested your ${d.doc.replace('_', ' ')}` });
      }
      for (const [offerId, a] of state.pendingAttachmentOffers[ns]?.get(myId) || []) {
        if (a.status === 'incoming') items.push({ ns, myId, theirId: a.theirIdentityId, offerId, type: 'attachment', label: `wants to send you a file: ${a.name}` });
      }
    }
  }
  return items;
}

export function countPendingNotifications() {
  return gatherPending().length;
}

async function gatherConversations() {
  const all = [];
  for (const ns of chatCapableNamespaces()) {
    for (const my of myIdentitiesOf(ns)) {
      for (const c of await listConversations(ns, my.identityId)) all.push({ ...c, ns, myId: my.identityId });
    }
  }
  return all.sort((a, b) => b.ts - a.ts);
}

// "as <name>" only actually adds information once there's more than one
// identity it could be — most namespaces still have exactly one, where
// it'd just be noise repeating what the mode badge already says.
function asIdentitySuffix(ns, myId) {
  return myIdentitiesOf(ns).length > 1 ? ` (as ${findIdentity(ns, myId)?.displayName || myId.slice(0, 8)})` : '';
}

function pendingRowHtml(p) {
  const acceptLabel = p.type === 'document' ? 'Share' : 'Accept';
  return `
    <div class="agree-row">
      <span class="k2">
        <span class="role-badge" style="margin-right:6px">${NS_CONFIG[p.ns].label}${asIdentitySuffix(p.ns, p.myId)}</span>
        ${p.theirId.slice(0, 10)}… ${p.label}
      </span>
      <span style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn small primary msg-accept" data-ns="${p.ns}" data-my="${p.myId}" data-their="${p.theirId}" data-type="${p.type}" data-doc="${p.doc || ''}" data-offer="${p.offerId || ''}">${acceptLabel}</button>
        <button class="btn small ghost msg-decline" data-ns="${p.ns}" data-my="${p.myId}" data-their="${p.theirId}" data-type="${p.type}" data-offer="${p.offerId || ''}">Decline</button>
      </span>
    </div>`;
}

function conversationRowHtml(c) {
  const online = state.identityToPeer[c.ns]?.has(c.counterpart);
  const preview = c.kind === 'attachment' ? `📎 ${c.name}` : (c.text || '').slice(0, 60);
  return `
    <div class="agree-row">
      <span class="k2">
        <span class="online-dot ${online ? 'on' : ''}" style="margin-right:6px"></span>
        <span class="role-badge" style="margin-right:6px">${NS_CONFIG[c.ns].label}${asIdentitySuffix(c.ns, c.myId)}</span>
        ${c.counterpart.slice(0, 10)}… — ${preview}
      </span>
      <button class="btn small ghost conv-jump" data-ns="${c.ns}" data-my="${c.myId}" data-their="${c.counterpart}">Open</button>
    </div>`;
}

export async function renderMessagesWorkspace() {
  const pending = gatherPending();
  const conversations = await gatherConversations();

  if (!pending.length && !conversations.length) {
    return `
      <div class="empty-state" style="max-width:560px;margin:40px auto;text-align:left">
        <h2 class="section-title" style="margin-bottom:6px">Messages</h2>
        <p class="section-sub">${NS_CONFIG.messages.hint}</p>
        <p class="section-sub" style="margin-top:10px">Nothing yet — start or accept a conversation in any Match mode and it'll show up here.</p>
      </div>`;
  }

  return `
    <h2 class="section-title">Messages</h2>
    <p class="section-sub">${NS_CONFIG.messages.hint}</p>
    ${pending.length ? `<div class="panel" style="margin-top:14px"><div class="k">Needs your response</div>${pending.map(pendingRowHtml).join('')}</div>` : ''}
    ${conversations.length ? `<div class="panel" style="margin-top:14px"><div class="k">Conversations</div>${conversations.map(conversationRowHtml).join('')}</div>` : ''}
  `;
}

export function bindMessagesEvents() {
  const ws = document.getElementById('workspace');

  ws.querySelectorAll('.msg-accept').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { ns, my, their, type, doc, offer } = btn.dataset;
      const id = findIdentity(ns, my);
      if (type === 'chat') {
        respondChat(ns, id, their, true);
        // Accepting is clearly meant to lead into the conversation, not
        // just clear the notification — jump straight into it, viewing it
        // as whichever of my identities actually received the request.
        setActiveNamespace(ns);
        state.activeIdentityId[ns] = my;
        state.view = 'workspace';
        state.render.all();
      } else if (type === 'meeting') {
        respondMeeting(ns, id, their, true);
      } else if (type === 'document') {
        shareDocument(ns, id, their, doc);
      } else if (type === 'attachment') {
        respondAttachmentOffer(ns, id, offer, true);
      }
    });
  });

  ws.querySelectorAll('.msg-decline').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { ns, my, their, type, offer } = btn.dataset;
      const id = findIdentity(ns, my);
      if (type === 'chat') respondChat(ns, id, their, false);
      else if (type === 'meeting') respondMeeting(ns, id, their, false);
      else if (type === 'document') declineDocument(ns, my, their);
      else if (type === 'attachment') respondAttachmentOffer(ns, id, offer, false);
    });
  });

  ws.querySelectorAll('.conv-jump').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { ns, my, their } = btn.dataset;
      setActiveNamespace(ns);
      state.activeIdentityId[ns] = my;
      state.openChatWith[ns].set(my, their);
      state.view = 'workspace';
      loadConversation(ns, my, their).then(() => state.render.all());
    });
  });
}
