# CV Adapter

Site statique qui adapte un CV `.docx` à une offre d'emploi **entièrement
dans le navigateur**, via [WebLLM](https://github.com/mlc-ai/web-llm)
(WebGPU) — aucun serveur, aucune API, aucun compte, aucun token. Le CV et
le texte de l'annonce ne quittent jamais l'appareil. La mise en page
d'origine (styles, polices, couleurs, tableaux, photo) est conservée à
l'identique — seuls certains textes sont reformulés.

## Le principe : le code décide ce qui est autorisé, le modèle rédige

L'idée centrale du projet : ne pas faire reposer la qualité du résultat
sur "un LLM assez intelligent pour tout bien faire tout seul". La majorité
du travail est déterministe (donc fiable, gratuite en calcul, prévisible)
et le LLM n'intervient que là où le langage naturel apporte vraiment
quelque chose — reformuler une phrase, pas décider quoi toucher.

```
CV (.docx)                                  OFFRE D'EMPLOI (texte collé)
    │                                                │
    ▼                                                ▼
parsing local (JSZip + DOMParser)          extraction de mots-clés
    │                                       (déterministe, sans LLM)
    ▼                                                │
classification par rôle                              │
(déterministe, sans LLM)                              │
    │                                                │
    ├── gelé (coordonnées, photo, diplômes,           │
    │   loisirs, lignes "poste — dates",              │
    │   listes de compétences...)                     │
    │                                                │
    └── éditable : titre / profil / description ──────┤
        de poste                                      │
              │                                        │
              ▼                                        │
    matching sémantique par segment ◄──────────────────┘
    (déterministe : quels mots-clés
     sont VRAIMENT pertinents ici ?)
              │
              ▼
    plan d'adaptation (déterministe)
    KEEP / LIGHT_REWRITE / STRONG_REWRITE
    — calculé et journalisé AVANT
      tout appel au modèle
              │
     ┌────────┴─────────┐
     ▼                   ▼
      KEEP           LIGHT / STRONG
  → conservé tel        → WebLLM reformule
    quel, PAS envoyé       (consigne + budget de
    au modèle                tokens selon l'action)
                              │
                              ▼
                    validateur local (garde-fou)
                    - gabarit de prompt recopié ?
                    - passage de l'offre recopié ?
                    - longueur hors contrainte ?
                    - fait/techno/chiffre inventé,
                      absent de l'original ?
                              │
                    rejeté → nouvelle tentative
                    accepté → écrit dans le CV
```

## Étapes en détail

1. **Lecture** : le `.docx` est ouvert comme une archive zip
   ([JSZip](https://stuk.github.io/jszip/)), `word/document.xml` est parsé
   comme du XML natif (`DOMParser`). Les sauts de ligne internes à un run
   Word (`<w:br/>`, utilisés par ex. pour une liste de compétences tapée
   avec Maj+Entrée) sont préservés, pas aplatis.

2. **Classification par rôle (déterministe, sans LLM)** — `classifyRuns()` :
   chaque segment de texte est classé par des règles simples (gras,
   position, longueur, nom de section, motifs de contact) en :
   - **gelé** : nom, coordonnées, photo, diplômes/formation, langues,
     loisirs, lignes "poste — entreprise — dates", listes de
     compétences/technologies — jamais touché.
   - **éditable**, avec un rôle précis qui détermine la consigne donnée au
     modèle : `headline` (titre du CV, 5 mots max), `profile` (résumé, ton
     affirmatif et enthousiaste, 4 phrases max), `job-description`
     (description de mission, ton factuel, longueur équivalente).

3. **Extraction des mots-clés de l'offre (déterministe, sans LLM)** —
   `extractJobKeywords()` : fréquence pondérée des termes de l'annonce
   (les mots avec majuscule/acronyme comptent double — technologies, noms
   propres), en excluant un stoplist de "fluff" typique d'annonce (Senior,
   Strong, Excellent, Looking, Team...) qui faussait sinon le classement
   juste parce que ces mots sont souvent capitalisés. Quelques bigrammes
   techniques usuels (REST API, CI/CD, machine learning, full-stack...)
   sont détectés en priorité pour ne pas les casser en deux mots-clés
   isolés qui perdraient leur sens. Le modèle ne reçoit **jamais** le
   texte complet de l'annonce, seulement cette liste de mots-clés + un
   court extrait de contexte — ça réduit la taille des prompts et empêche
   structurellement le modèle de recopier des phrases entières de l'offre
   à la place du CV.

4. **Matching sémantique par segment (déterministe, sans LLM)** —
   `segmentKeywordMatches()` : pour chaque description de poste, calcule
   lesquels des mots-clés de l'offre ont un vrai écho dans CE segment
   précis (comparaison par racine de mot, tolère les variantes
   morphologiques simples). Une description de poste sans **aucune**
   correspondance n'est même pas envoyée au modèle (décision *KEEP*) :
   zéro risque d'invention, zéro calcul GPU perdu dessus. Les autres
   reçoivent une consigne proportionnée à la force de la correspondance —
   cette note ciblée remplace même le bloc générique de contexte d'offre
   pour ce rôle (plus courte et plus pertinente qu'une liste de mots-clés
   identique envoyée à chaque appel).

   La quantité de contexte envoyée est volontairement minimisée et
   adaptée au rôle du segment (`formatJobContextForPrompt()`) : un titre
   (5 mots max) n'a besoin que d'un signal minimal, un profil d'un
   contexte réduit, une description de poste de sa seule note de
   correspondance. Mesuré : la surcharge fixe par appel (hors texte du CV
   lui-même) est passée d'environ 290 tokens à 70-140 selon le rôle — sur
   un GPU lent, chaque token de moins réduit le temps de calcul continu et
   donc le risque de dépasser le seuil de patience du pilote (TDR).

5. **Plan d'adaptation (déterministe, sans LLM)** — `buildAdaptationPlan()` :
   calculé une seule fois pour tout le CV, AVANT le moindre appel au
   modèle. Pour chaque description de poste, transforme le score de
   correspondance en une décision explicite et journalisée :
   `KEEP` (aucune correspondance, jamais envoyé au modèle),
   `LIGHT_REWRITE` (correspondance partielle, budget de sortie réduit —
   le texte n'a de toute façon pas vocation à beaucoup changer) ou
   `STRONG_REWRITE` (forte correspondance, plein budget). C'est la seule
   source de vérité utilisée ensuite par les prompts et le validateur —
   plus aucune décision dispersée à la volée dans chaque appel.

6. **Réécriture** — `rewriteSegment()` / réécriture groupée par lots
   homogènes (même rôle) pour limiter le nombre d'appels au modèle, avec
   repli automatique en appel individuel si un lot échoue.

7. **Validation locale (garde-fou)** — `validateSegmentOutput()`, exécutée
   sur *chaque* sortie du modèle avant acceptation :
   - rejette un texte qui recopie le gabarit du prompt ou un passage de
     l'offre d'emploi ;
   - rejette un titre/profil qui dépasse largement sa contrainte de
     longueur ;
   - rejette toute description de poste qui mentionne une technologie, un
     nom propre ou un chiffre absent de l'extrait original (`extractFacts`
     + `validateFactsPreserved`) — le garde-fou anti-hallucination.

   **Règle absolue, revérifiée localement et indépendamment de tout
   matching en amont** : un mot-clé présent uniquement dans l'offre
   d'emploi ne devient jamais un fait autorisé pour le CV, même s'il a été
   suggéré comme pertinent pour ce segment — il doit *aussi* avoir une
   présence (même approximative) dans le texte original du candidat.

   Un segment rejeté est retenté (nouvelle génération, jusqu'à 3 fois) ;
   s'il échoue encore, il est laissé inchangé plutôt que d'injecter du
   texte incorrect dans le CV final.

8. **Écriture** : seul le texte (`<w:t>`/`<w:br/>`) du segment est
   remplacé ; sa mise en forme (police, couleur, gras) reste l'élément XML
   d'origine intact.

9. **Réassemblage** : le zip est reconstruit avec ce `document.xml`
   modifié et proposé au téléchargement.

## Fiabilité face à un GPU/pilote instable

WebLLM tourne entièrement sur le GPU via WebGPU, et certains
GPU/pilotes (notamment sous Windows) peuvent perdre le contexte en cours
d'inférence (`DXGI_ERROR_DEVICE_HUNG`). Le pipeline est conçu pour
survivre à ça plutôt que d'abandonner :

- rechargement automatique du moteur avec budget de tentatives global
  (pas de boucle infinie, mais généreux — pas de contrainte de temps) ;
- appels au modèle volontairement courts (peu de tokens, lots limités à 3
  segments) pour réduire le temps de calcul GPU continu par appel et donc
  le risque de timeout (TDR) ;
- "reprises" complètes en fin de passe sur tout ce qui a échoué, avec un
  moteur neuf, jusqu'à ce que tout soit traité ou qu'un plafond de
  sécurité soit atteint ;
- verrou d'interface dédié : le bouton "Adapter mon CV" reste désactivé du
  premier au dernier instant d'une passe, même pendant les rechargements
  internes, pour empêcher un double-clic de lancer deux passes en
  parallèle sur le même document.

## Utilisation

1. Charge un `.docx`.
2. Colle le texte de l'offre d'emploi.
3. Choisis un modèle dans la liste (Auto / Petit / Moyen / Grand — plus
   gros = meilleure qualité mais plus de VRAM et de temps de
   téléchargement).
4. Clique sur **Adapter mon CV** : le modèle choisi se charge
   automatiquement s'il ne l'est pas déjà, puis l'adaptation démarre.
   Un seul bouton, un seul clic.

Le premier chargement télécharge le modèle (plusieurs centaines de Mo à
quelques Go selon la taille choisie), puis il reste en cache navigateur
pour les fois suivantes.

## Déploiement automatique sur GitHub Pages

Ce repo contient un workflow (`.github/workflows/deploy.yml`) qui déploie
automatiquement sur GitHub Pages à chaque push sur `main`.

1. Pousse ce repo sur GitHub (`main` comme branche par défaut).
2. Dans **Settings → Pages**, source **GitHub Actions**.
3. Pousse un commit sur `main` : le site est déployé sur
   `https://<ton-user>.github.io/<nom-du-repo>/`.

Aucune étape de build : HTML/CSS/JS pur. [JSZip](https://stuk.github.io/jszip/)
et [WebLLM](https://github.com/mlc-ai/web-llm) sont chargés depuis un CDN
directement dans le navigateur.

## Limites à connaître

- **Classification par heuristiques** : la détection gelé/éditable et le
  rôle (titre/profil/description) reposent sur des règles simples (gras,
  taille, mots-clés de section) qui couvrent bien les CV classiques mais
  peuvent se tromper sur une mise en page très inhabituelle — relis
  toujours le résultat avant de l'envoyer.
- **Extraction de mots-clés et matching approximatifs** : c'est une
  heuristique par fréquence + racine de mot, pas une vraie analyse
  sémantique (pas d'embeddings) — elle capture l'essentiel mais avec du
  bruit résiduel et sans comprendre les synonymes éloignés
  ("PostgreSQL"/"base de données relationnelle" ne seront pas reliés,
  par exemple).
- **Modèle local, donc plus faible qu'un modèle cloud** : même avec le
  garde-fou anti-invention, un petit modèle peut produire une
  reformulation maladroite ou décider de ne pas changer un segment
  pourtant pertinent — relis toujours le résultat.
- **GPU/pilote instable** : sur certaines machines (notamment Windows
  avec un GPU intégré ou des pilotes anciens), l'inférence WebGPU peut
  planter fréquemment. Le pipeline retente automatiquement, mais dans les
  cas extrêmes certains segments peuvent rester inchangés faute de mieux.
  Mettre à jour les pilotes GPU et vérifier `chrome://gpu` (accélération
  matérielle active) aide nettement.
- **Compétences/technologies "figées" par design** : les listes de
  compétences ne sont jamais reformulées, même si l'offre en mentionne
  d'autres — ce n'est pas un oubli, c'est pour ne jamais risquer d'ajouter
  une compétence non maîtrisée par la personne.

## Structure du repo

```
index.html                  page unique
style.css                   styles
app.js                      logique complète : parsing/écriture XML,
                             classification par rôle, extraction de
                             mots-clés, matching sémantique, moteur WebLLM
                             (chargement, récupération GPU), prompts par
                             rôle, validation/garde-fou, réassemblage
.github/workflows/deploy.yml   CI de déploiement Pages
```
