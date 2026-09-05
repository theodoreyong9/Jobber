# Jobber — matching emploi P2P, local et sans compte

> Le candidat veut des contacts alors qu'il doit mieux écrire son CV ?
> L'annonceur filtre les candidats alors qu'il doit mieux écrire son offre
> d'emploi ?
>
> **La solution Jobber.** Vous envoyez votre CV, vous ne voyez pas
> l'annonce, vous attendez le contact. Vous envoyez votre annonce, vous
> recevez un CV augmenté, vous rentrez en contact.
>
> Jobber est le premier portail emploi live assisté par IA, sans permission
> (aucun compte nécessaire).

Application web statique de mise en relation candidats/recruteurs. Aucun
backend applicatif, aucun compte, aucune IA cloud, **aucune réécriture de
document**.

## Le flux

**Candidat**
1. Se donne un nom (mis en cache, visible, réutilisé d'une session à l'autre).
2. Renseigne **un ou plusieurs mots-clés de recherche** et **une ou
   plusieurs villes** (virgules pour en donner plusieurs — ex.
   "Data Engineer, Python" / "Paris, Lyon").
3. Dépose son CV (fichier `.docx`/`.txt`) — **analysé automatiquement dès
   le dépôt**, localement.
4. Peut, en option, **booster ses mots-clés avec l'IA** avant l'envoi (voir
   plus bas) — jamais obligatoire.
5. Clique sur **Rechercher en direct**.

Derrière ce clic : le navigateur **diffuse** (nom + mots-clés + villes + CV
en pièce jointe) à tous les annonceurs déjà connectés, et à chaque nouvel
annonceur qui rejoint ensuite. Un bouton **Réinitialiser ma recherche**
permet d'arrêter et de repartir de zéro à tout moment — les annonceurs
connectés sont prévenus immédiatement (message `identity_retired`), pas
seulement à la prochaine coupure réseau.

**Annonceur**
1. Se donne un nom.
2. Crée une ou plusieurs **salles d'annonce** : un titre, une ancienneté
   minimale optionnelle (nombre d'années), et le texte de l'annonce collé
   (jamais de fichier, jamais publié — le texte reste sur son appareil).
3. Clique sur **Publier et rechercher en direct**.

Pour chaque salle, le CPU extrait des mots-clés de l'annonce, localement.
Quand une diffusion candidat arrive, **au moins un de ses mots-clés doit
correspondre à la salle** (titre ou mots-clés extraits) avant toute
analyse — ça évite de surcharger l'annonceur avec des candidats hors sujet
(`RoomRanker.ingestBroadcast` → `matchesKeywordGate`,
`src/p2p/discovery.js`). Les diffusions qui passent ce premier tri sont
ensuite comparées mot-clé par mot-clé pour produire un score — **un seul
score, purement CPU, aucune couche IA de ce côté** (voir plus bas).

L'annonceur peut alors, pour un candidat donné : **proposer un échange**
(un message optionnel — vide, c'est un simple chat ; rempli, c'est une
proposition de rendez-vous). Le candidat reçoit la proposition et
accepte/refuse.

## Le scoring, sans catégories ni listes devinées

**Le score = un compte brut de mots-clés en commun entre le CV du candidat
et l'annonce.** Pas de pourcentage, pas de dimensions pondérées (domaine,
séniorité, langues traitées à part). Comme tous les candidats d'une salle
sont comparés au même jeu de mots-clés requis, ce compte suffit à classer
honnêtement.

Deux informations **explicites**, jamais devinées par une liste figée,
s'ajoutent à côté du score :
- **Ville(s)** : le candidat les tape lui-même ; comparées littéralement au
  texte intégral de l'annonce (recherche de sous-chaîne, pas de
  dictionnaire de villes). "Match" si au moins une correspond.
- **Ancienneté** : l'annonceur indique un minimum (champ numérique, à côté
  du titre) ; celle du candidat est calculée à partir de dates réellement
  présentes dans son CV (la plus ancienne trouvée), avec priorité à une
  phrase explicite ("5 ans d'expérience") si elle existe.

## Le boost IA — côté candidat, avant l'envoi

Après plusieurs itérations ratées (IA continue côté annonceur, doublons de
classement...), la couche IA a été recentrée là où elle a le plus de sens :
**côté candidat, avant l'envoi, en option.**

Un bouton **"🚀 Booster avec l'IA"** apparaît une fois le CV analysé. Il
charge un modèle WebLLM léger et fixe (pas de choix utilisateur), lui donne
le texte intégral du CV et les mots-clés déjà trouvés par le CPU, et lui
demande des mots-clés **additionnels** (synonymes, intitulés de poste
proches, compétences implicites raisonnablement déductibles — jamais une
réécriture du CV). Les mots-clés suggérés s'ajoutent à ceux du CPU, jamais
à leur place.

**Ça ne bloque jamais l'envoi.** Si WebGPU est indisponible, le bouton
l'indique et reste désactivé. Si le modèle échoue à charger ou que l'appel
échoue (JSON invalide, timeout), le candidat garde ses mots-clés CPU tels
quels et peut passer en direct normalement (voir `runKeywordBoost` dans
`src/llm/webllm.js`, testé dans `tests/llm.test.mjs`).

