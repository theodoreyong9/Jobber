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
    el('button', { class: 'role-card', onclick: () => onSelect('candidate') },
      [el('strong', { text: 'Trouver une opportunité' }), el('span', { text: 'Déposer un CV, découvrir des annonces pertinentes.' })]),
    el('button', { class: 'role-card', onclick: () => onSelect('recruiter') },
      [el('strong', { text: 'Trouver des candidats' }), el('span', { text: 'Publier une ou plusieurs annonces, découvrir des profils pertinents.' })]),
  ]));
}

function roleHeader(label, onChangeRole) {
  return el('div', { style: 'display:flex; justify-content:space-between; align-items:baseline; margin-bottom:0.3rem;' }, [
    el('span', { style: 'color:var(--muted); font-size:0.85rem;', text: label }),
    el('button', { class: 'link-button', style: 'color:var(--copper);', onclick: onChangeRole, text: 'Changer de rôle' }),
  ]);
}

function modelSection({ webgpuAvailable, models, onLoadModel }) {
  const modelSelect = el('select', { class: 'model-select' }, [
    el('option', { value: '', text: '— pas de modèle local —' }),
    ...models.map((m) => el('option', { value: m.id, text: `${m.label} · ~${(m.approxDownloadMb / 1000).toFixed(1)} Go` })),
  ]);
  const semanticCheckbox = el('input', { type: 'checkbox' });
  const section = el('div', {}, [
    el('div', { class: 'section-title', text: 'Intelligence locale (optionnel)' }),
    webgpuAvailable
      ? el('div', {}, [
          modelSelect,
          el('button', { class: 'btn secondary', onclick: () => onLoadModel(modelSelect.value), text: 'Charger le modèle' }),
          el('div', { class: 'model-status', id: 'model-status' }),
        ])
      : el('p', { class: 'lede', text: 'WebGPU indisponible dans ce navigateur : le matching déterministe (CPU) reste utilisable, sans compréhension sémantique fine.' }),
    el('label', { class: 'checkbox-row' }, [semanticCheckbox, 'Utiliser l\'analyse sémantique WebLLM si le modèle est chargé']),
  ]);
  return { section, semanticCheckbox };
}

/** Formulaire d'upload générique (CV pour candidat, une annonce pour recruteur). */
function uploadForm({ isCandidate, onSubmit, submitLabel }) {
  const nameInput = el('input', {
    type: 'text',
    placeholder: isCandidate ? 'Nom affiché aux recruteurs (optionnel)' : 'Intitulé du poste / entreprise (optionnel)',
    style: 'width:100%; border:1px solid var(--line); border-radius:3px; padding:0.5rem 0.7rem; font-family:var(--sans); margin-bottom:0.6rem;',
  });
  const fileInput = el('input', { type: 'file', accept: '.docx,.txt' });
  const pasteArea = el('textarea', { class: 'paste-area', placeholder: isCandidate ? 'Ou collez le texte de votre CV ici…' : 'Collez le texte de l\'annonce ici…' });

  return el('div', {}, [
    nameInput,
    el('div', { class: 'dropzone' }, [
      el('div', { text: isCandidate ? 'Déposez un fichier .docx / .txt, ou collez le texte ci-dessous.' : 'Collez le texte de l\'offre, ou déposez un .docx / .txt.' }),
      fileInput,
    ]),
    pasteArea,
    el('button', {
      class: 'btn',
      text: submitLabel,
      onclick: () => onSubmit({
        file: fileInput.files[0],
        text: pasteArea.value.trim() ? pasteArea.value : undefined,
        displayName: nameInput.value.trim() || null,
      }),
    }),
  ]);
}

