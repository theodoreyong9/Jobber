# Jobber — matching live, local et sans compte

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

Application web statique. Aucun backend applicatif, aucun compte, aucune IA
cloud, **aucune réécriture de document**.

## Trois modes, un seul affiché à la fois

En haut de l'écran, trois puces : 🧑‍💼 **Candidat** · 🏢 **Annonceur** ·
💞 **Rencontre**. **Un seul panneau est affiché à la fois** (bascule
exclusive, comme des onglets) — mais chaque mode **continue de tourner en
arrière-plan** avec sa propre identité pendant qu'on regarde un autre :
la connexion réseau reste active, les messages continuent d'arriver, un
badge numérique apparaît sur la puce d'un mode non affiché s'il y a de
l'activité. Rien ne s'empile visuellement, rien n'est perdu en changeant
de mode.

Chaque panneau suit la même structure :
1. **Bloc identité** (repliable, à côté du bloc "détails") : id visible,
   renommage, restauration d'un ID noté ailleurs, invalidation d'un ID
   compromis, et suppression des données **de ce mode uniquement**.
2. **Détails** repliables (les champs de profil/recherche du mode).
3. **Boost IA** optionnel (candidat emploi et rencontre uniquement).
4. **Lancement** — désactivé tant que les champs obligatoires ne sont pas
   remplis.
5. **Onglets** avec badge de notification — conversations (candidat,
   rencontre) ou salles d'annonce (annonceur) — et à l'intérieur, le chat
   avec défilement automatique.

## Candidat (emploi)

Mots-clés + ville + pays (**tous les trois obligatoires**) + CV
(`.docx`/`.txt`, analysé localement dès le dépôt). Boost IA optionnel avant
l'envoi (ajoute des mots-clés au CPU, jamais ne les remplace). Le bouton
Lancement reste désactivé tant que ces champs ne sont pas remplis.

Les propositions reçues (chat ou rendez-vous) arrivent en onglets, avec un
badge 🔔 sur les demandes en attente et un badge numérique sur les messages
non lus. Réinitialiser la recherche prévient immédiatement les annonceurs
connectés (`identity_retired`) avant de tout effacer localement.

## Annonceur (emploi)

Une ou plusieurs **salles d'annonce**, créées via un bouton **"+ Nouvelle
salle"** juste à côté des onglets. Chaque salle : intitulé, **ville et pays
(obligatoires)**, ancienneté min et max (fourchette, toutes deux
optionnelles et indépendantes), texte (obligatoire). Aucune IA de ce côté :
un seul score, un compte de mots-clés en commun, calculé localement. La
ville et le pays sont comparés **exactement** (comme tout le reste) —
aucune liste de villes, aucune recherche approximative dans le texte.

L'ancienneté du candidat comparée à la fourchette est calculée à partir de
la **date la plus ancienne réellement trouvée dans son CV** (pas d'une
phrase fragile type "5 ans d'expérience", sauf si elle existe explicitement
— auquel cas elle est préférée).

## Rencontre

Un mode symétrique : chaque personne diffuse à la fois **ce qu'elle est**
(intitulé, ville et pays obligatoires, âge optionnel affiché dans les
résultats, texte de profil, photo) et **ce qu'elle demande** (mots-clés de
recherche, obligatoires) — en une seule diffusion (`domain: "dating"`).
L'âge n'entre dans aucun calcul de score : c'est une information affichée,
point. En
interne, "mon profil" fonctionne exactement comme une salle d'annonce (même
moteur de scoring, même filtre par mots-clés), et "ma demande" fonctionne
exactement comme une diffusion candidat — le même code est réutilisé tel
quel, seul le libellé change dans l'interface.

**La photo circule comme le CV** : jointe uniquement à la diffusion, jamais
stockée ailleurs, jamais republiée. Boost IA optionnel sur le texte de
profil. Les "profils compatibles" apparaissent classés par mots-clés en
commun ; ouvrir un profil montre sa photo (dès reçue) et permet de proposer
un échange, qui devient une conversation à onglet une fois accepté.

