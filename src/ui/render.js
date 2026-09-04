// src/ui/render.js
//
// Rendu DOM vanilla (aucun framework, §4). Chaque fonction remplace le
// contenu de #app ou d'une zone dédiée. Volontairement simple : pas de
// diffing, l'app reste petite.

const app = () => document.getElementById('app');

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// --- Écran 1 : choix du rôle (§13, §65) ---
export function renderRoleSelect(onSelect) {
  const root = app();
  root.innerHTML = '';
  root.appendChild(el('div', { class: 'role-select' }, [
    el('h2', { text: 'Que cherchez-vous ?' }),
    el('p', { class: 'lede', text: 'Vos documents restent sur cet appareil. L\'analyse se fait localement, sans compte ni service cloud.' }),
    el('button', {
      class: 'role-card',
      onclick: () => onSelect('candidate'),
    }, [el('strong', { text: 'Trouver une opportunité' }), el('span', { text: 'Déposer un CV, découvrir des annonces pertinentes.' })]),
    el('button', {
      class: 'role-card',
      onclick: () => onSelect('recruiter'),
    }, [el('strong', { text: 'Trouver des candidats' }), el('span', { text: 'Déposer une annonce, découvrir des profils pertinents.' })]),
  ]));
}

// --- Écran 2 : espace de travail (upload + modèle + résultats) (§14-16, §66-67) ---
export function renderWorkspace({ role, webgpuAvailable, models, onDocumentSubmit, onLoadModel, onResetLocalData }) {
  const root = app();
  root.innerHTML = '';
  const isCandidate = role === 'candidate';

  const fileInput = el('input', { type: 'file', accept: '.docx,.txt' });
  const pasteArea = el('textarea', { class: 'paste-area', placeholder: isCandidate ? 'Ou collez le texte de votre CV ici…' : 'Collez le texte de l\'annonce ici…' });
  const semanticCheckbox = el('input', { type: 'checkbox', id: 'semantic-toggle' });

  const modelSelect = el('select', { class: 'model-select' }, [
    el('option', { value: '', text: '— pas de modèle local —' }),
    ...models.map((m) => el('option', { value: m.id, text: `${m.label} · ~${(m.approxDownloadMb / 1000).toFixed(1)} Go` })),
  ]);

  root.appendChild(el('div', {}, [
    el('div', { class: 'section-title', text: isCandidate ? 'Votre CV' : 'Votre annonce' }),
    el('div', { class: 'dropzone' }, [
      el('div', { text: isCandidate ? 'Déposez un fichier .docx / .txt, ou collez le texte ci-dessous.' : 'Collez le texte de l\'offre, ou déposez un .docx / .txt.' }),
      fileInput,
    ]),
    pasteArea,

    el('div', { class: 'section-title', text: 'Intelligence locale (optionnel)' }),
    webgpuAvailable
      ? el('div', {}, [
          modelSelect,
          el('button', { class: 'btn secondary', onclick: () => onLoadModel(modelSelect.value) , text: 'Charger le modèle'}),
          el('div', { class: 'model-status', id: 'model-status' }),
        ])
      : el('p', { class: 'lede', text: 'WebGPU indisponible dans ce navigateur : le matching déterministe (CPU) reste utilisable, sans compréhension sémantique fine.' }),
    el('label', { class: 'checkbox-row' }, [semanticCheckbox, 'Utiliser l\'analyse sémantique WebLLM si le modèle est chargé']),

    el('button', {
      class: 'btn',
      text: isCandidate ? 'Analyser et rechercher des opportunités' : 'Analyser et rechercher des candidats',
      onclick: () => onDocumentSubmit({
        file: fileInput.files[0],
        text: pasteArea.value.trim() ? pasteArea.value : undefined,
        useSemanticAnalysis: semanticCheckbox.checked,
      }),
    }),

    el('div', { class: 'section-title', text: isCandidate ? 'Annonces correspondantes' : 'Candidats correspondants' }),
    el('ul', { class: 'ledger', id: 'match-ledger' }, [el('li', { class: 'empty-state', text: 'Aucun résultat pour le moment.' })]),

    el('div', { class: 'section-title', text: 'Confidentialité' }),
    el('button', { class: 'btn secondary', text: 'Supprimer toutes mes données locales', onclick: onResetLocalData }),
  ]));

  // Zone dédiée pour le détail de match / chat, insérée après le workspace.
  root.appendChild(el('div', { id: 'detail-zone' }));
}

export function renderModelStatus(progress) {
  const node = document.getElementById('model-status');
  if (node) node.textContent = `${progress.text} (${Math.round((progress.progress ?? 0) * 100)}%)`;
}

function scoreClass(entry) {
  if (entry.blocked) return 'blocked';
  if (entry.total < 50) return 'weak';
  return '';
}

