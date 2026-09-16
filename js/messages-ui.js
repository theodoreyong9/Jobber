// messages-ui.js — the centralized inbox: every pending request (chat,
// meeting, attachment — document requests auto-fulfill now, see
// conversations.js's shareDocument, so they never sit here waiting on a
// response) and every ongoing conversation, across every mode, in one
// place. Messages has no identity of its own — like Near and Agent, it
// just reads state your other identities already accumulated (see
// state.js's header for why cross-cutting tools reach into per-namespace
// state directly instead of duplicating it).
//
// Reimplements the chat panel inline (via conversations.js's own
// renderChatPanel/sendChatMessage/proposeAttachment — the exact same
// functions discovery-ui.js's per-namespace workspace uses) instead of
// jumping you into that namespace's own workspace: the whole point of a
// centralized inbox is not needing to go find the conversation somewhere
// else. See state.js's messagesOpenConversation for the one piece of
// state that makes this possible without duplicating openChatWith.
//
// Notifications: countPendingNotifications() (the Bureau tile's badge
// number) covers both incoming requests and unread messages in already
// -accepted conversations — see state.js's unreadMessages for how the
// latter gets tracked, message-router.js's chat_message handling for where
// it increments, and conversations.js's loadConversation for where it
// clears once a conversation is actually opened.

import { state, NAMESPACES, NS_CONFIG } from './state.js';
import {
  respondChat, respondMeeting, respondAttachmentOffer,
  listConversations, loadConversation, renderChatPanel, sendChatMessage, proposeAttachment,
  closeConversation, renderDocumentButtonsHtml, bindDocumentButtons,
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
      for (const [offerId, a] of state.pendingAttachmentOffers[ns]?.get(myId) || []) {
        if (a.status === 'incoming') items.push({ ns, myId, theirId: a.theirIdentityId, offerId, type: 'attachment', label: `wants to send you a file: ${a.name}` });
      }
    }
  }
  return items;
}

function unreadCountFor(ns, myId, theirId) {
  return state.unreadMessages[ns]?.get(myId)?.get(theirId) || 0;
}

function totalUnreadCount() {
  let total = 0;
  for (const ns of chatCapableNamespaces()) {
    for (const my of myIdentitiesOf(ns)) {
      for (const count of state.unreadMessages[ns]?.get(my.identityId)?.values() || []) total += count;
    }
  }
  return total;
}

// Requests waiting on a yes/no plus unread messages in already-accepted
// conversations — both are "something in Messages needs your attention",
// so both count toward the one badge the Bureau's Messages tile shows.
export function countPendingNotifications() {
  return gatherPending().length + totalUnreadCount();
}

async function gatherConversations() {
  const all = [];
  for (const ns of chatCapableNamespaces()) {
    for (const my of myIdentitiesOf(ns)) {
      for (const c of await listConversations(ns, my.identityId)) all.push({ ...c, ns, myId: my.identityId });
    }
  }
  // Unread conversations float to the top as a group (most recent unread
  // first), read ones follow by recency — same "what needs me" priority a
  // real inbox uses, rather than a flat timestamp sort that could bury a
  // new message under yesterday's already-read chatter.
  return all.sort((a, b) => {
    const bUnread = unreadCountFor(b.ns, b.myId, b.counterpart) > 0 ? 1 : 0;
    const aUnread = unreadCountFor(a.ns, a.myId, a.counterpart) > 0 ? 1 : 0;
    return bUnread - aUnread || b.ts - a.ts;
  });
}

// "as <name>" only actually adds information once there's more than one
// identity it could be — most namespaces still have exactly one, where
// it'd just be noise repeating what the mode badge already says.
function asIdentitySuffix(ns, myId) {
  return myIdentitiesOf(ns).length > 1 ? ` (as ${findIdentity(ns, myId)?.displayName || myId.slice(0, 8)})` : '';
}

function pendingRowHtml(p) {
  return `
    <div class="agree-row">
      <span class="k2">
        <span class="role-badge" style="margin-right:6px">${NS_CONFIG[p.ns].label}${asIdentitySuffix(p.ns, p.myId)}</span>
        ${p.theirId.slice(0, 10)}… ${p.label}
      </span>
      <span style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn small primary msg-accept" data-ns="${p.ns}" data-my="${p.myId}" data-their="${p.theirId}" data-type="${p.type}" data-offer="${p.offerId || ''}">Accept</button>
        <button class="btn small ghost msg-decline" data-ns="${p.ns}" data-my="${p.myId}" data-their="${p.theirId}" data-type="${p.type}" data-offer="${p.offerId || ''}">Decline</button>
      </span>
    </div>`;
}

function conversationRowHtml(c) {
  const online = state.identityToPeer[c.ns]?.has(c.counterpart);
  const unread = unreadCountFor(c.ns, c.myId, c.counterpart);
  const preview = c.kind === 'attachment' ? `📎 ${c.name}` : (c.text || '').slice(0, 60);
  return `
    <div class="agree-row">
      <span class="k2">
        <span class="online-dot ${online ? 'on' : ''}" style="margin-right:6px"></span>
        <span class="role-badge" style="margin-right:6px">${NS_CONFIG[c.ns].label}${asIdentitySuffix(c.ns, c.myId)}</span>
        ${c.counterpart.slice(0, 10)}… — ${preview}
        ${unread ? `<span class="unread-badge">${unread > 9 ? '9+' : unread}</span>` : ''}
      </span>
      <button class="btn small ghost conv-jump" data-ns="${c.ns}" data-my="${c.myId}" data-their="${c.counterpart}">Open</button>
    </div>`;
}