Côté annonceur, il n'y a **plus aucune couche IA** : un seul score, calculé
par mots-clés, point.

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

Une seule "room" Trystero (paquet racine `trystero`, Nostr par défaut pour
la signalisation), partagée par tout le monde, avec deux canaux :

- `jm_msg` : messages JSON typés et validés (`src/p2p/protocol.js`) —
  diffusion candidat, proposition de chat/rendez-vous, réponse, messages de
  chat, retrait d'identité ;
- `jm_cv` : octets bruts du CV, transmis en pièce jointe avec la diffusion
  candidat.

Une liste de relais Nostr fiables est fixée explicitement
(`NOSTR_RELAY_URLS` dans `src/app/main.js`) plutôt que de dépendre de la
liste par défaut de Trystero.

L'identité (`src/storage/identity.js`) est un identifiant stable généré une
fois par ONGLET et stocké dans `sessionStorage` — délibérément pas dans
IndexedDB/localStorage, qui sont partagés par tout le navigateur (deux
onglets ouverts en parallèle auraient sinon la même identité). Il est
affiché à l'écran et transporté dans le contenu des messages (`senderId`,
`fromId`) : c'est ce qui permet de reconnaître la même personne d'une
reconnexion réseau à l'autre, indépendamment de l'identifiant de transport
Trystero (éphémère). Deux boutons compacts (repliés sous
"⚙ Confidentialité & identité") : **Invalider mon ID** (génère un nouvel
identifiant, nom conservé — le "kill switch" d'un ID qu'on croit compromis)
et **Restaurer cet ID** (reprendre volontairement un ID noté ailleurs).

## Ce qui ne quitte jamais l'appareil

- Le texte intégral d'une annonce (annonceur) : jamais publié, jamais
  envoyé — seuls des mots-clés extraits localement servent à la comparaison.
- Le CV du candidat : envoyé **volontairement** en pièce jointe P2P
  uniquement lors d'une diffusion candidat (choix produit assumé — le
  recruteur doit pouvoir le consulter), jamais stocké sur un serveur.

## État d'avancement

| Bloc | Statut |
|---|---|
| Cœur métier (parsing CPU, mots-clés, ville, ancienneté) | ✅ implémenté et testé (`tests/`) |
| Diffusion candidat + validation stricte des messages réseau | ✅ implémenté et testé |
| Salles d'annonce multiples côté annonceur, filtre par mot-clé | ✅ implémenté et testé (`RoomRanker`) |
| Transport CV en pièce jointe (canal binaire Trystero dédié) | ✅ code écrit, à valider en conditions réelles |
| Chat P2P + proposition de rendez-vous (fusionnés en une action) | ✅ implémenté |
| Boost IA côté candidat (mots-clés additionnels, jamais bloquant) | ✅ implémenté et testé (`tests/llm.test.mjs`) |
| Identité persistante par onglet, visible, invalidation/restauration | ✅ implémentée |
| Réinitialisation de recherche (candidat) | ✅ implémentée |
| Stockage local (IndexedDB : chat, cache, pairs bloqués ; sessionStorage : identité) | ✅ implémenté |
| PWA (manifest, Service Worker, icônes) | ✅ implémentée |
| CI GitHub Actions (tests + déploiement Pages) | ✅ implémentée |
| Support PDF | ⏳ hors périmètre V1 |

Les échanges P2P réels (deux navigateurs, vrais relais de signalisation)
n'ont pas pu être exécutés bout-en-bout dans cet environnement de
développement. Le cœur métier déterministe, lui, est entièrement testé
(`node --test tests/` → tous les tests verts, `npm test`).

## Arborescence

```
src/
├── app/main.js           orchestration générale
├── ui/                    rendu DOM vanilla + style.css
├── core/
│   ├── parser/            Document -> texte structuré (DOCX/TXT)
│   ├── extraction/        extraction heuristique CPU (mots-clés, années)
│   ├── normalization/     alias de compétences, nettoyage
│   ├── matching/          filtre CPU avant scoring
│   ├── scoring/           compte de mots-clés + ville/ancienneté à côté
│   └── validation/        schémas de validation runtime
├── llm/, worker/          WebLLM — boost côté candidat uniquement
├── p2p/
│   ├── protocol.js        messages typés et versionnés
│   ├── trystero.js        transport P2P (messages JSON + CV en binaire)
│   └── discovery.js       RoomRanker : scoring live par salle d'annonce
├── storage/               identité (sessionStorage), chat/cache (IndexedDB)
└── config/matching.js     limites réseau, dictionnaire d'alias
tests/                     tests unitaires (Node --test, sans dépendance)
```

## Principes non négociables

- Le document original (CV, annonce) **n'est jamais réécrit ni modifié**.
- Le texte d'une annonce **ne quitte jamais l'appareil de l'annonceur**.
- Aucune liste figée (villes, secteurs) ne sert de substitut à une vraie
  comparaison — tout ce qui est comparé est extrait des deux côtés.
- Une information absente est **inconnue, jamais interprétée par défaut
  comme négative**.
- Le chat nécessite un **accord explicite** (proposition + acceptation).
- Le boost IA **n'est jamais bloquant** : sa perte n'empêche jamais un
  candidat de passer en direct avec ses seuls mots-clés CPU.
