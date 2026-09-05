# Dossier — matching emploi P2P, local et sans compte

Application web statique de mise en relation candidats/recruteurs. Aucun
backend applicatif, aucun compte, aucune IA cloud, **aucune réécriture de
document**.

## Le flux (volontairement simple et asymétrique)

**Candidat**
1. Se donne un nom (mis en cache, visible, réutilisé d'une session à l'autre).
2. Renseigne **un mot-clé de recherche** (ex. "Data Engineer", "Python") —
   obligatoire : c'est lui qui décide quelles salles d'annonce analyseront
   son profil.
3. Dépose son CV (fichier `.docx`/`.txt` — pas de texte collé).
4. Clique sur **Rechercher en direct**. C'est tout.

Derrière ce clic : le CPU extrait des mots-clés du CV, localement, puis le
navigateur **diffuse** (nom + mot-clé + mots-clés du CV + CV en pièce
jointe) à tous les annonceurs déjà connectés — et à chaque nouvel annonceur
qui rejoint le réseau ensuite. Pas de modèle à choisir, pas d'IA à ce stade.

**Annonceur**
1. Se donne un nom.
2. Crée une ou plusieurs **salles d'annonce** : un titre + le texte de
   l'annonce collé (jamais de fichier, jamais publié — le texte reste sur
   son appareil).
3. Clique sur **Publier et rechercher en direct**.

Pour chaque salle, le CPU extrait des mots-clés de l'annonce, localement.
Quand une diffusion candidat arrive, **son mot-clé est d'abord comparé aux
mots-clés de la salle (titre + compétences + domaines)** — s'il ne
correspond à rien, la diffusion est ignorée avant toute analyse ou scoring.
C'est ce filtre qui évite de surcharger le recruteur avec des candidats
hors sujet (`RoomRanker.ingestBroadcast` → `matchesKeywordGate`,
`src/p2p/discovery.js`). Seules les diffusions qui passent ce premier tri
sont ensuite comparées mot-clé par mot-clé aux exigences de l'annonce pour
produire un score.

L'annonceur peut alors, pour un candidat donné : **ouvrir un chat** ou
**proposer un rendez-vous** (message libre). Le candidat reçoit l'un ou
l'autre et accepte ou refuse.

Aucun modèle IA n'intervient dans ce flux pour l'instant — le matching est
un scoring déterministe par mots-clés (CPU). Le code WebLLM (`src/llm/`,
`src/worker/`) reste dans le dépôt pour une intégration future, mais n'est
plus câblé à l'interface.

## Démarrer en local

```bash
npm test        # suite de tests du cœur métier (déterministe)
npm run serve    # sert le dossier statique sur http://localhost:8080
```

Aucune étape de build : JavaScript vanilla, dépendances (Trystero, mammoth)
résolues via import map + CDN (`esm.run`). Servir via `npm run serve` (pas
en `file://` : les ES modules et le Service Worker l'exigent).

## Déploiement GitHub Pages

`.github/workflows/deploy.yml` fait tourner les tests puis publie le dépôt
tel quel sur GitHub Pages à chaque push sur `main`. Tous les chemins sont
relatifs, pour fonctionner sous `https://username.github.io/repository/`.

## Architecture réseau

Une seule "room" Trystero, partagée par tout le monde (candidats et
annonceurs), avec deux canaux :

- `jm_msg` : messages JSON typés et validés (`src/p2p/protocol.js`) —
  diffusion candidat, proposition de chat/rendez-vous, réponse, messages de
  chat ;
- `jm_cv` : octets bruts du CV, transmis en pièce jointe avec la diffusion
  candidat.

Trystero s'appuie sur la stratégie `trystero/nostr` pour la signalisation
WebRTC (relais Nostr publics) — pas de couche Nostr applicative maison à
maintenir : la découverte "en direct" se fait simplement en rejoignant la
même room.

L'identité (`src/storage/identity.js`) est un identifiant stable généré une
fois par ONGLET et stocké dans `sessionStorage` (pas une paire de clés
cryptographiques ici, juste un ID technique) — délibérément pas dans
IndexedDB/localStorage, qui sont partagés par tout le navigateur et
donneraient la même identité à deux onglets ouverts en parallèle (ex. un
onglet candidat + un onglet annonceur pour tester les deux côtés). Il est
affiché à l'écran, et surtout **transporté dans le contenu des messages**
(`senderId` d'une diffusion candidat, `fromId` d'une proposition) : c'est ce
qui permet de reconnaître la même personne d'une reconnexion réseau à
l'autre, indépendamment de l'identifiant de transport Trystero (lui,
éphémère — voir `RoomRanker` dans `src/p2p/discovery.js`, indexé par
identité applicative et non par ID de transport).

## Ce qui ne quitte jamais l'appareil

- Le texte intégral d'une annonce (annonceur) : jamais publié, jamais
  envoyé — seuls des mots-clés extraits localement servent à la comparaison.
- Le CV du candidat : envoyé **volontairement** en pièce jointe P2P
  uniquement lors d'une diffusion candidat (c'est un choix produit assumé
  ici — le recruteur doit pouvoir le consulter), jamais stocké sur un
  serveur, jamais republié par le recruteur.

