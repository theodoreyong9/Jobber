// src/p2p/nostr.js
//
// Nostr sert UNIQUEMENT à la découverte / signalisation / présence (§9).
// Il ne doit jamais devenir un stockage de CV complets. La lib réelle
// (ex: nostr-tools) est injectée pour rester testable sans réseau.
//
// Ce module reste volontairement mince : construire des événements, les
// publier via un relai, et écouter les profils/annonces d'autres pairs.

import { validatePeerProfile } from '../core/validation/schema.js';

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

// Kind d'événement éphémère/replaceable dédié à la présence de matching.
// 30078 = "Application-specific data" (NIP-78), choisi pour ne pas polluer
// le fil social classique d'un utilisateur.
const PROFILE_EVENT_KIND = 30078;
const APP_TAG = 'jobmatch-p2p-v1';

/**
 * @typedef {Object} NostrIdentity
 * @property {string} publicKey
 * @property {Uint8Array} privateKey  // ne quitte jamais le navigateur (§12)
 */

/**
 * Crée une identité locale via la lib nostr injectée. La clé privée reste en
 * mémoire / IndexedDB local, jamais envoyée à un serveur.
 * @param {{ generateSecretKey: () => Uint8Array, getPublicKey: (sk: Uint8Array) => string }} nostrLib
 * @returns {NostrIdentity}
 */
export function createLocalIdentity(nostrLib) {
  const privateKey = nostrLib.generateSecretKey();
  const publicKey = nostrLib.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Construit (sans publier) l'événement d'annonce de profil minimal.
 * Refuse de construire l'événement si le profil contient un champ interdit
 * (texte intégral de document) — défense en profondeur (§11, §51, §86).
 * @param {import('../core/validation/schema.js').PeerProfile} profile
 */
export function buildProfileEvent(profile) {
  const validation = validatePeerProfile(profile);
  if (!validation.ok) {
    throw new Error(`Profil réseau invalide, publication refusée : ${validation.errors.join(', ')}`);
  }
  return {
    kind: PROFILE_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `${APP_TAG}:${profile.role}`], // remplaçable : une seule annonce active par rôle
      ['t', APP_TAG],
    ],
    content: JSON.stringify(profile),
  };
}

/**
 * Se connecte aux relais et s'abonne aux annonces de profils de l'app.
 * @param {{ SimplePool: any }} nostrLib
 * @param {(profile: any, event: any) => void} onProfile
 * @param {string[]} [relays]
 */
export function subscribeToDiscovery(nostrLib, onProfile, relays = DEFAULT_RELAYS) {
  const pool = new nostrLib.SimplePool();
  const sub = pool.subscribeMany(relays, [{ kinds: [PROFILE_EVENT_KIND], '#t': [APP_TAG] }], {
    onevent(event) {
      let parsed;
      try {
        parsed = JSON.parse(event.content);
      } catch {
        return; // contenu malformé : ignoré silencieusement (§55)
      }
      const validation = validatePeerProfile(parsed);
      if (!validation.ok) return; // profil invalide/suspect : ignoré (§86)
      onProfile(validation.value, event);
    },
  });
  return {
    pool,
    close: () => {
      sub.close();
      pool.close(relays);
    },
  };
}

/**
 * Publie l'événement de profil sur les relais configurés.
 * @param {{ SimplePool: any, finalizeEvent: (evt: any, sk: Uint8Array) => any }} nostrLib
 */
export async function publishProfile(nostrLib, pool, identity, profile, relays = DEFAULT_RELAYS) {
  const template = buildProfileEvent(profile);
  const signed = nostrLib.finalizeEvent(template, identity.privateKey);
  await Promise.any(pool.publish(relays, signed));
  return signed;
}

export { DEFAULT_RELAYS, PROFILE_EVENT_KIND, APP_TAG };
