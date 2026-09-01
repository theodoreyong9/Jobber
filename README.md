# CV Adapter

Site statique, 100 % client, qui adapte un CV `.docx` à une offre d'emploi
en utilisant [WebLLM](https://github.com/mlc-ai/web-llm) (LLM exécuté dans
le navigateur via WebGPU) — aucun serveur, aucune donnée envoyée nulle part.

## Fonctionnement

1. Tu uploades ton CV `.docx` → le texte est extrait dans le navigateur avec
   [mammoth.js](https://github.com/mwilliamson/mammoth.js).
2. Tu colles le texte d'une offre d'emploi.
3. Un modèle (Llama 3.2 3B, Phi-3.5 mini ou Llama 3.1 8B, au choix) est
   téléchargé une seule fois et mis en cache par le navigateur, puis
   réécrit ton CV en intégrant les mots-clés de l'offre.
4. Un nouveau `.docx` est généré à la volée avec la librairie
   [`docx`](https://github.com/dolanmiu/docx) et proposé au téléchargement.

Tout se passe dans l'onglet du navigateur : pas de backend, pas de clé API,
rien n'est jamais uploadé sur un serveur.

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

Aucune étape de build n'est nécessaire : le site est du HTML/CSS/JS pur,
les librairies (`mammoth`, `docx`, `web-llm`) sont chargées depuis des CDN
(`jsdelivr`, `esm.sh`) directement dans le navigateur de l'utilisateur.

## Limites à connaître

- Nécessite un navigateur avec **WebGPU** (Chrome/Edge récents ; Safari et
  Firefox n'ont pas encore un support fiable).
- Le premier chargement du modèle télécharge plusieurs centaines de Mo à
  quelques Go selon le modèle choisi — c'est lent la première fois,
  quasi instantané ensuite grâce au cache du navigateur.
- Le nouveau `.docx` est généré avec une mise en forme simple et propre
  (titres, listes à puces) — il ne reproduit pas exactement la mise en
  page graphique du fichier original, il en réutilise le contenu.
- Le modèle est prompté pour ne pas inventer d'expérience ou de diplôme,
  mais comme tout LLM il peut se tromper : relis toujours le résultat
  avant de l'envoyer.
- Sur un GPU peu puissant ou avec peu de VRAM (typiquement un GPU intégré),
  le pilote graphique peut planter en cours d'inférence (erreur Windows
  `DXGI_ERROR_DEVICE_REMOVED` / "Device was lost" côté Chrome). Ce n'est
  pas un bug de l'app : c'est le pilote GPU qui abandonne un calcul trop
  long ou trop gourmand en mémoire. Une fois le device perdu, il faut
  **recharger complètement la page** (l'app ne peut pas récupérer un GPU
  mort depuis l'onglet). Si ça se reproduit :
  - choisis le modèle "très léger" (1B) ;
  - mets à jour tes pilotes graphiques (souvent la cause n°1) ;
  - si ton PC a deux GPU (intégré + dédié), force le navigateur sur le GPU
    dédié : *Paramètres Windows → Système → Affichage → Graphismes →
    ajoute chrome.exe/msedge.exe → Options → Performances élevées* ;
  - en dernier recours (avancé, nécessite un redémarrage) : Windows tue
    par défaut tout calcul GPU qui dépasse ~2 secondes sans réponse
    (mécanisme TDR). On peut l'assouplir en ajoutant une valeur DWORD
    `TdrDelay` (ex: `10`) sous
    `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`
    dans le Registre — à ne faire que si tu es à l'aise avec le Registre
    Windows.

## Structure du repo

```
index.html                  page unique
style.css                   styles
app.js                      logique (lecture docx, WebLLM, génération docx)
.github/workflows/deploy.yml   CI de déploiement Pages
```
