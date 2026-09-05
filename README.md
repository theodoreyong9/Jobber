# Jobber — matching emploi P2P, local et sans compte

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

Trystero (paquet racine `trystero`, Nostr par défaut) s'appuie sur des
relais Nostr publics pour la signalisation WebRTC — pas de couche Nostr
applicative maison à maintenir : la découverte "en direct" se fait
simplement en rejoignant la même room. Une liste de relais fiables est
fixée explicitement (`NOSTR_RELAY_URLS` dans `src/app/main.js`) plutôt que
de dépendre de la liste par défaut de Trystero.

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

Un bouton **"Invalider mon ID"** génère un nouvel identifiant en conservant
le nom affiché — l'ancien ID devient orphelin. Si vous étiez en direct
(candidat), un message `identity_retired` est diffusé AVANT la
rediffusion sous le nouvel ID : les annonceurs déjà connectés retirent la
ligne immédiatement plutôt que d'attendre une déconnexion (voir
`RoomRanker.retireIdentity`). **"Supprimer toutes mes données locales"**
invalide aussi l'ID au passage — un reset qui laisserait l'ancien ID actif
ne serait pas un vrai reset.

Un bouton **"Restaurer cet ID"** (à côté) permet à l'inverse de coller un ID
noté ailleurs pour reprendre volontairement la même identité applicative.
Aucun de ces mécanismes n'est une preuve cryptographique : quiconque
connaît un ID peut se l'attribuer — "invalider" ne fait qu'abandonner l'ID
compromis pour votre propre client, ça n'empêche pas un tiers de continuer
à l'utiliser ailleurs.

## Couche IA continue (optionnelle)

Un bouton **"Activer l'IA continue"** (visible côté annonceur, à côté de
l'identité) ajoute un second classement, calculé par un modèle WebLLM léger
et fixe (pas de choix de modèle — le plus petit du catalogue), en plus du
classement CPU par mots-clés qui tourne déjà. Les deux coexistent :

- **Classement CPU** : toujours actif, déterministe, ne dépend d'aucune IA.
- **Classement IA** : optionnel. Quand un candidat est retenu par le filtre
  CPU d'une salle, son profil est comparé au texte complet de l'annonce par
  le modèle local, produisant un second score (visible en badge `IA nn` sur
  chaque ligne, et en détail sur la fiche du candidat). Un bouton "Trier :
  CPU / IA" bascule l'ordre d'affichage entre les deux.

**La perte du GPU ne casse jamais le CPU.** Concrètement :
- si WebGPU n'est pas disponible, le bouton reste désactivé avec un
  message explicite — rien d'autre n'est affecté ;
- si le chargement du modèle échoue, la couche repasse à "désactivée" et le
  classement CPU continue sans interruption ;
- si un appel de scoring individuel échoue (JSON invalide, timeout, sortie
  hors bornes), cette entrée reste simplement sans score IA — jamais
  d'exception remontée, jamais de blocage du reste de l'application (voir
  `runRelevanceScoring` dans `src/llm/webllm.js`, testé pour ces cas
  précisément dans `tests/llm.test.mjs`).

## Le scoring, sans catégories ni listes devinées

Après plusieurs allers-retours ratés (des listes de villes/secteurs
figées, présentées comme une vraie comparaison), le scoring a été
simplifié à l'os :

**Le score = un compte brut de mots-clés en commun entre le CV du candidat
et l'annonce.** Rien d'autre. Pas de pourcentage, pas de dimensions
pondérées (domaine, séniorité, langues traitées à part) : un candidat
"3 pts" a 3 mots-clés en commun avec les mots-clés extraits de l'annonce,
point final. Comme tous les candidats d'une même salle sont comparés au
même jeu de mots-clés requis, ce compte suffit à classer honnêtement.

Deux informations **explicites**, jamais devinées par une liste,
s'ajoutent à côté du score (jamais mélangées dedans) :
- **Ville** : le candidat tape la sienne ; elle est comparée littéralement
  au texte intégral de l'annonce (recherche de sous-chaîne, pas de
  dictionnaire de villes).
- **Ancienneté** : le recruteur indique l'ancienneté minimale recherchée
  (champ numérique, à côté du titre) ; celle du candidat est calculée à
  partir de dates réellement présentes dans son CV (la plus ancienne
  trouvée, `année actuelle − année la plus ancienne`), avec priorité à une
  phrase explicite ("5 ans d'expérience") si elle existe.

## Couche IA continue (optionnelle)

Un bouton **"Activer l'IA continue"** (visible côté annonceur) ajoute un
second score, calculé par un modèle WebLLM léger et fixe, en plus du
classement CPU par mots-clés qui tourne déjà. Ce n'est **pas** un
classement séparé : c'est un score indicatif affiché à côté de chaque
candidat, qui arrive de façon asynchrone (badge "IA…" pendant le calcul),
et qu'on peut éventuellement utiliser pour trier au lieu du score CPU — les
deux listes restent la même liste, juste réordonnée.

Le prompt reçoit tout ce qui est disponible des deux côtés (texte intégral
de l'annonce, mots-clés déjà extraits par le CPU, mots-clés/ville/
ancienneté du candidat) et tente des équivalences non littérales ("vente"
↔ "commercial") que le CPU, par construction, ne peut pas voir.

**La perte du GPU ne casse jamais le CPU** :
- si WebGPU n'est pas disponible, le bouton reste désactivé, rien d'autre
  n'est affecté ;
- si le modèle échoue à charger, la couche repasse à "désactivée" et le
  classement CPU continue sans interruption ;
- si un appel de scoring individuel échoue, cette entrée reste simplement
  sans score IA — jamais d'exception remontée (voir `runRelevanceScoring`
  dans `src/llm/webllm.js`, testé dans `tests/llm.test.mjs`).

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
| Couche IA continue optionnelle (scoring WebLLM en plus du CPU, jamais à sa place) | ✅ implémentée côté annonceur, résiliente à la perte de GPU (`tests/llm.test.mjs`) |
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
