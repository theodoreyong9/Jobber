# CV Adapter

Site statique, 100 % client, qui adapte un CV `.docx` à une offre d'emploi
en utilisant [WebLLM](https://github.com/mlc-ai/web-llm) (LLM exécuté dans
le navigateur via WebGPU) — aucun serveur, aucune donnée envoyée nulle part.

## Architecture : l'orchestrateur décide, le modèle rédige

Plutôt que de confier une grosse tâche complexe à un seul (et long) appel au
modèle, le travail est explicitement découpé :

1. **Lecture** : le `.docx` est ouvert comme une archive zip
   ([JSZip](https://stuk.github.io/jszip/)), `word/document.xml` est parsé
   comme du XML natif (`DOMParser`).
2. **Classification déterministe (le code, pas le modèle)** : chaque
   segment de texte ("run" Word — un fragment de paragraphe à la mise en
   forme homogène) est classé par des règles simples et fiables, sans
   aucun appel au modèle :
   - segment en gras, court, tout en majuscules → repère de section
     ("EXPERIENCE", "SKILLS"…), jamais modifiable ;
   - premier segment en gras du document → titre d'accroche du CV,
     modifiable ;
   - tout autre segment en gras → intitulé de poste / entreprise / diplôme,
     jamais modifiable ;
   - segment sous une section "Formation/Éducation/Langues/Diplôme/Autres" →
     jamais modifiable, même si non gras ;
   - segment ressemblant à un email/téléphone/URL → jamais modifiable ;
   - segment trop court (< 25 caractères) → jamais modifiable ;
   - tout le reste → contenu modifiable (résumé, compétences, descriptions
     de missions).

   Le modèle ne voit donc **jamais** un segment qu'on ne veut pas qu'il
   touche : ce n'est pas une consigne qu'on espère qu'il respecte, c'est une
   sélection faite en amont par du code déterministe.
3. **Réécriture unitaire** : chaque segment retenu comme modifiable est
   envoyé **un par un** au modèle (texte court en entrée, réponse en texte
   libre — pas de JSON à produire), avec l'offre d'emploi. Beaucoup de
   petits appels séquentiels plutôt qu'un seul gros. Si un appel échoue
   (bug runtime WebLLM), on retente une fois ce segment précis avec un
   moteur neuf ; s'il échoue encore, ce seul segment reste inchangé et le
   reste de la passe continue — jamais tout perdre pour un incident isolé.
4. **Écriture** : pour chaque segment reformulé, seul son texte (`<w:t>`)
   est remplacé. Sa mise en forme (police, couleur, gras, taille) n'est ni
   recréée ni même effleurée. Tout le reste du document (styles, thème,
   tableaux, en-têtes/pieds de page, photo, numérotation) n'est jamais
   touché.
5. **Réassemblage** : le zip est reconstruit avec ce `document.xml` modifié
   et proposé au téléchargement.

Tout se passe dans l'onglet du navigateur : pas de backend, pas de clé API,
rien n'est jamais uploadé sur un serveur.

## Continuer à améliorer

Après une première passe, un bouton « Continuer à améliorer ce CV » permet
de relancer une nouvelle passe de reformulation directement sur le document
déjà modifié (en changeant éventuellement le texte de l'annonce), sans
jamais perdre la mise en page d'origine.

## Déploiement automatique sur GitHub Pages

Ce repo contient un workflow (`.github/workflows/deploy.yml`) qui déploie
automatiquement sur GitHub Pages à chaque push sur `main`.

Étapes pour l'activer :

1. Pousse ce repo sur GitHub (`main` comme branche par défaut).
2. Dans **Settings → Pages**, sous "Build and deployment", choisis la
   source **GitHub Actions** (pas "Deploy from a branch").
3. Pousse un commit sur `main` (ou lance le workflow manuellement depuis
   l'onglet Actions) : le site est déployé sur
   `https://<ton-user>.github.io/<nom-du-repo>/`.

Aucune étape de build n'est nécessaire : le site est du HTML/CSS/JS pur, et
la seule librairie externe ([JSZip](https://stuk.github.io/jszip/), pour
lire/écrire l'archive du `.docx`) est chargée depuis un CDN (`jsdelivr`)
directement dans le navigateur de l'utilisateur. WebLLM est chargé depuis
`esm.run` (également jsDelivr).

## Limites à connaître

- Nécessite un navigateur avec **WebGPU** (Chrome/Edge récents ; Safari et
  Firefox n'ont pas encore un support fiable).
- Le premier chargement du modèle télécharge plusieurs centaines de Mo à
  quelques Go selon le modèle choisi — c'est lent la première fois,
  quasi instantané ensuite grâce au cache du navigateur.
- La classification des segments repose sur des heuristiques (gras, taille,
  mots-clés de section, motifs de contact) qui couvrent bien les CV
  classiques mais peuvent se tromper sur une mise en page très inhabituelle
  — relis toujours le résultat avant de l'envoyer.
- Le modèle est prompté pour ne pas inventer d'expérience ou de compétence,
  mais comme tout LLM il peut se tromper : relis toujours le résultat avant
  de l'envoyer.
- Sur un GPU peu puissant ou avec peu de VRAM, le pilote graphique peut
  planter en cours d'inférence (`DXGI_ERROR_DEVICE_REMOVED` / "Device was
  lost"). Dans ce cas : recharge la page, choisis le modèle "très léger",
  et vérifie que tes pilotes graphiques sont à jour. Un bug plus léger et
  intermittent du runtime WebLLM ("Object has already been disposed",
  documenté sur mlc-ai/web-llm#486 et #560) peut aussi survenir
  ponctuellement sur un segment isolé — l'app le gère automatiquement en
  ne perdant que ce segment, pas toute la passe.

## Structure du repo

```
index.html                  page unique
style.css                   styles
app.js                      logique (classification, lecture/édition XML du docx, WebLLM, réassemblage)
.github/workflows/deploy.yml   CI de déploiement Pages
```