// --- Écran candidat (§14, §66) ---
export function renderCandidateWorkspace({ webgpuAvailable, models, onDocumentSubmit, onLoadModel, onResetLocalData, onChangeRole }) {
  const root = app();
  root.innerHTML = '';

  const { section: modelSectionEl, semanticCheckbox } = modelSection({ webgpuAvailable, models, onLoadModel });

  root.appendChild(el('div', {}, [
    roleHeader('Mode : candidat', onChangeRole),
    el('div', { class: 'section-title', text: 'Votre CV' }),
    uploadForm({
      isCandidate: true,
      submitLabel: 'Analyser et rechercher des opportunités',
      onSubmit: (input) => onDocumentSubmit({ ...input, useSemanticAnalysis: semanticCheckbox.checked }),
    }),

    modelSectionEl,

    el('div', { class: 'section-title', text: 'Annonces correspondantes' }),
    el('p', { class: 'lede', style: 'margin-top:-0.3rem;', text: 'Seules les annonces dont le score atteint le seuil fixé par le recruteur apparaissent ici — c\'est lui qui décide, en temps réel, qui peut voir son offre.' }),
    el('ul', { class: 'ledger', id: 'match-ledger' }, [el('li', { class: 'empty-state', text: 'Aucun résultat pour le moment.' })]),

    el('div', { class: 'section-title', text: 'Confidentialité' }),
    el('button', { class: 'btn secondary', text: 'Supprimer toutes mes données locales', onclick: onResetLocalData }),
  ]));

  root.appendChild(el('div', { id: 'detail-zone' }));
}

// --- Écran recruteur (§15, §67) : annonces multiples + curseur de seuil ---
export function renderRecruiterWorkspace({ webgpuAvailable, models, postings, onAddPosting, onLoadModel, onResetLocalData, onChangeRole, onRemovePosting, onThresholdInput, onThresholdCommit, onOpenCandidate }) {
  const root = app();
  root.innerHTML = '';

  const { section: modelSectionEl, semanticCheckbox } = modelSection({ webgpuAvailable, models, onLoadModel });
  let addFormVisible = postings.length === 0;

  const postingsContainer = el('div', { id: 'postings-container' });
  const addFormContainer = el('div', { id: 'add-posting-form' });

  function renderAddForm() {
    addFormContainer.innerHTML = '';
    if (!addFormVisible) {
      addFormContainer.appendChild(el('button', { class: 'btn secondary', text: '+ Nouvelle annonce', onclick: () => { addFormVisible = true; renderAddForm(); } }));
      return;
    }
    addFormContainer.appendChild(uploadForm({
      isCandidate: false,
      submitLabel: postings.length === 0 ? 'Publier cette annonce et rechercher des candidats' : 'Ajouter cette annonce',
      onSubmit: (input) => onAddPosting({ ...input, useSemanticAnalysis: semanticCheckbox.checked }),
    }));
    if (postings.length > 0) {
      addFormContainer.appendChild(el('button', { class: 'link-button', text: 'annuler', onclick: () => { addFormVisible = false; renderAddForm(); } }));
    }
  }
  renderAddForm();

  root.appendChild(el('div', {}, [
    roleHeader('Mode : recruteur', onChangeRole),
    el('div', { class: 'section-title', text: 'Mes annonces' }),
    postingsContainer,
    addFormContainer,
    modelSectionEl,
    el('div', { class: 'section-title', text: 'Confidentialité' }),
    el('button', { class: 'btn secondary', text: 'Supprimer toutes mes données locales', onclick: onResetLocalData }),
  ]));

  root.appendChild(el('div', { id: 'detail-zone' }));

  renderPostingsList(postings, { onRemovePosting, onThresholdInput, onThresholdCommit, onOpenCandidate });
}

/**
 * Affiche une carte par annonce : titre, curseur de seuil temps réel,
 * mini-ledger des candidats découverts (visibles / sous le seuil).
 */
