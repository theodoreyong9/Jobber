// src/p2p/trystero.js
//
// Établit les connexions directes navigateur-à-navigateur via Trystero et
// transporte le matching + le chat (§10, §39). La lib est injectée pour
// rester testable ; en prod, on utilise la stratégie `trystero/nostr`
// (Trystero s'appuie alors sur des relais Nostr pour la signalisation
// WebRTC — cohérent avec §9, sans qu'on ait à gérer nous-mêmes des
// événements Nostr applicatifs).
//
// Deux canaux distincts :
//   'jm_msg' : messages JSON typés (protocol.js), validés systématiquement
//   'jm_cv'  : octets bruts du CV d'un candidat, envoyés en pièce jointe
//              (jamais interprétés comme instruction, jamais parsés côté
//              émetteur — un simple transport de fichier, §11 assumé car
//              c'est ICI un choix produit explicite : le CV accompagne la
//              diffusion candidat pour que le recruteur puisse le consulter)

import { validateIncomingMessage } from '../core/validation/schema.js';
import { limitForType } from './protocol.js';
import { PAYLOAD_LIMITS } from '../config/matching.js';

/**
 * Rejoint une "room" Trystero partagée par tous (candidats + recruteurs).
 * Config minimale volontairement : `appId` seul. Ne pas essayer de forcer
 * un `selfId` personnalisé — les stratégies de signalisation de Trystero
 * (dont `trystero/nostr`) ont des attentes internes sur ce format qu'un ID
 * applicatif générique ne respecte pas forcément, et une valeur invalide
 * fait planter la connexion plutôt que d'être simplement ignorée. La
 * reconnaissance d'une même personne d'une connexion à l'autre se fait au
 * niveau applicatif (voir p2p/discovery.js), pas au niveau du transport.
 * @param {{ joinRoom: (config: any, roomId: string) => any }} trysteroLib
 * @param {{ appId: string }} config
 * @param {string} roomId
 */
export function joinMatchingRoom(trysteroLib, config, roomId) {
  const room = trysteroLib.joinRoom(config, roomId);

  const [sendRaw, getRaw] = room.makeAction('jm_msg');
  const [sendFileRaw, getFileRaw] = room.makeAction('jm_cv');

  /** @type {Set<(msg: any, peerId: string) => void>} */
  const messageListeners = new Set();
  /** @type {Set<(blob: Blob, meta: any, peerId: string) => void>} */
  const fileListeners = new Set();

  getRaw((data, peerId) => {
    // Toute donnée reçue d'un pair est non fiable par défaut (§55).
    const limit = limitForType(data?.type) ?? 16 * 1024;
    const validation = validateIncomingMessage(data, limit);
    if (!validation.ok) {
      // On journalise localement sans jamais logguer le contenu intégral (§76).
      console.warn('[trystero] message rejeté', peerId, validation.errors);
      return;
    }
    messageListeners.forEach((fn) => fn(validation.value, peerId));
  });

  getFileRaw((data, peerId, meta) => {
    if (!(data instanceof Blob) && !(data instanceof ArrayBuffer)) return;
    const size = data instanceof Blob ? data.size : data.byteLength;
    if (size > PAYLOAD_LIMITS.maxDocumentBytes) {
      console.warn('[trystero] fichier rejeté (trop volumineux)', peerId, size);
      return;
    }
    const blob = data instanceof Blob ? data : new Blob([data]);
    fileListeners.forEach((fn) => fn(blob, meta, peerId));
  });

  return {
    room,
    /** Envoie un message typé (déjà construit via p2p/protocol.js) à tous les pairs ou un pair ciblé. */
    send(message, targetPeerId) {
      sendRaw(message, targetPeerId);
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
      sendFileRaw(blob, targetPeerId, meta);
    },
    onFile(fn) {
      fileListeners.add(fn);
      return () => fileListeners.delete(fn);
    },
    onPeerJoin(fn) { room.onPeerJoin(fn); },
    onPeerLeave(fn) { room.onPeerLeave(fn); },
    leave() { room.leave(); },
  };
}
