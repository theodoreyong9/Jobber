# CV Adapter

Site statique qui adapte un CV `.docx` à une offre d'emploi, en gardant
exactement la mise en page d'origine (styles, polices, tableaux, photo) —
seuls les textes de contenu (résumé, descriptions de poste, compétences)
sont reformulés.

## Deux moteurs au choix

- **💻 CPU, dans le navigateur** ([transformers.js](https://huggingface.co/docs/transformers.js), WASM) —
  100 % privé, rien ne quitte la machine. Plus lent (quelques minutes pour
  un CV complet). N'utilise **pas** WebGPU : ce chemin évite entièrement la
  classe de bugs de pilote GPU (`DEVICE_REMOVED`, `already been disposed`)
  qui touche WebGPU/Dawn sur certaines configurations.
- **☁️ GPU distant, via Hugging Face** ([Inference Providers](https://huggingface.co/docs/inference-providers),
  API compatible OpenAI) — rapide (quelques secondes par CV), mais le CV et
  l'annonce sont envoyés aux serveurs de Hugging Face / de son fournisseur
  d'inférence. Nécessite un token API Hugging Face gratuit.

Le choix se fait directement dans l'interface, à chaque utilisation.

## Architecture : l'orchestrateur décide, le modèle rédige

1. **Lecture** : le `.docx` est ouvert comme une archive zip
   ([JSZip](https://stuk.github.io/jszip/)), `word/document.xml` est parsé
   comme du XML natif (`DOMParser`).
2. **Classification déterministe (le code, pas le modèle)** : chaque
   segment de texte ("run" Word) est classé par des règles simples, sans
   aucun appel au modèle — gras/court/coordonnées/sections
   formation-langues-autres restent toujours figés ; seuls le résumé, les
   compétences, les descriptions de missions et le titre d'accroche sont
   proposés à la reformulation.
3. **Réécriture segment par segment** : chaque segment retenu est envoyé
   individuellement au modèle (texte court, réponse libre) avec l'offre
   d'emploi. Si un segment échoue, il est simplement laissé inchangé — le
   reste de la passe continue.
4. **Écriture** : seul le texte (`<w:t>`) du segment est remplacé, sa mise
   en forme (police, couleur, gras) reste l'élément XML original intact.
5. **Réassemblage** : le zip est reconstruit avec ce `document.xml`
   modifié et proposé au téléchargement.

## Continuer à améliorer

Après une première passe, un bouton « Continuer à améliorer ce CV » relance
une nouvelle passe de reformulation directement sur le document déjà
modifié, sans jamais perdre la mise en page d'origine.

## Déploiement automatique sur GitHub Pages

Ce repo contient un workflow (`.github/workflows/deploy.yml`) qui déploie
automatiquement sur GitHub Pages à chaque push sur `main`.

1. Pousse ce repo sur GitHub (`main` comme branche par défaut).
2. Dans **Settings → Pages**, source **GitHub Actions**.
3. Pousse un commit sur `main` : le site est déployé sur
   `https://<ton-user>.github.io/<nom-du-repo>/`.

Aucune étape de build : HTML/CSS/JS pur. Les librairies externes
([JSZip](https://stuk.github.io/jszip/), [transformers.js](https://huggingface.co/docs/transformers.js))
sont chargées depuis un CDN directement dans le navigateur.

## Obtenir un token Hugging Face (pour le moteur ☁️)

1. Va sur [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained)
2. Crée un token à granularité fine avec la permission **"Make calls to
   Inference Providers"**
3. Colle-le dans le champ prévu dans l'app — il est stocké uniquement dans
   le `localStorage` de ton navigateur, jamais ailleurs.

Le modèle par défaut (`meta-llama/Llama-3.2-3B-Instruct:fastest`) peut ne
pas être disponible selon ton compte/quota — dans ce cas, change-le pour un
autre modèle listé sur [huggingface.co/models](https://huggingface.co/models?inference_provider=all&pipeline_tag=text-generation).

## Limites à connaître

- Le moteur CPU télécharge le modèle au premier lancement (quelques
  centaines de Mo), puis le garde en cache navigateur.
- La classification des segments repose sur des heuristiques (gras,
  taille, mots-clés de section, motifs de contact) qui couvrent bien les
  CV classiques mais peuvent se tromper sur une mise en page très
  inhabituelle — relis toujours le résultat avant de l'envoyer.
- Le modèle est prompté pour ne pas inventer de fait absent du CV
  original, mais comme tout LLM il peut se tromper.
- Avec le moteur Hugging Face, la disponibilité et la vitesse dépendent du
  fournisseur d'inférence choisi et de ton quota/compte.

## Structure du repo

```
index.html                  page unique
style.css                   styles
app.js                      logique (classification, édition XML, moteurs WASM/HF, réassemblage)
.github/workflows/deploy.yml   CI de déploiement Pages
```
