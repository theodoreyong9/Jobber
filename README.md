# Jobber

Adapte un CV `.docx` à une ou plusieurs offres d'emploi **entièrement dans
le navigateur** — aucun serveur, aucune API, aucun compte. Le CV et les
offres ne quittent jamais l'appareil. La mise en page d'origine (styles,
polices, couleurs, tableaux, photo) est conservée à l'identique ; seuls
certains textes sont reformulés.

## Principe

Le code décide ce qui est autorisé à changer et pourquoi. Le modèle de
langage (LLM) ne fait que rédiger de courtes phrases, une à la fois, avec
un vocabulaire déjà validé. Rien n'est laissé à l'appréciation du modèle :
ni quelles parties du CV toucher, ni quels mots-clés utiliser, ni si le
résultat est acceptable — tout ça est décidé et vérifié par du code
déterministe, avant et après chaque appel au modèle.

Deux modèles locaux, deux rôles distincts :
- **[WebLLM](https://github.com/mlc-ai/web-llm)** (WebGPU) — rédige. Seul
  endroit du pipeline où du texte est généré.
- **[Transformers.js](https://github.com/huggingface/transformers.js)**
  (WASM/CPU) — calcule des embeddings pour affiner la pertinence CV ↔
  offre. Optionnel : si indisponible, le pipeline continue avec un
  matching par mots-clés seul. Tourne toujours en CPU, jamais en WebGPU,
  pour ne jamais se disputer le GPU avec WebLLM.

## Pipeline

```
CV (.docx)                                    OFFRE(S) D'EMPLOI (texte)
    │                                                  │
    ▼                                                  ▼
parsing local (JSZip + DOMParser)            extraction de mots-clés
    │                                        (fréquence, stopwords, fluff,
    ▼                                         synonymes — déterministe)
classification par rôle
(déterministe)                                         │
    │                                                   │
    ├── gelé : coordonnées, photo, diplômes,            │
    │   loisirs, lignes "poste — dates",                │
    │   listes de compétences...                        │
    │                                                   │
    └── éditable : titre / profil / description ────────┤
        de poste                                        │
              │                                          │
              ▼                                          │
    matching par segment ◄───────────────────────────────┘
    (mots-clés + embeddings si
     disponibles ; max 3 mots-clés
     retenus par segment)
              │
              ▼
    plan d'adaptation
    KEEP / LIGHT_REWRITE / STRONG_REWRITE
    (calculé et journalisé avant
     tout appel au modèle)
              │
     ┌────────┴─────────┐
     ▼                   ▼
      KEEP           LIGHT / STRONG
  → conservé tel        → WebLLM rédige
    quel, PAS envoyé       (1 segment, jusqu'à
    au modèle                3 mots-clés autorisés)
                              │
                              ▼
                    validateur local
                    - gabarit/offre recopiés ?
                    - longueur hors contrainte ?
                    - langue changée ?
                    - dérive hors-sujet ?
                    - fait/techno/chiffre inventé ?
                              │
                    rejeté → nouvelle tentative
                    accepté → écrit dans le CV
```

## Étapes

1. **Lecture** — le `.docx` est ouvert comme une archive zip (JSZip),
   `word/document.xml` est parsé comme du XML natif. Le texte original
   intact est conservé en mémoire : chaque offre traitée repart d'un clone
   frais de ce texte, jamais du résultat d'une offre précédente — les
   offres ne se contaminent jamais entre elles.

2. **Classification par rôle** (`classifyRuns()`) — chaque segment de
   texte est classé par des règles simples (gras, position, longueur, nom
   de section, motifs de contact) en :
   - **gelé** : nom, coordonnées, photo, diplômes/formation, langues,
     loisirs, lignes "poste — entreprise — dates", listes de
     compétences/technologies.
   - **éditable**, avec un rôle qui détermine la consigne donnée au
     modèle : `headline` (titre, 5 mots max), `profile` (résumé, ton
     affirmatif, 4 phrases max), `job-description` (mission, ton factuel,
     longueur équivalente). Chaque consigne inclut un exemple concret
     (extrait → réponse) — un petit modèle local suit un exemple bien
     plus fiablement qu'une règle de style abstraite.

3. **Extraction des mots-clés de l'offre** (`extractJobKeywords()`) —
   fréquence pondérée des termes (majuscules/acronymes comptent double),
   filtrage d'un stoplist de "fluff" d'annonce (Senior, Strong, Looking,
   Team...), détection de bigrammes techniques usuels (REST API, CI/CD,
   machine learning...). Le modèle ne reçoit jamais le texte complet de
   l'offre — seulement cette liste de mots-clés et un court extrait de
   contexte.

4. **Matching par segment** (`segmentKeywordMatches()`) — pour chaque
   description de poste, retient jusqu'à 3 mots-clés de l'offre ayant un
   vrai écho dans ce segment (racine de mot + petit dictionnaire de
   synonymes `SYNONYM_CLUSTERS` : `psql`/`PostgreSQL`, `AWS`/`Amazon`,
   `REST`/`RESTful`...). Un segment sans aucune correspondance n'est même
   pas envoyé au modèle. Si un modèle d'embeddings a pu se charger, un
   score de similarité cosinus vient s'ajouter au comptage de mots-clés —
   la décision retenue est toujours la plus "forte" des deux signaux.

5. **Plan d'adaptation** (`buildAdaptationPlan()`) — calculé une fois pour
   tout le CV, avant tout appel au modèle : `KEEP` (non pertinent),
   `LIGHT_REWRITE` (budget de sortie réduit) ou `STRONG_REWRITE` (plein
   budget) pour chaque description de poste. Seule source de vérité
   utilisée ensuite par les prompts et le validateur.

6. **Réécriture** (`rewriteSegment()`) — un appel au modèle par segment,
   séquentiel : le rôle, jusqu'à 3 mots-clés autorisés, l'extrait — rien
   de plus. En cas de perte du contexte GPU, le moteur est rechargé et le
   segment retenté, dans la limite d'un budget global de tentatives pour
   toute la série d'offres.

7. **Validation locale** (`validateSegmentOutput()`), sur chaque sortie
   avant acceptation :
   - rejette un texte qui recopie le gabarit du prompt ou un passage de
     l'offre ;
   - rejette un titre/profil hors contrainte de longueur ;
   - rejette toute sortie dans la mauvaise langue : la cible est celle de
     **l'offre** (détectée une fois pour toute l'adaptation), pas
     forcément celle de l'extrait d'origine — un CV en anglais qui
     postule à une offre en français est reformulé en français. Repli sur
     la langue de l'extrait d'origine si celle de l'offre n'a pas pu être
     déterminée ;
   - rejette un titre ou un profil ayant dérivé au point de ne garder
     presque aucun mot en commun avec l'original (fabrication générique
     ou hors-sujet — le seuil tient compte de leur brièveté) ;
   - rejette toute description de poste mentionnant une technologie, un
     nom propre ou un chiffre absent de l'extrait original
     (`validateFactsPreserved`).

   Règle absolue, revérifiée indépendamment de tout matching en amont :
   un mot-clé présent uniquement dans l'offre ne devient jamais un fait
   autorisé pour le CV — il doit aussi avoir une présence dans le texte
   original du candidat. Un segment rejeté est retenté (jusqu'à 3 fois) ;
   s'il échoue encore, il reste inchangé plutôt que d'injecter du texte
   incorrect.

8. **Écriture** — seul le texte (`<w:t>`/`<w:br/>`) du segment est
   remplacé ; sa mise en forme (police, couleur, gras) reste l'élément XML
   d'origine intact.

9. **Réassemblage** — le zip est reconstruit avec ce `document.xml`
   modifié et proposé au téléchargement, un fichier par offre traitée.

## Plusieurs offres à la suite

Le modèle (WebLLM) est chargé **une seule fois** pour toute la série
d'offres collées, pas une fois par offre — le rechargement d'un modèle de
plusieurs centaines de Mo à chaque offre serait inutilement coûteux. Le
moteur et son Worker dédié sont explicitement détruits (`resetWebllmState()`)
une fois la série entière terminée, pas entre deux offres. Chaque offre
produit son propre fichier `.docx`, indépendant des autres.

## Fiabilité face à un GPU/pilote instable

WebLLM tourne entièrement sur le GPU via WebGPU, et certains GPU/pilotes
peuvent perdre le contexte en cours d'inférence (`DXGI_ERROR_DEVICE_HUNG`,
"Device lost"). Le pipeline est conçu pour survivre à ça :

