# Dossier — matching emploi P2P, local et sans compte

Application web statique de mise en relation candidats/recruteurs.
L'analyse des CV et annonces se fait **localement** (CPU + WebLLM dans le
navigateur), la découverte et le chat passent par **Nostr** (signalisation)
et **Trystero** (transport P2P direct). Aucun backend applicatif, aucun
compte, aucun LLM cloud, **aucune réécriture de document**.

## Démarrer en local

```bash
npm test        # exécute la suite de tests du cœur métier (déterministe)
npm run serve    # sert le dossier statique sur http://localhost:8080
```

Aucune étape de build n'est nécessaire : le runtime est du JavaScript
vanilla avec import map vers les dépendances (WebLLM, Trystero, Nostr,
mammoth) résolues via CDN (`esm.run`). Ouvrez `index.html` servi par
`npm run serve` (pas en `file://`, les ES modules et le Service Worker
l'exigent).

## Déploiement GitHub Pages

`.github/workflows/deploy.yml` fait tourner les tests puis publie le dépôt
tel quel sur GitHub Pages à chaque push sur `main`. Aucun chemin n'est
supposé absolu (`/`) : tout est relatif, pour fonctionner sous
`https://username.github.io/repository/`.

## État d'avancement

| Bloc | Statut |
|---|---|
| Cœur métier (parsing CPU, extraction, normalisation, scoring, matching) | ✅ implémenté et testé (`tests/`) |
| Validation des sorties WebLLM / messages réseau | ✅ implémenté et testé |
| Intégration WebLLM (Worker + prompts + catalogue de modèles) | ✅ code écrit, à valider avec un vrai chargement de modèle en navigateur |
| Nostr (identité locale, découverte, publication de profil minimal) | ✅ code écrit, à valider contre de vrais relais |
| Trystero (transport P2P direct, chat) | ✅ code écrit, à valider en conditions réelles (2 navigateurs) |
| Stockage local (IndexedDB : profils, cache, chat, suppression totale) | ✅ implémenté |
| UI vanilla JS (rôle, upload, ledger de matchs, détail, chat) | ✅ implémentée, identité visuelle dédiée (`src/ui/style.css`) |
| PWA (manifest, Service Worker, icônes) | ✅ implémentée |
| CI GitHub Actions (tests + déploiement Pages) | ✅ implémentée |
| Sécurité réseau (limites de taille, validation stricte, anti prompt-injection) | ✅ implémentée dans `core/validation` et `p2p/protocol` |
| Gestion des pairs malveillants (bloquer/ignorer un pair) | ✅ implémentée (`src/storage/blocklist.js`, §75) |
| Annonces multiples par recruteur + curseur de score en temps réel | ✅ implémentée (voir section dédiée ci-dessous) |
| Support PDF | ⏳ hors périmètre V1 (§16, §89) |

Les modules réseau (Nostr/Trystero/WebLLM) n'ont pas pu être exécutés
bout-en-bout dans cet environnement de développement (pas d'accès WebGPU ni
aux relais Nostr/serveurs de signalisation depuis ce sandbox). Le cœur
métier déterministe, lui, est entièrement testé (`node --test tests/` →
16/16 tests verts).

## Arborescence

```
src/
├── app/main.js          orchestration générale
├── ui/                   rendu DOM vanilla + style.css
├── core/
│   ├── parser/           Document -> texte structuré (DOCX/TXT)
│   ├── extraction/       extraction heuristique CPU + fusion avec WebLLM
│   ├── normalization/    alias de compétences, nettoyage
│   ├── matching/         filtre CPU avant scoring (§30-31)
│   ├── scoring/          score multidimensionnel explicable (§24-29)
│   └── validation/       schémas de validation runtime (§55-58)
├── llm/                  provider (thread principal) + wrapper WebLLM + prompts
├── worker/llm.worker.js  WebLLM tourne exclusivement ici (§47)
├── p2p/                  protocole typé, Nostr, Trystero, orchestration découverte
├── storage/              IndexedDB : profils, cache, chat, liste de pairs bloqués
├── models/catalog.js     catalogue de modèles contrôlé (§79-80)
└── config/matching.js    pondérations, seuils, limites — configuration centrale
tests/                    tests unitaires (Node --test, sans dépendance)
```

## Annonces multiples et seuil de visibilité en temps réel

Un recruteur peut publier **plusieurs annonces actives simultanément**
(§1 : "une ou plusieurs annonces d'emploi"). Chaque annonce est une carte
indépendante avec :

- son propre score par candidat découvert (calculé côté recruteur, pour son
  propre tableau de bord — il voit tout le monde) ;
- un **curseur de score minimum (0-100)**, réglable en temps réel, qui
  détermine quels candidats peuvent **voir l'annonce et proposer un chat**.

### Comment le seuil est appliqué (architecture décentralisée)

Il n'y a pas de serveur central capable de "cacher" une annonce à quelqu'un.
Le seuil est donc :

1. publié comme partie du profil réseau minimal du recruteur
   (`capabilities.postings[].visibilityThreshold`, jamais le document
   complet, §11/§51) ;
2. **appliqué côté candidat** : chaque candidat calcule localement son
   propre score de matching pour cette annonce (à partir des faits publics
   de l'annonce), puis compare ce score au seuil publié. En dessous, il n'y a
   simplement pas de ligne dans son classement (`src/p2p/discovery.js`,
   `MatchingRanker._emit`).

Quand le recruteur bouge le curseur :

- **en direct (pendant le drag)** : la vue recruteur se met à jour
  instantanément (aucun réseau, juste un filtre local), *et* un message
  `threshold_update` léger est diffusé aux candidats déjà connectés via
  Trystero, qui recalculent leur visibilité sans re-scorer quoi que ce soit ;
- **au relâchement du curseur** : le profil complet (avec le nouveau seuil)
  est republié sur Nostr, avec un anti-rebond de 800 ms, pour que les
  candidats qui se connectent plus tard voient aussi le seuil à jour.

Le tableau de bord du recruteur, lui, **ne masque jamais** un candidat déjà
découvert : il marque juste chaque ligne "visible pour ce candidat" ou "sous
le seuil", pour que le recruteur voie l'effet de son curseur en temps réel
avant de le figer.

## Principes non négociables (rappel du cahier des charges)

- Le document original (CV, annonce) **n'est jamais réécrit ni modifié**.
- Le document complet **n'est jamais publié automatiquement** sur le réseau ;
  seul un profil de matching minimal (`PeerProfile`) est partagé.
- La clé privée locale **ne quitte jamais le navigateur**.
- Une information absente du CV est **`UNKNOWN`, jamais `NO`** par défaut.
- Le GPU (WebLLM) n'est sollicité **qu'après filtrage CPU**, jamais sur
  l'ensemble brut du réseau.
- Le chat nécessite un **double consentement** (proposition + acceptation).
