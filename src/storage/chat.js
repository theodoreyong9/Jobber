// src/storage/chat.js
//
// L'historique du chat est conservé UNIQUEMENT en local (§42, §74). Aucun
// serveur applicatif n'est impliqué. L'utilisateur peut tout supprimer à
// tout moment (§54).

import { STORES, put, get, getAll, del } from './idb.js';

/**
 * @typedef {{ peerId: string, matchSummary: any, createdAt: number, active: boolean }} ChatThread
 */

export function saveThread(thread) {
  return put(STORES.CHAT_THREADS, thread);
}

export function getThread(peerId) {
  return get(STORES.CHAT_THREADS, peerId);
}

export function listThreads() {
  return getAll(STORES.CHAT_THREADS);
}

/** @param {{ id: string, peerId: string, senderId: string, timestamp: number, text: string }} message */
export function saveMessage(message) {
  return put(STORES.CHAT_MESSAGES, message);
}

export function listMessagesForPeer(peerId) {
  return getAll(STORES.CHAT_MESSAGES, 'byPeer', peerId);
}

/** Supprime un fil de discussion et tous ses messages (§54). */
export async function deleteThread(peerId) {
  const messages = await listMessagesForPeer(peerId);
  await Promise.all(messages.map((m) => del(STORES.CHAT_MESSAGES, m.id)));
  await del(STORES.CHAT_THREADS, peerId);
}