export function renderPostingsList(postings, { onRemovePosting, onThresholdInput, onThresholdCommit, onOpenCandidate }) {
  const container = document.getElementById('postings-container');
  if (!container) return;
  container.innerHTML = '';

  if (postings.length === 0) {
    container.appendChild(el('p', { class: 'empty-state', text: 'Aucune annonce publiée pour le moment.' }));
    return;
  }

  for (const posting of postings) {
    const percentLabel = el('span', { class: 'threshold-value', text: `${posting.threshold}%` });
    const slider = el('input', {
      type: 'range', min: '0', max: '100', step: '5', value: String(posting.threshold),
      class: 'threshold-slider',
      oninput: (e) => { percentLabel.textContent = `${e.target.value}%`; onThresholdInput(posting.id, Number(e.target.value)); },
      onchange: (e) => onThresholdCommit(posting.id, Number(e.target.value)),
    });

    const visibleCount = posting.candidates.filter((c) => c.visible).length;

    const ledgerItems = posting.candidates.length === 0
      ? [el('li', { class: 'empty-state', text: 'Aucun candidat découvert pour le moment.' })]
      : posting.candidates.map((c) => el('li', {}, [
          el('button', {
            class: `ledger-row ${c.visible ? '' : 'below-threshold'}`,
            onclick: () => onOpenCandidate(c, posting),
          }, [
            el('span', { class: `ledger-score ${c.total < 50 ? 'weak' : ''}`, text: `${c.total}` }),
            el('span', {}, [
              el('div', { class: 'ledger-title', text: c.displayName || `Pair ${String(c.peerId).slice(0, 10)}…` }),
              el('div', { class: 'ledger-sub', text: c.visible ? 'Visible par ce candidat' : 'Sous le seuil — invisible pour ce candidat' }),
            ]),
            el('span', { class: 'ledger-chevron', text: '›' }),
          ]),
        ]));

    container.appendChild(el('div', { class: 'posting-card' }, [
      el('div', { style: 'display:flex; justify-content:space-between; align-items:baseline;' }, [
        el('strong', { style: 'font-family:var(--serif); font-size:1.1rem;', text: posting.title || 'Annonce sans titre' }),
        el('button', { class: 'link-button', style: 'color:var(--copper);', text: 'retirer', onclick: () => onRemovePosting(posting.id) }),
      ]),
      el('div', { class: 'threshold-row' }, [
        el('span', { class: 'threshold-label', text: 'Score minimum pour voir cette annonce et proposer un chat' }),
        el('div', { style: 'display:flex; align-items:center; gap:0.6rem;' }, [slider, percentLabel]),
        el('div', { class: 'lede', style: 'font-size:0.8rem; margin:0.2rem 0 0;', text: `${visibleCount} / ${posting.candidates.length} candidat(s) découvert(s) actuellement au-dessus du seuil` }),
      ]),
      el('ul', { class: 'ledger' }, ledgerItems),
    ]));
  }
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

// --- Ledger de matchs côté candidat (§34-36, §43) ---
export function renderMatchList(ranking, onOpen) {
  const list = document.getElementById('match-ledger');
  if (!list) return;
  list.innerHTML = '';
  if (ranking.length === 0) {
    list.appendChild(el('li', { class: 'empty-state', text: 'Recherche en cours… aucun résultat visible pour le moment.' }));
    return;
  }
  for (const entry of ranking) {
    list.appendChild(el('li', {}, [
      el('button', { class: 'ledger-row', onclick: () => onOpen(entry) }, [
        el('span', { class: `ledger-score ${scoreClass(entry)}`, text: `${entry.total}` }),
        el('span', {}, [
          el('div', { class: 'ledger-title', text: entry.blocked ? 'Bloqué par une contrainte' : (entry.postingTitle || entry.displayName || `Match ${entry.total}%`) }),
          el('div', { class: 'ledger-sub', text: `${entry.displayName ? entry.displayName + ' · ' : ''}Pair ${String(entry.peerId).slice(0, 8)}…` }),
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

  open(peerId, history, onSend, peerName) {
    const zone = document.getElementById('detail-zone');
    if (!zone) return;
    zone.innerHTML = '';
    zone.appendChild(el('div', { class: 'section-title', text: peerName ? `Conversation avec ${peerName}` : 'Conversation' }));

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