- un appel au modèle = un segment (pas de lot groupé) : plus petit, plus
  rapide à générer, moins de risque de dépasser le seuil de patience du
  pilote (TDR — les GPU intégrés y sont particulièrement sensibles) ;
- rechargement automatique du moteur avec un budget de tentatives global
  pour toute la série, réellement utilisé jusqu'au bout ;
- "reprises" complètes en fin de série sur tout ce qui a échoué (2
  tentatives par segment, jusqu'à 3 reprises), jusqu'à ce que tout soit
  traité ou qu'un plafond de sécurité soit atteint — plafonné pour éviter
  qu'un segment récalcitrant ne cumule des dizaines d'appels à lui seul ;
- verrou d'interface dédié : le bouton "Adapter mon CV" reste désactivé du
  premier au dernier instant, même pendant les rechargements internes,
  pour empêcher un double-clic de lancer deux séries en parallèle.

## Utilisation

1. Charge un `.docx`.
2. Colle une offre d'emploi (bouton "+ Ajouter une offre" pour en traiter
   plusieurs à la suite sur ce même CV).
3. Choisis un modèle (Auto / Petit / Moyen / Grand).
4. Clique sur **Adapter mon CV** : le modèle se charge automatiquement,
   puis chaque offre est traitée à son tour. Un fichier par offre.