## Le scoring, sans catégories ni listes devinées

**Le score = un compte brut de mots-clés en commun.** Pas de pourcentage,
pas de dimensions pondérées. Ville et pays sont comparés **littéralement**
(sous-chaîne pour la ville, exact pour le pays) — jamais via une liste
figée de villes ou de secteurs. Ce sont des informations affichées à côté
du score, jamais mélangées dedans.

## Démarrer en local

```bash
npm test        # suite de tests du cœur métier (déterministe)
npm run serve    # sert le dossier statique sur http://localhost:8080
```

Aucune étape de build : JavaScript vanilla, dépendances (`trystero`,
`mammoth`) résolues via import map + CDN. Servir via `npm run serve` (pas
en `file://`).

## Déploiement GitHub Pages

`.github/workflows/deploy.yml` teste puis publie sur GitHub Pages à chaque
push sur `main`. Chemins relatifs partout.

## Architecture réseau

Une seule room Trystero (paquet racine, Nostr par défaut pour la
signalisation, relais fixés explicitement dans `NOSTR_RELAY_URLS`), deux
canaux : `jm_msg` (messages JSON typés, tagués `domain: "job"|"dating"`) et
`jm_cv` (pièce jointe binaire — CV ou photo selon `meta.kind`).

Chaque message porte un `domain` pour que les modes cumulés ne se
mélangent jamais, même sur la même connexion.

## Ce qui ne quitte jamais l'appareil

- Le texte d'une annonce ou d'un profil Rencontre : jamais publié.
- Le CV / la photo : envoyés **volontairement** en pièce jointe P2P
  uniquement lors d'une diffusion, jamais stockés sur un serveur.

## État d'avancement

| Bloc | Statut |
|---|---|
| Cœur métier (mots-clés, ville, pays, ancienneté min/max) | ✅ testé (`tests/`) |
| Trois modes cumulables, identités namespacées | ✅ implémenté |
| Messagerie à onglets (candidat + rencontre), badges non-lus, autoscroll | ✅ implémenté |
| Annonceur : salles multiples, bouton "+" à côté des onglets | ✅ implémenté |
| Domaine Rencontre (profil symétrique, photo en pièce jointe) | ✅ implémenté |
| Boost IA candidat + rencontre, jamais bloquant | ✅ testé (`tests/llm.test.mjs`) |
| Identité par mode, invalidation/restauration | ✅ implémentée |
| PWA, CI GitHub Actions | ✅ implémentées |

Les échanges P2P réels (plusieurs navigateurs, vrais relais) n'ont pas pu
être exécutés bout-en-bout dans cet environnement de développement — cette
dernière passe (3 modes cumulables + domaine Rencontre) n'a donc pu être
vérifiée que par relecture et tests unitaires du cœur métier, pas par un
test manuel complet en conditions réelles.

## Arborescence

```
src/
├── app/main.js           orchestration : 3 modes, routage par domaine
├── ui/                    rendu DOM vanilla + style.css
├── core/                  parsing, extraction, scoring (générique, réutilisé par Rencontre)
├── llm/, worker/          WebLLM — boost, candidat emploi + rencontre
├── p2p/
│   ├── protocol.js        messages typés, tagués par domaine
│   ├── trystero.js        transport (messages JSON + pièce jointe binaire)
│   └── discovery.js       RoomRanker générique (salle d'annonce OU profil Rencontre)
├── storage/               identité namespacée (sessionStorage), chat/cache (IndexedDB)
└── config/matching.js     limites réseau, dictionnaire d'alias
tests/                     tests unitaires (Node --test, sans dépendance)
```

## Principes non négociables

- Un document original (CV, annonce, profil) **n'est jamais réécrit**.
- Le texte d'une annonce/d'un profil **ne quitte jamais l'appareil**.
- Aucune liste figée (villes, secteurs) ne remplace une vraie comparaison.
- Une information absente est **inconnue**, jamais interprétée par défaut.
- Le chat nécessite un **accord explicite** (proposition + acceptation).
- Le boost IA **n'est jamais bloquant**.