// --- Ledger de matchs (§34-36, §43) ---
export function renderMatchList(ranking, onOpen) {
  const list = document.getElementById('match-ledger');
  if (!list) return;
  list.innerHTML = '';
  if (ranking.length === 0) {
    list.appendChild(el('li', { class: 'empty-state', text: 'Recherche en cours… aucun résultat pour le moment.' }));
    return;
  }
  for (const entry of ranking) {
    list.appendChild(el('li', {}, [
      el('button', { class: 'ledger-row', onclick: () => onOpen(entry) }, [
        el('span', { class: `ledger-score ${scoreClass(entry)}`, text: `${entry.total}` }),
        el('span', {}, [
          el('div', { class: 'ledger-title', text: entry.blocked ? 'Bloqué par une contrainte' : `Match ${entry.total}%` }),
          el('div', { class: 'ledger-sub', text: `Pair ${String(entry.peerId || entry.jobId || entry.candidateId).slice(0, 10)}…` }),
        ]),
        el('span', { class: 'ledger-chevron', text: '›' }),
      ]),
    ]));
  }
}

// --- Détail d'un match, explication (§29, §59, §68) ---
export function renderMatchDetail(entry, { onProposeChat, onBlockPeer, onIgnorePeer }) {
  const zone = document.getElementById('detail-zone');
  if (!zone) return;
  zone.innerHTML = '';

  const dims = Object.entries(entry.dimensions).map(([k, v]) =>
    el('div', { class: 'dimension-row' }, [el('span', { text: k }), el('span', { text: `${v}` })])
  );

  const reasons = entry.reasons.map((r) =>
    el('div', { class: `reason ${r.type}` }, [
      r.label,
      r.provenance ? el('span', { class: 'provenance-tag', text: r.provenance }) : null,
    ])
  );

  zone.appendChild(el('div', { class: 'section-title', text: 'Détail du match' }));
  zone.appendChild(el('div', { class: 'match-detail' }, [
    el('div', { class: 'score-stamp', text: `${entry.total}%` }),
    el('p', { text: entry.blocked ? 'Une contrainte bloquante empêche ce match d\'être proposé au-delà d\'un score minimal.' : `Confiance de l'analyse : ${Math.round(entry.confidence * 100)}%` }),
    el('div', {}, dims),
    el('div', { class: 'section-title', text: 'Pourquoi ce score ?' }),
    el('div', {}, reasons),
    el('button', { class: 'btn', text: 'Proposer un échange', disabled: entry.blocked ? 'true' : undefined, onclick: onProposeChat }),
    el('button', { class: 'btn secondary', text: 'Ignorer ce profil', onclick: onIgnorePeer }),
    el('button', { class: 'btn secondary', text: 'Bloquer ce pair', onclick: onBlockPeer }),
  ]));
}

// --- Chat P2P (§38-41) ---
let chatElements = null;
export const renderChat = {
  showIncomingRequest(peerId, message, onRespond, onBlock) {
    const zone = document.getElementById('detail-zone');
    if (!zone) return;
    const banner = el('div', { class: 'match-detail' }, [
      el('p', { text: `Un pair (${peerId.slice(0, 10)}…) propose un échange.` }),
      el('button', { class: 'btn', text: 'Accepter', onclick: () => onRespond(true) }),
      el('button', { class: 'btn secondary', text: 'Refuser', onclick: () => onRespond(false) }),
      onBlock ? el('button', { class: 'btn secondary', text: 'Bloquer ce pair', onclick: onBlock }) : null,
    ]);
    zone.prepend(banner);
  },

  open(peerId, history, onSend) {
    const zone = document.getElementById('detail-zone');
    if (!zone) return;
    zone.innerHTML = '';
    zone.appendChild(el('div', { class: 'section-title', text: 'Conversation' }));

    const messages = el('div', { class: 'chat-messages' });
    for (const m of history) {
      messages.appendChild(el('div', { class: `chat-bubble ${m.senderId === 'me' ? 'me' : 'them'}`, text: m.text }));
    }

    const input = el('input', { type: 'text', placeholder: 'Écrire un message…' });
    const send = () => {
      if (!input.value.trim()) return;
      onSend(input.value.trim());
      input.value = '';
    };

    zone.appendChild(el('div', { class: 'chat-window' }, [
      messages,
      el('div', { class: 'chat-input-row' }, [
        input,
        el('button', { class: 'btn', text: 'Envoyer', onclick: send }),
      ]),
    ]));

    chatElements = { peerId, messages };
  },

  appendMessage(peerId, message) {
    if (!chatElements || chatElements.peerId !== peerId) return;
    chatElements.messages.appendChild(el('div', { class: `chat-bubble ${message.senderId === 'me' ? 'me' : 'them'}`, text: message.text }));
    chatElements.messages.scrollTop = chatElements.messages.scrollHeight;
  },
};

// --- Journal technique (§76) ---
export function renderLog(line) {
  const panel = document.getElementById('log-panel');
  const list = document.getElementById('log-list');
  if (!list) return;
  const item = document.createElement('li');
  item.textContent = line;
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;

  const openBtn = document.getElementById('log-open');
  const closeBtn = document.getElementById('log-toggle');
  if (openBtn && !openBtn.dataset.bound) {
    openBtn.dataset.bound = '1';
    openBtn.addEventListener('click', () => { panel.hidden = false; });
    closeBtn.addEventListener('click', () => { panel.hidden = true; });
  }
}
