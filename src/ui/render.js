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
      [el('strong', { text: 'Je suis candidat' }), el('span', { text: 'Déposer mon CV et être trouvé par des recruteurs.' })]),
    el('button', { class: 'role-card', onclick: () => onSelect('recruiter') },
      [el('strong', { text: 'Je suis annonceur' }), el('span', { text: 'Publier une ou plusieurs annonces et chercher des candidats en direct.' })]),
  ]));
}

/** Bandeau d'identité persistante, visible en haut de chaque espace de travail. */
function identityBar({ identity, onSaveName, onChangeRole }) {
  const nameInput = el('input', {
    type: 'text', value: identity.displayName || '', placeholder: 'Votre nom',
    style: 'border:1px solid var(--line); border-radius:3px; padding:0.35rem 0.6rem; font-family:var(--sans); font-size:0.85rem; width:160px;',
  });
  const save = () => onSaveName(nameInput.value.trim());
  nameInput.addEventListener('blur', save);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(); nameInput.blur(); } });

  return el('div', { class: 'identity-bar' }, [
    el('div', { style: 'display:flex; align-items:center; gap:0.5rem;' }, [
      el('span', { style: 'color:var(--muted); font-size:0.8rem;', text: 'Vous :' }),
      nameInput,
      el('span', { class: 'identity-id', text: `id ${identity.id}` }),
    ]),
    el('button', { class: 'link-button', style: 'color:var(--copper);', onclick: onChangeRole, text: 'Changer de rôle' }),
  ]);
}

// --- Écran candidat (§14, §66) : dépôt du CV + diffusion en direct ---
export function renderCandidateWorkspace({ identity, isLive, onSaveName, onChangeRole, onStartLive, onResetLocalData }) {
  const root = app();
  root.innerHTML = '';

  const keywordInput = el('input', {
    type: 'text',
    placeholder: 'Ex. Data Engineer, Python, Comptabilité…',
    style: 'width:100%; border:1px solid var(--line); border-radius:3px; padding:0.5rem 0.7rem; font-family:var(--sans); margin-bottom:0.6rem;',
  });
  const fileInput = el('input', { type: 'file', accept: '.docx,.txt' });
  const fileLabel = el('span', { class: 'lede', style: 'display:block; margin-top:0.4rem;', text: 'Aucun fichier sélectionné.' });
  fileInput.addEventListener('change', () => {
    fileLabel.textContent = fileInput.files[0] ? `Sélectionné : ${fileInput.files[0].name}` : 'Aucun fichier sélectionné.';
  });

  root.appendChild(el('div', {}, [
    identityBar({ identity, onSaveName, onChangeRole }),
    el('div', { class: 'section-title', text: 'Ce que vous cherchez' }),
    keywordInput,
    el('p', { class: 'lede', style: 'margin-top:-0.4rem;', text: 'Un seul mot-clé : c\'est lui qui décide quelles annonces analyseront votre profil — ça évite de submerger les recruteurs hors sujet.' }),

    el('div', { class: 'section-title', text: 'Votre CV' }),
    el('div', { class: 'dropzone' }, [
      el('div', { text: 'Déposez votre CV (.docx ou .txt) — le fichier reste local, il ne sera transmis qu\'aux recruteurs auxquels vous répondrez.' }),
      fileInput,
    ]),
    fileLabel,

    el('button', {
      class: 'btn',
      text: isLive ? '🔴 En direct — recherche en cours' : 'Rechercher en direct',
      disabled: isLive ? 'true' : undefined,
      onclick: () => { if (fileInput.files[0] && keywordInput.value.trim()) onStartLive(fileInput.files[0], keywordInput.value.trim()); },
    }),
    !isLive ? el('p', { class: 'lede', style: 'margin-top:0.4rem;', text: 'Mot-clé requis avant de lancer la recherche. Votre CV est analysé localement, puis vos mots-clés sont diffusés aux annonceurs connectés.' }) : null,

    el('div', { class: 'section-title', text: 'Propositions reçues' }),
    el('ul', { class: 'ledger', id: 'proposal-ledger' }, [el('li', { class: 'empty-state', text: isLive ? 'En attente de propositions…' : 'Lancez la recherche en direct pour être visible.' })]),

    el('div', { class: 'section-title', text: 'Confidentialité' }),
    el('button', { class: 'btn secondary', text: 'Supprimer toutes mes données locales', onclick: onResetLocalData }),
  ]));

  root.appendChild(el('div', { id: 'detail-zone' }));
}

