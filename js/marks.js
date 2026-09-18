// marks.js — two small, generic per-item flags reused across every
// search result list (Near, every namespace's own discovery results)
// and Messages' conversation list: "seen" (a plain tick — "I've
// already looked at this, stop drawing my eye to it") and "favorite"
// (a star, conversations only). Both persist in db.js's existing
// 'cache' key-value store — a boolean per compound key, the same shape
// 'cache' already holds for e.g. searchLive — rather than a new
// IndexedDB store or version bump.
//
// Scoped by (namespace, subject identity) for "seen" — the same scope
// credibility.js already scores by, since two people can show up under
// the same identityId in different namespaces (an AIWA seeker and a
// Business offer are different relationships, so "seen" on one
// shouldn't dim the other). "Favorite" is scoped one level deeper, by
// (namespace, my identity, their identity) — a conversation, not just
// a person, since the same counterpart could in principle be reached
// through more than one of my own identities.

import * as db from './db.js';

function seenKey(ns, subjectId) {
  return `seen:${ns}:${subjectId}`;
}
function favoriteKey(ns, myId, theirId) {
  return `favorite:${ns}:${myId}:${theirId}`;
}

export async function isSeen(ns, subjectId) {
  const row = await db.get('cache', seenKey(ns, subjectId));
  return !!row?.value;
}
export async function setSeen(ns, subjectId, value) {
  await db.put('cache', { key: seenKey(ns, subjectId), value });
}

export async function isFavorite(ns, myId, theirId) {
  const row = await db.get('cache', favoriteKey(ns, myId, theirId));
  return !!row?.value;
}
export async function setFavorite(ns, myId, theirId, value) {
  await db.put('cache', { key: favoriteKey(ns, myId, theirId), value });
}

// seenTickHtml/bindSeenToggles: the same tick control and its click
// behavior, reused verbatim by near-ui.js and discovery-ui.js rather
// than each hand-rolling its own. Toggling flips the button and its
// own card's dimmed state directly, without a full re-render — a
// "seen" flag never changes what else is on screen, how results are
// ordered, or any other card, so nothing else needs refreshing.
export function seenTickHtml(ns, subjectId, seen) {
  return `<button type="button" class="seen-tick ${seen ? 'on' : ''}" data-seen-ns="${ns}" data-seen-id="${subjectId}" title="${seen ? 'Seen — click to unmark' : 'Mark as seen'}">✓</button>`;
}

export function bindSeenToggles(root) {
  root.querySelectorAll('.seen-tick').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { seenNs, seenId } = btn.dataset;
      const next = !btn.classList.contains('on');
      await setSeen(seenNs, seenId, next);
      btn.classList.toggle('on', next);
      btn.title = next ? 'Seen — click to unmark' : 'Mark as seen';
      btn.closest('.card')?.classList.toggle('seen', next);
    });
  });
}
