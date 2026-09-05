// src/p2p/trystero.js
//
// Établit les connexions directes navigateur-à-navigateur via Trystero et
// transporte le matching + le chat (§10, §39).
//
// IMPORTANT — API Trystero actuelle (vérifiée dans leur documentation,
// https://github.com/dmotz/trystero, après un bug en prod) :
//   - `room.makeAction(id)` renvoie un OBJET `{ send, onMessage, ... }`,
//     PAS un tableau `[send, receive]` comme dans les très anciennes
//     versions. Déstructurer le résultat en tableau plante avec
//     "object is not iterable" — c'était le bug qui empêchait toute
//     connexion.
//   - `room.onPeerJoin` / `room.onPeerLeave` sont des PROPRIÉTÉS à
//     assigner (`room.onPeerJoin = fn`), pas des méthodes à appeler.
//   - `action.send(data, { target: peerId })` — le ciblage se fait via un
//     objet d'options, pas un second argument positionnel.
//
// Deux actions distinctes :
//   'jm_msg' : messages JSON typés (protocol.js), validés systématiquement
//   'jm_cv'  : octets bruts du CV d'un candidat, envoyés en pièce jointe

import { validateIncomingMessage } from '../core/validation/schema.js';
import { limitForType } from './protocol.js';
import { PAYLOAD_LIMITS } from '../config/matching.js';

/**
 * Rejoint une "room" Trystero partagée par tous (candidats + recruteurs).
 * Config minimale : `appId`. `relayConfig.urls` peut fixer une liste de
 * relais Nostr précise (plus fiable que la liste par défaut de Trystero,
 * dont certains relais publics peuvent être temporairement indisponibles).
 * @param {{ joinRoom: (config: any, roomId: string) => any }} trysteroLib
 * @param {{ appId: string, relayConfig?: { urls: string[] } }} config
 * @param {string} roomId
 */
export function joinMatchingRoom(trysteroLib, config, roomId) {
  const room = trysteroLib.joinRoom(config, roomId);

  const msgAction = room.makeAction('jm_msg');
  const fileAction = room.makeAction('jm_cv');

  /** @type {Set<(msg: any, peerId: string) => void>} */
  const messageListeners = new Set();
  /** @type {Set<(blob: Blob, meta: any, peerId: string) => void>} */
  const fileListeners = new Set();

  msgAction.onMessage = (data, { peerId }) => {
    // Toute donnée reçue d'un pair est non fiable par défaut (§55).
    const limit = limitForType(data?.type) ?? 16 * 1024;
    const validation = validateIncomingMessage(data, limit);
    if (!validation.ok) {
      // On journalise localement sans jamais logguer le contenu intégral (§76).
      console.warn('[trystero] message rejeté', peerId, validation.errors);
      return;
    }
    messageListeners.forEach((fn) => fn(validation.value, peerId));
  };

  fileAction.onMessage = (data, { peerId, metadata }) => {
    if (!(data instanceof Blob) && !(data instanceof ArrayBuffer)) return;
    const size = data instanceof Blob ? data.size : data.byteLength;
    if (size > PAYLOAD_LIMITS.maxDocumentBytes) {
      console.warn('[trystero] fichier rejeté (trop volumineux)', peerId, size);
      return;
    }
    const blob = data instanceof Blob ? data : new Blob([data]);
    fileListeners.forEach((fn) => fn(blob, metadata, peerId));
  };

  return {
    room,
    /** Envoie un message typé (déjà construit via p2p/protocol.js) à tous les pairs ou un pair ciblé. */
    send(message, targetPeerId) {
      msgAction.send(message, targetPeerId ? { target: targetPeerId } : undefined);
    },
    onMessage(fn) {
      messageListeners.add(fn);
      return () => messageListeners.delete(fn);
    },
    /**
     * Envoie le fichier CV en pièce jointe. `meta` (nom, type mime) voyage
     * avec Trystero indépendamment du contenu binaire.
     * @param {Blob} blob
     * @param {{ name: string, mimeType?: string }} meta
     * @param {string} [targetPeerId]
     */
    sendFile(blob, meta, targetPeerId) {
      fileAction.send(blob, { metadata: meta, ...(targetPeerId ? { target: targetPeerId } : {}) });
    },
    onFile(fn) {
      fileListeners.add(fn);
      return () => fileListeners.delete(fn);
    },
    onPeerJoin(fn) { room.onPeerJoin = fn; },
    onPeerLeave(fn) { room.onPeerLeave = fn; },
    leave() { room.leave(); },
  };
}