/** Liste des propositions (chat / rendez-vous) reçues côté candidat. */
export function renderProposalList(proposals, { onAccept, onDecline }) {
  const list = document.getElementById('proposal-ledger');
  if (!list) return;
  list.innerHTML = '';
  if (proposals.length === 0) {
    list.appendChild(el('li', { class: 'empty-state', text: 'Aucune proposition pour le moment.' }));
    return;
  }
  for (const p of proposals) {
    const isMeeting = p.type === 'meeting_proposal';
    list.appendChild(el('li', { class: 'proposal-card' }, [
      el('div', { class: 'ledger-title', text: p.fromName ? `${p.fromName}${p.roomTitle ? ' · ' + p.roomTitle : ''}` : `Pair ${p.peerId.slice(0, 10)}…` }),
      el('div', { class: 'ledger-sub', text: isMeeting ? (p.note ? `Propose un rendez-vous : ${p.note}` : 'Propose un rendez-vous.') : 'Propose d\'ouvrir un chat.' }),
      el('div', { style: 'margin-top:0.5rem;' }, [
        el('button', { class: 'btn', text: 'Accepter', onclick: () => onAccept(p) }),
        el('button', { class: 'btn secondary', text: 'Refuser', onclick: () => onDecline(p) }),
      ]),
    ]));
  }
}

// --- Écran recruteur (§15, §67) : salles d'annonce multiples ---
export function renderRecruiterWorkspace({ identity, rooms, onSaveName, onChangeRole, onCreateRoom, onResetLocalData }) {
  const root = app();
  root.innerHTML = '';

  const titleInput = el('input', {
    type: 'text', placeholder: 'Intitulé du poste (ex. Data Engineer senior)',
    style: 'width:100%; border:1px solid var(--line); border-radius:3px; padding:0.5rem 0.7rem; font-family:var(--sans); margin-bottom:0.5rem;',
  });
  const textArea = el('textarea', { class: 'paste-area', placeholder: 'Collez ici le texte de l\'annonce…', style: 'min-height:110px;' });

  const formContainer = el('div', { id: 'add-room-form' }, [
    titleInput,
    textArea,
    el('button', {
      class: 'btn',
      text: 'Publier et rechercher en direct',
      onclick: () => {
        if (!textArea.value.trim()) return;
        onCreateRoom({ title: titleInput.value.trim() || null, text: textArea.value });
        titleInput.value = '';
        textArea.value = '';
      },
    }),
  ]);

  root.appendChild(el('div', {}, [
    identityBar({ identity, onSaveName, onChangeRole }),
    el('div', { class: 'section-title', text: 'Nouvelle salle d\'annonce' }),
    formContainer,
    el('div', { class: 'section-title', text: 'Mes salles d\'annonce' }),
    el('div', { id: 'rooms-container' }),
    el('div', { class: 'section-title', text: 'Confidentialité' }),
    el('p', { class: 'lede', style: 'margin-top:-0.3rem;', text: 'Le texte de vos annonces reste local : seuls des mots-clés de comparaison sont utilisés, jamais publiés.' }),
    el('button', { class: 'btn secondary', text: 'Supprimer toutes mes données locales', onclick: onResetLocalData }),
  ]));

  root.appendChild(el('div', { id: 'detail-zone' }));
  renderRoomsList(rooms, {});
}