## État d'avancement

| Bloc | Statut |
|---|---|
| Cœur métier (parsing CPU, extraction, normalisation, scoring, matching) | ✅ implémenté et testé (`tests/`) |
| Diffusion candidat + validation stricte des messages réseau | ✅ implémenté et testé |
| Salles d'annonce multiples côté recruteur, scoring par salle | ✅ implémenté et testé (`RoomRanker`) |
| Transport CV en pièce jointe (canal binaire Trystero dédié) | ✅ code écrit, à valider en conditions réelles |
| Chat P2P + proposition de rendez-vous | ✅ implémenté |
| Identité persistante visible (nom + ID stable) | ✅ implémentée |
| Stockage local (IndexedDB : chat, identité, cache, pairs bloqués) | ✅ implémenté |
| Blocage/ignorance d'un pair (§75) | ✅ implémenté |
| PWA (manifest, Service Worker, icônes) | ✅ implémentée |
| CI GitHub Actions (tests + déploiement Pages) | ✅ implémentée |
| Intégration WebLLM dans le flux utilisateur | ⏳ code présent (`src/llm/`, `src/worker/`) mais désactivé dans l'UI — "l'IA aura lieu autrement" |
| Support PDF | ⏳ hors périmètre V1 |

Les échanges P2P réels (deux navigateurs, vrais relais de signalisation)
n'ont pas pu être exécutés bout-en-bout dans cet environnement de
développement. Le cœur métier déterministe, lui, est entièrement testé
(`node --test tests/` → 22/22 tests verts).

## Arborescence

```
src/
├── app/main.js           orchestration générale
├── ui/                    rendu DOM vanilla + style.css
├── core/
│   ├── parser/            Document -> texte structuré (DOCX/TXT)
│   ├── extraction/        extraction heuristique CPU (mots-clés)
│   ├── normalization/     alias de compétences, nettoyage
│   ├── matching/          filtre CPU avant scoring
│   ├── scoring/           score multidimensionnel explicable
│   └── validation/        schémas de validation runtime (§55-58)
├── llm/, worker/          WebLLM — présent, pas encore câblé à l'UI
├── p2p/
│   ├── protocol.js        messages typés et versionnés
│   ├── trystero.js        transport P2P (messages JSON + CV en binaire)
│   └── discovery.js       RoomRanker : scoring live par salle d'annonce
├── storage/               identité (sessionStorage), chat/cache/blocklist (IndexedDB)
└── config/matching.js     pondérations, seuils, limites
tests/                     tests unitaires (Node --test, sans dépendance)
```

## Principes non négociables

- Le document original (CV, annonce) **n'est jamais réécrit ni modifié**.
- Le texte d'une annonce **ne quitte jamais l'appareil du recruteur**.
- Une information absente est **`UNKNOWN`, jamais `NO`** par défaut.
- Le chat nécessite un **accord explicite** (proposition + acceptation).
- Bloquer un pair est **silencieux** : aucune notification ne lui est envoyée.