Le premier chargement télécharge le modèle (quelques centaines de Mo à
plusieurs Go selon la taille choisie), puis il reste en cache navigateur.

## Déploiement sur GitHub Pages

Ce repo contient un workflow (`.github/workflows/deploy.yml`) qui déploie
automatiquement sur GitHub Pages à chaque push sur `main`.

1. Pousse ce repo sur GitHub (`main` comme branche par défaut).
2. Dans **Settings → Pages**, source **GitHub Actions**.
3. Pousse un commit sur `main` : le site est déployé sur
   `https://<ton-user>.github.io/<nom-du-repo>/`.

Aucune étape de build : HTML/CSS/JS pur, bibliothèques chargées depuis un
CDN directement dans le navigateur.

## Limites à connaître

- **Classification par heuristiques** : couvre bien les CV classiques,
  peut se tromper sur une mise en page très inhabituelle — relire le
  résultat avant de l'envoyer.
- **Extraction de mots-clés et matching approximatifs** : fréquence +
  racine de mot + un petit dictionnaire de synonymes ; les embeddings
  affinent la pertinence globale mais n'en font pas une vraie analyse
  sémantique complète.
- **Modèle local, donc plus faible qu'un modèle cloud** : même avec les
  garde-fous anti-invention, une reformulation peut rester maladroite —
  relire le résultat.
- **GPU/pilote instable** : sur certaines machines, l'inférence WebGPU
  peut planter fréquemment ; le pipeline retente automatiquement, mais un
  segment peut rester inchangé faute de mieux. Mettre à jour les pilotes
  GPU et vérifier `chrome://gpu` (accélération matérielle active) aide.
- **Compétences/technologies gelées par design** : jamais reformulées,
  même si l'offre en mentionne d'autres — pour ne jamais risquer d'ajouter
  une compétence non maîtrisée par la personne.

## Structure du repo

```
index.html                  page unique
style.css                   styles
app.js                      logique complète : parsing/écriture XML,
                             classification par rôle, extraction de
                             mots-clés, matching, plan d'adaptation,
                             moteur WebLLM (chargement, récupération GPU),
                             prompts par rôle, validation, réassemblage
.github/workflows/deploy.yml   CI de déploiement Pages
```