/** Affiche une carte par salle d'annonce : ledger des candidats triés par score, CV en pièce jointe. */
export function renderRoomsList(rooms, { onOpenCandidate, onRemoveRoom } = {}) {
  const container = document.getElementById('rooms-container');
  if (!container) return;
  container.innerHTML = '';

  if (rooms.length === 0) {
    container.appendChild(el('p', { class: 'empty-state', text: 'Aucune salle d\'annonce publiée pour le moment.' }));
    return;
  }

  for (const room of rooms) {
    const ledgerItems = room.candidates.length === 0
      ? [el('li', { class: 'empty-state', text: '🔴 En direct — en attente de candidats…' })]
      : room.candidates.map((c) => el('li', {}, [
          el('button', { class: 'ledger-row', onclick: () => onOpenCandidate?.(c, room) }, [
            el('span', { class: `ledger-score ${c.total < 50 ? 'weak' : ''}`, text: `${c.total}` }),
            el('span', {}, [
              el('div', { class: 'ledger-title', text: c.displayName || `Pair ${String(c.peerId).slice(0, 10)}…` }),
              el('div', { class: 'ledger-sub', text: c.cvFileName ? `📎 ${c.cvFileName}` : 'CV en cours de réception…' }),
            ]),
            el('span', { class: 'ledger-chevron', text: '›' }),
          ]),
        ]));

    container.appendChild(el('div', { class: 'posting-card' }, [
      el('div', { style: 'display:flex; justify-content:space-between; align-items:baseline;' }, [
        el('strong', { style: 'font-family:var(--serif); font-size:1.1rem;', text: room.title || 'Annonce sans titre' }),
        el('button', { class: 'link-button', style: 'color:var(--copper);', text: 'retirer', onclick: () => onRemoveRoom?.(room.id) }),
      ]),
      room.text ? el('details', { class: 'room-text-details' }, [
        el('summary', { text: 'Voir le texte publié' }),
        el('p', { class: 'room-text-preview', text: room.text }),
      ]) : null,
      el('div', { class: 'lede', style: 'font-size:0.8rem; margin:0.4rem 0 0.6rem;', text: `${room.candidates.length} candidat(s) découvert(s), classés par score` }),
      el('ul', { class: 'ledger' }, ledgerItems),
    ]));
  }
}

// --- Détail d'un match côté recruteur : score, CV téléchargeable, actions ---
export function renderCandidateDetail(entry, { onOpenChat, onProposeMeeting, onBlockPeer, onIgnorePeer, cvUrl }) {
  const zone = document.getElementById('detail-zone');
  if (!zone) return;
  zone.innerHTML = '';

  const dims = Object.entries(entry.dimensions).map(([k, v]) =>
    el('div', { class: 'dimension-row' }, [el('span', { text: k }), el('span', { text: `${v}` })])
  );
  const reasons = entry.reasons.map((r) =>
    el('div', { class: `reason ${r.type}` }, [r.label])
  );

  const meetingNote = el('input', { type: 'text', placeholder: 'Message ou créneau proposé (optionnel)…', style: 'width:100%; border:1px solid var(--line); border-radius:3px; padding:0.5rem 0.7rem; font-family:var(--sans); margin:0.5rem 0;' });

  zone.appendChild(el('div', { class: 'section-title', text: entry.displayName || 'Détail du candidat' }));
  zone.appendChild(el('div', { class: 'match-detail' }, [
    el('div', { class: 'score-stamp', text: `${entry.total}%` }),
    cvUrl
      ? el('a', { href: cvUrl, download: entry.cvFileName || 'cv', class: 'btn secondary', style: 'display:inline-block; text-decoration:none;', text: `📎 Télécharger le CV (${entry.cvFileName || 'fichier'})` })
      : el('p', { class: 'lede', text: 'CV en cours de réception…' }),
    el('div', { style: 'margin-top:0.8rem;' }, dims),
    el('div', { class: 'section-title', text: 'Pourquoi ce score ?' }),
    el('div', {}, reasons),
    el('button', { class: 'btn', text: 'Ouvrir un chat', onclick: onOpenChat }),
    meetingNote,
    el('button', { class: 'btn secondary', text: 'Proposer un rendez-vous', onclick: () => onProposeMeeting(meetingNote.value.trim()) }),
    el('button', { class: 'btn secondary', text: 'Ignorer ce profil', onclick: onIgnorePeer }),
    el('button', { class: 'btn secondary', text: 'Bloquer ce pair', onclick: onBlockPeer }),
  ]));
}

// --- Chat P2P (§38-41) ---
let chatElements = null;
export const renderChat = {
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
      el('div', { class: 'chat-input-row' }, [input, el('button', { class: 'btn', text: 'Envoyer', onclick: send })]),
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
