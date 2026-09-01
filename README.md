# CV Adapter

Site statique, 100 % client, qui adapte un CV `.docx` à une offre d'emploi
en utilisant [WebLLM](https://github.com/mlc-ai/web-llm) (LLM exécuté dans
le navigateur via WebGPU) — aucun serveur, aucune donnée envoyée nulle part.

## Fonctionnement

Un `.docx` est en réalité une archive zip contenant du XML. Plutôt que de
regénérer un nouveau CV avec une mise en page générique, l'app **édite le
document original en place** :

1. Tu uploades ton CV `.docx` → l'archive est ouverte dans le navigateur
   ([JSZip](https://stuk.github.io/jszip/)) et `word/document.xml` est parsé
   comme du XML natif (`DOMParser`).
2. Chaque **segment de texte** ("run" au sens Word, un fragment de
   paragraphe avec une mise en forme homogène) est numéroté et son texte
   extrait. C'est important : sur beaucoup de CV, une ligne comme
   *"Poste — Entreprise — Dates"* (en gras) suivie de sa description
   (normale) forment en réalité **un seul paragraphe** en deux segments —
   éditer au niveau du paragraphe entier empêcherait de figer l'un tout en
   reformulant l'autre.
3. Tu colles le texte d'une offre d'emploi.
4. Un modèle (Llama 3.2 1B/3B, Phi-3.5 mini ou Llama 3.1 8B, au choix) est
   téléchargé une seule fois et mis en cache par le navigateur, puis reçoit
   la liste numérotée des segments (avec une annotation "(gras)" comme
   indice) + l'offre, et renvoie uniquement les numéros et le nouveau texte
   des segments de **contenu** (résumé, descriptions de missions,
   compétences, titre d'accroche) qu'il juge utile de reformuler.
5. Pour chaque segment concerné, seul son **texte** est remplacé — sa mise
   en forme (police, couleur, gras, taille) n'est ni recréée ni même
   effleurée : c'est le même élément XML, avec juste un contenu différent.
   Tout le reste du document (styles, thème, tableaux, en-têtes/pieds de
   page, photo, numérotation, dates, noms d'entreprises, diplômes,
   coordonnées) n'est jamais touché.
6. Le zip est ré-assemblé avec ce `document.xml` modifié et proposé au
   téléchargement.

Le modèle ne touche jamais au nom, aux dates, aux noms d'entreprises, aux
diplômes ou aux coordonnées : ces segments sont explicitement exclus du
prompt (avec une distinction explicite entre "titre d'accroche du CV",
modifiable, et "intitulé de poste par expérience", figé — les deux sont
souvent en gras mais n'ont pas le même statut). Un filet de sécurité côté
code rejette en plus toute tentative de modifier un segment trop court
(donc probablement une date ou un sigle isolé) même si le modèle en
proposait une.

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
- Un segment reformulé garde exactement sa mise en forme d'origine (même
  police, couleur, gras...), mais s'il contenait lui-même un mélange de
  styles en son sein (rare : un mot en couleur au milieu d'une phrase par
  exemple), ce détail interne est perdu au profit du style global du
  segment.
- Le modèle est prompté pour ne pas inventer d'expérience ou de diplôme et
  pour ne jamais toucher aux paragraphes factuels, mais comme tout LLM il
  peut se tromper : relis toujours le résultat avant de l'envoyer.
- Sur un GPU peu puissant ou avec peu de VRAM, le pilote graphique peut
  planter en cours d'inférence (`DXGI_ERROR_DEVICE_REMOVED` / "Device was
  lost"). Dans ce cas : recharge la page, choisis le modèle "très léger",
  et vérifie que tes pilotes graphiques sont à jour.

## Structure du repo

```
index.html                  page unique
style.css                   styles
app.js                      logique (lecture/édition XML du docx, WebLLM, réassemblage)
.github/workflows/deploy.yml   CI de déploiement Pages
```