// The counterpart's own "profile content" — everything about them we've
// actually learned, without leaving Messages to go look at their card in
// the namespace's own workspace. Discovery broadcast fields cover the
// general case (name, category, location, whatever text they've chosen to
// share publicly); Employment's CV/cover letter buttons (see
// conversations.js's renderDocumentButtonsHtml) are the one namespace with
// content that's gated behind chat acceptance rather than broadcast openly.
function counterpartProfileHtml(ns, myIdentityId, myRole, theirIdentityId) {
  const meta = [...(state.discovered[ns]?.values() || [])].find((p) => p.sender === theirIdentityId);
  const location = meta ? [meta.city, meta.country].filter(Boolean).join(', ') : '';
  const docsHtml = renderDocumentButtonsHtml(ns, myIdentityId, myRole, theirIdentityId);
  if (!meta && !docsHtml) return '';
  return `
    <div class="panel" style="margin-bottom:12px">
      <div class="k">${NS_CONFIG[ns].label} profile</div>
      ${meta ? `
        <div style="font-weight:600;margin-top:4px">${meta.displayName || theirIdentityId.slice(0, 10) + '…'}</div>
        <div style="font-size:12.5px;color:var(--mid)">${meta.category || 'No category declared'}${location ? ' — ' + location : ''}</div>
        ${meta.postingText ? `<div style="font-size:12px;color:var(--mid);white-space:pre-wrap;margin-top:8px">${meta.postingText}</div>` : ''}
      ` : ''}
      ${docsHtml ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:${meta ? '10px' : '4px'}">${docsHtml}</div>` : ''}
    </div>`;
}

export async function renderMessagesWorkspace() {
  const focus = state.messagesOpenConversation;
  if (focus) {
    const id = findIdentity(focus.ns, focus.myId);
    if (id) {
      await loadConversation(focus.ns, focus.myId, focus.theirId);
      state.openChatWith[focus.ns].set(focus.myId, focus.theirId);
      return `
        <h2 class="section-title">Messages</h2>
        <button class="btn small ghost" id="messagesBack" style="margin:10px 0">← Back to Messages</button>
        ${counterpartProfileHtml(focus.ns, focus.myId, id.role, focus.theirId)}
        ${renderChatPanel(focus.ns, id, focus.theirId)}
      `;
    }
    state.messagesOpenConversation = null; // stale (identity retired/deleted since) — fall through to the list
  }

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
      const { ns, my, their, type, offer } = btn.dataset;
      const id = findIdentity(ns, my);
      if (type === 'chat') {
        respondChat(ns, id, their, true);
        // Accepting is clearly meant to lead into the conversation, not
        // just clear the notification — focus it right here, no navigating
        // away to the namespace's own workspace.
        state.messagesOpenConversation = { ns, myId: my, theirId: their };
      } else if (type === 'meeting') {
        respondMeeting(ns, id, their, true);
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
      else if (type === 'attachment') respondAttachmentOffer(ns, id, offer, false);
    });
  });

  ws.querySelectorAll('.conv-jump').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { ns, my, their } = btn.dataset;
      state.messagesOpenConversation = { ns, myId: my, theirId: their };
      state.render.workspace();
    });
  });

  if (!state.messagesOpenConversation) return;
  const { ns, myId, theirId } = state.messagesOpenConversation;
  const id = findIdentity(ns, myId);
  if (!id) return;

  ws.querySelector('#messagesBack')?.addEventListener('click', () => {
    state.messagesOpenConversation = null;
    state.render.workspace();
  });
  // Distinct from "Close conversation" below: this just leaves the embedded
  // panel and returns to the inbox list — the conversation itself stays
  // accepted, same as discovery-ui.js's own #closeChat within its workspace.
  ws.querySelector('#closeChat')?.addEventListener('click', () => {
    state.messagesOpenConversation = null;
    state.render.workspace();
  });
  ws.querySelector('.close-conversation')?.addEventListener('click', () => {
    state.messagesOpenConversation = null;
    closeConversation(ns, id, theirId);
  });
  bindDocumentButtons(ns, myId);
  ws.querySelectorAll('.attach-accept').forEach((btn) => {
    btn.addEventListener('click', () => respondAttachmentOffer(ns, id, btn.dataset.offer, true));
  });
  ws.querySelectorAll('.attach-decline').forEach((btn) => {
    btn.addEventListener('click', () => respondAttachmentOffer(ns, id, btn.dataset.offer, false));
  });

  const sendBtn = ws.querySelector('#chatSend');
  if (sendBtn) {
    const input = ws.querySelector('#chatInput');
    const fire = () => { sendChatMessage(ns, id, theirId, input.value); input.value = ''; };
    sendBtn.addEventListener('click', fire);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });
    ws.querySelector('#chatFile')?.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) proposeAttachment(ns, id, theirId, f);
    });
    const log = ws.querySelector('#chatLog');
    if (log) log.scrollTop = log.scrollHeight;
  }
}
