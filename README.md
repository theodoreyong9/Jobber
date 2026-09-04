# Jobber

**Adapt your CV. No account needed.**

Application web 100% statique et 100% client-side : elle adapte un CV `.docx`
au texte d'une ou plusieurs offres d'emploi, en réécrivant certaines
sections avec un modèle de langage qui tourne **directement dans le
navigateur** ([WebLLM](https://github.com/mlc-ai/web-llm), via WebGPU).
Aucun serveur, aucun compte, aucune donnée envoyée nulle part.

## Démo

Une fois déployé sur GitHub Pages : `https://<ton-user>.github.io/<ton-repo>/`

Navigateur recommandé : Chrome ou Edge récent (support WebGPU requis).

## Déploiement automatique (le "bot")

Ce repo contient `.github/workflows/deploy.yml` : à chaque `push` sur `main`,
GitHub Actions publie automatiquement le contenu du repo sur GitHub Pages.
Aucune étape de build n'est nécessaire (JS vanilla, pas de bundler).

Pour l'activer sur ton repo :

1. Crée un repo GitHub (public ou privé) et pousse ce dossier dedans :
   ```bash
   git init
   git add .
   git commit -m "Initial commit: Jobber"
   git branch -M main
   git remote add origin https://github.com/<ton-user>/<ton-repo>.git
   git push -u origin main
   ```
2. Dans le repo GitHub : **Settings → Pages → Build and deployment → Source
   → "GitHub Actions"**.
3. Le premier push déclenche automatiquement le workflow. Le site est en
   ligne en 1-2 minutes, et se redéploie tout seul à chaque nouveau push.

## Architecture

```
index.html            interface (compacte, sombre, mobile-friendly)
css/style.css
js/
  main.js              orchestration du pipeline complet (étapes 4 à 18)
  docxParser.js         lecture du .docx (JSZip + DOMParser sur word/document.xml)
  sectionExtractor.js   heuristique de détection des sections du CV (étape 8)
  langDetect.js         détection de langue par fréquence de stopwords (étape 7)
  keywords.js            listes A (CV) et B (annonce) de mots-clés (étapes 9-10)
  semanticMatch.js       association A → B, CPU only, sans modèle (étape 11)
  llmClient.js            API thread principal vers le Web Worker WebLLM
  llmWorker.js            Web Worker isolé qui charge et exécute WebLLM (étape 18)
  docxWriter.js           réinjection du texte réécrit dans le XML d'origine (étapes 12-16)
  progress.js             barre de progression générale + journal technique (étape 17)
  stopwords.js            listes de mots vides FR/EN/ES/DE/IT/PT
```

### Pipeline (correspondance avec le cahier des charges)

1. **Titre** — `Jobber`.
2. **Sous-titre** — *Adapt your CV. No account needed.*
3. **Chargement du CV** — lecture du `.docx` entièrement dans le navigateur
   via [JSZip](https://stuk.github.io/jszip/) (aucun upload).
4. **Annonce(s)** — un ou plusieurs champs de texte, ajout dynamique.
5. **Choix du modèle WebLLM** — menu déroulant (Llama 3.2 3B, Phi-3.5 mini,
   Qwen2.5 7B).
6. **Bouton Go**.
7. **Détection de langue** — comptage de stopwords par langue candidate
   (`langDetect.js`), appliqué au CV et à chaque annonce séparément.
8. **Détection des sections du CV** — un paragraphe est retenu s'il
   contient une date, ou s'il est écrit dans la plus grande police du
   document, ou s'il fait plus de 10 mots ; il est ignoré s'il ressemble à
   des coordonnées, fait moins de 3 mots, ou est intégralement en gras
   (sauf s'il est dans la plus grande police). Les paragraphes écrits dans
   la plus grande police servent de titres de section.
9. **Liste A** — tous les mots-clés uniques des sections retenues du CV.
10. **Liste B** — par annonce, tous les mots-clés issus de phrases de plus
    de 3 mots.
11. **Association A → B** — pour chaque mot de la liste A, jusqu'à 3 mots
    de la liste B jugés proches (racine morphologique + similarité de
    bigrammes ; approche lexicale "CPU", volontairement sans modèle
    d'embedding pour rester simple et rapide — voir *Limites* ci-dessous).
12. **Prompt WebLLM** — pour chaque section, un prompt demande de réécrire
    le texte dans la langue de l'annonce, en utilisant les mots associés, en
    conservant tous les chiffres et ce qu'ils désignent.
13. **Réponse** — le Web Worker renvoie le texte réécrit au thread
    principal.
14. **Réinjection** — le texte est réinjecté dans le XML `word/document.xml`
    d'origine, run par run, sans toucher au reste du document.
15. **Conservation photos / mise en page** — seuls les `<w:t>` des
    paragraphes de section sont modifiés ; tout le reste du zip `.docx`
    (images, styles, en-têtes, sections `w:sectPr`...) reste identique.
16. **Téléchargement** — un `.docx` par annonce. Le texte est toujours écrit
    via `textContent` (jamais de concaténation de chaînes XML à la main),
    ce qui échappe automatiquement `& < >` et évite les "documents illisibles
    / réparation nécessaire" que Word affiche sur un XML mal formé.
17. **Indicateur d'avancement** — une seule barre de progression globale ;
    le détail du chargement du modèle et chaque étape technique vont dans le
    journal repliable ("Journal technique"), jamais dans une barre séparée.
18. **Nettoyage mémoire** — `llmClient.terminate()` décharge le moteur
    WebLLM (`engine.unload()`) puis détruit le Web Worker
    (`worker.terminate()` côté page + `self.close()` côté worker).

## Limites connues / pistes d'amélioration

- L'association "sémantique" (étape 11) est **lexicale**, pas basée sur des
  embeddings : elle capte bien les variantes morphologiques d'un même mot
  (FR/EN) mais pas les synonymes purs sans racine commune. On peut la
  remplacer par un petit modèle d'embeddings tournant lui aussi en local
  (ex. via `transformers.js`) sans changer le reste du pipeline —
  `semanticMatch.js` expose une seule fonction `associateKeywords(A, B)`
  à cet effet.
- La détection de langue est un vote de stopwords, robuste sur des textes de
  quelques phrases mais pas un détecteur de langue de qualité industrielle.
- La détection des sections repose sur des heuristiques de mise en forme
  (police, gras, longueur). Un CV très atypique (tableaux, colonnes
  multiples complexes) peut nécessiter des ajustements dans
  `sectionExtractor.js`.
- Testé pour des `.docx` "classiques" (Word/LibreOffice). Les `.doc`
  binaires ne sont pas supportés.

## Vie privée

Aucune donnée (CV, annonces, texte généré) ne quitte le navigateur. Le seul
trafic réseau est le téléchargement du modèle WebLLM (poids du modèle,
plusieurs centaines de Mo à quelques Go selon le modèle choisi, mis en
cache par le navigateur après le premier chargement) et des librairies JS
via CDN.

## Licence

MIT.
