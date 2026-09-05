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

## Trois modes cumulables

En haut de l'écran, trois puces activables **indépendamment et
simultanément** : 🧑‍💼 **Candidat** · 🏢 **Annonceur** · 💞 **Rencontre**.
Chaque mode a sa **propre identité** (id + nom, namespacée séparément —
`src/storage/identity.js`), sa propre connexion réseau (partagée en
coulisses, une seule room P2P pour tout le monde), et son propre panneau
autonome. Rien n'oblige à choisir un seul mode : on peut être candidat et
annonceur en même temps, avec deux identités distinctes si on le souhaite.

Chaque panneau suit la même structure :
1. **Bloc identité** repliable (id visible, renommage, restauration d'un ID
   noté ailleurs, invalidation d'un ID compromis).
2. **Détails** repliables (les champs de profil/recherche du mode).
3. **Boost IA** optionnel (candidat emploi et rencontre uniquement).
4. **Lancement**.
5. **Onglets** avec badge de notification — conversations (candidat,
   rencontre) ou salles d'annonce (annonceur) — et à l'intérieur, le chat
   avec défilement automatique.

## Candidat (emploi)

Mots-clés + ville(s) (**obligatoire**) + pays (optionnel) + CV
(`.docx`/`.txt`, analysé localement dès le dépôt). Boost IA optionnel avant
l'envoi (ajoute des mots-clés au CPU, jamais ne les remplace). Lancement =
diffusion (nom, mots-clés, ville(s), pays, CV en pièce jointe) à tous les
annonceurs déjà connectés et à venir.

Les propositions reçues (chat ou rendez-vous) arrivent en onglets, avec un
badge 🔔 sur les demandes en attente et un badge numérique sur les messages
non lus. Réinitialiser la recherche prévient immédiatement les annonceurs
connectés (`identity_retired`) avant de tout effacer localement.

## Annonceur (emploi)

Une ou plusieurs **salles d'annonce**, créées via un bouton **"+ Nouvelle
salle"** juste à côté des onglets (plus un formulaire toujours visible).
Chaque salle : intitulé, **ancienneté min et max** (fourchette, toutes deux
optionnelles et indépendantes), pays, texte. Aucune IA de ce côté : un seul
score, un compte de mots-clés en commun, calculé localement.

L'ancienneté du candidat comparée à la fourchette est calculée à partir de
la **date la plus ancienne réellement trouvée dans son CV** (pas d'une
phrase fragile type "5 ans d'expérience", sauf si elle existe explicitement
— auquel cas elle est préférée).

## Rencontre

Un mode symétrique : chaque personne diffuse à la fois **ce qu'elle est**
(intitulé, ville, pays, texte de profil, photo) et **ce qu'elle demande**
(mots-clés de recherche) — en une seule diffusion (`domain: "dating"`). En
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
