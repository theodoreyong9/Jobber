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

/** Bloc "Confidentialité & identité", compact et repliable (bouton unique). */
function settingsSection({ onResetLocalData, onRestoreId, onInvalidateId }) {
  const idInput = el('input', {
    type: 'text', placeholder: 'Coller un ID pour restaurer cette identité…',
    style: 'width:100%; border:1px solid var(--line); border-radius:3px; padding:0.5rem 0.7rem; font-family:var(--sans); margin:0.4rem 0;',
  });
  return el('details', { class: 'settings-details' }, [
    el('summary', { text: '⚙ Confidentialité & identité' }),
    el('div', { class: 'settings-panel' }, [
      el('button', { class: 'btn secondary', text: 'Supprimer toutes mes données locales', onclick: onResetLocalData }),
      el('p', { class: 'lede', style: 'margin:0.5rem 0 0;', text: 'Supprime aussi votre ID actuel — il ne représentera plus personne.' }),

      el('p', { class: 'lede', style: 'margin:0.9rem 0 0.3rem; font-weight:600; color:var(--ink);', text: 'ID compromis ?' }),
      el('p', { class: 'lede', style: 'margin:0 0 0.4rem;', text: 'Génère un nouvel ID (nom conservé) ; si vous étiez en direct, les annonceurs connectés oublient immédiatement l\'ancien.' }),
      el('button', { class: 'btn secondary', text: 'Invalider mon ID', onclick: onInvalidateId }),

      el('p', { class: 'lede', style: 'margin:0.9rem 0 0.3rem;', text: 'Restaurer un ID noté ailleurs :' }),
      idInput,
      el('button', { class: 'btn secondary', text: 'Restaurer cet ID', onclick: () => { if (idInput.value.trim()) onRestoreId(idInput.value.trim()); } }),
    ]),
  ]);
}

// --- Écran candidat (§14, §66) : dépôt du CV + diffusion en direct ---
export function renderCandidateWorkspace({ identity, isLive, onSaveName, onChangeRole, onStartLive, onResetLocalData, onRestoreId, onInvalidateId }) {
  const root = app();
  root.innerHTML = '';

  const keywordInput = el('input', {
    type: 'text',
    placeholder: 'Ex. Data Engineer, Python, Comptabilité…',
    style: 'width:100%; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0.5rem 0.7rem; margin-bottom:0.5rem;',
  });
  const cityInput = el('input', {
    type: 'text',
    placeholder: 'Votre ville (optionnel)',
    style: 'width:100%; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0.5rem 0.7rem; margin-bottom:0.6rem;',
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
    cityInput,
    el('p', { class: 'lede', style: 'margin-top:-0.3rem;', text: 'Le mot-clé décide quelles annonces analyseront votre profil. La ville sert juste à signaler une correspondance, elle n\'est jamais comparée à une liste.' }),

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
      onclick: () => { if (fileInput.files[0] && keywordInput.value.trim()) onStartLive(fileInput.files[0], keywordInput.value.trim(), cityInput.value.trim() || null); },
    }),
    !isLive ? el('p', { class: 'lede', style: 'margin-top:0.4rem;', text: 'Mot-clé requis avant de lancer la recherche. Votre CV est analysé localement, puis vos mots-clés sont diffusés aux annonceurs connectés.' }) : null,

    el('div', { class: 'section-title', text: 'Propositions reçues' }),
    el('ul', { class: 'ledger', id: 'proposal-ledger' }, [el('li', { class: 'empty-state', text: isLive ? 'En attente de propositions…' : 'Lancez la recherche en direct pour être visible.' })]),

    settingsSection({ onResetLocalData, onRestoreId, onInvalidateId }),
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

// --- Écran recruteur (§15, §67) : salles d'annonce en onglets ---
export function renderRecruiterWorkspace({ identity, rooms, activeRoomId, onSaveName, onChangeRole, onCreateRoom, onResetLocalData, onRestoreId, onInvalidateId, onSelectRoom, onOpenCandidate, onRemoveRoom, webgpuAvailable, aiStatus, sortMode, onToggleAi, onSetSortMode }) {
  const root = app();
  root.innerHTML = '';

  let addFormVisible = rooms.length === 0;
  const addFormContainer = el('div', { id: 'add-room-form' });

  function renderAddForm() {
    addFormContainer.innerHTML = '';
    if (!addFormVisible) {
      addFormContainer.appendChild(el('button', { class: 'btn secondary', text: '+ Nouvelle salle d\'annonce', onclick: () => { addFormVisible = true; renderAddForm(); } }));
      return;
    }
    const titleInput = el('input', {
      type: 'text', placeholder: 'Intitulé du poste (ex. Data Engineer senior)',
      style: 'width:100%; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0.5rem 0.7rem; margin-bottom:0.5rem;',
    });
    const minYearsInput = el('input', {
      type: 'number', min: '0', max: '60', placeholder: 'Ancienneté minimale requise, en années (optionnel)',
      style: 'width:100%; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0.5rem 0.7rem; margin-bottom:0.5rem;',
    });
    const textArea = el('textarea', { class: 'paste-area', placeholder: 'Collez ici le texte de l\'annonce…', style: 'min-height:110px;' });
    addFormContainer.appendChild(el('div', { class: 'posting-card' }, [
      titleInput,
      minYearsInput,
      textArea,
      el('button', {
        class: 'btn',
        text: 'Publier et rechercher en direct',
        onclick: () => {
          if (!textArea.value.trim()) return;
          const minYears = minYearsInput.value.trim() ? Number(minYearsInput.value) : null;
          onCreateRoom({ title: titleInput.value.trim() || null, text: textArea.value, minYearsRequired: minYears });
          addFormVisible = rooms.length === 0; // se referme après publication s'il y avait déjà des salles
          renderAddForm();
        },
      }),
      rooms.length > 0 ? el('button', { class: 'link-button', text: 'annuler', onclick: () => { addFormVisible = false; renderAddForm(); } }) : null,
    ]));
  }
  renderAddForm();

  root.appendChild(el('div', {}, [
    identityBar({ identity, onSaveName, onChangeRole }),
    aiControlBlock({ webgpuAvailable, aiStatus, onToggleAi }),
    el('div', { id: 'room-tabs' }),
    addFormContainer,
    el('div', { id: 'room-content' }),
    el('p', { class: 'lede', style: 'margin:1rem 0 0;', text: 'Le texte de vos annonces reste local : seuls des mots-clés de comparaison sont utilisés, jamais publiés.' }),
    settingsSection({ onResetLocalData, onRestoreId, onInvalidateId }),
  ]));

  renderRoomsList(rooms, activeRoomId, { onSelectRoom, onOpenCandidate, onRemoveRoom, aiEnabled: aiStatus === 'ready', sortMode, onSetSortMode });
}

/**
 * Bloc de contrôle de la couche IA continue (§ demande : bouton optionnel).
 * Le classement CPU n'en dépend jamais — ce bloc ne fait qu'ajouter ou
 * retirer un score supplémentaire, jamais remplacer le score CPU.
 */
function aiControlBlock({ webgpuAvailable, aiStatus, onToggleAi }) {
  const statusLabel = {
    off: 'Désactivée',
    loading: 'Chargement du modèle…',
    ready: 'Active',
    error: 'Indisponible — classement CPU inchangé',
  }[aiStatus] || 'Désactivée';

  const btnLabel = aiStatus === 'ready' ? 'Désactiver l\'IA continue'
    : aiStatus === 'loading' ? 'Chargement…'
    : 'Activer l\'IA continue';

  return el('div', { class: 'ai-control' }, [
    el('div', {}, [
      el('span', { class: 'ai-control-label', text: '🧠 IA continue (optionnelle) : ' }),
      el('span', { class: `ai-status ai-status-${aiStatus}`, text: statusLabel }),
    ]),
    webgpuAvailable
      ? el('button', { class: 'btn secondary', text: btnLabel, disabled: aiStatus === 'loading' ? 'true' : undefined, onclick: onToggleAi })
      : el('p', { class: 'lede', style: 'margin:0.3rem 0 0;', text: 'WebGPU indisponible dans ce navigateur : la couche IA ne peut pas être activée. Le classement par mots-clés (CPU) reste pleinement fonctionnel.' }),
    el('p', { class: 'lede', style: 'margin:0.3rem 0 0;', text: 'Ajoute un second score, calculé par un modèle léger tournant localement, en plus du score CPU — jamais à sa place. Une panne de cette couche n\'affecte jamais le classement CPU.' }),
  ]);
}

/**
 * Affiche la barre d'onglets (une salle = un onglet) et le contenu de la
 * salle active uniquement : son ledger, puis une zone de détail/chat
 * intégrée juste en dessous (id="detail-zone") — plus de liste empilée de
 * toutes les salles avec un chat qui apparaît ailleurs sur la page.
 */
export function renderRoomsList(rooms, activeRoomId, { onSelectRoom, onOpenCandidate, onRemoveRoom, aiEnabled, sortMode, onSetSortMode } = {}) {
  const tabs = document.getElementById('room-tabs');
  const content = document.getElementById('room-content');
  if (!tabs || !content) return;
  tabs.innerHTML = '';
  content.innerHTML = '';

  if (rooms.length === 0) {
    content.appendChild(el('p', { class: 'empty-state', text: 'Aucune salle d\'annonce publiée pour le moment.' }));
    return;
  }

  const active = rooms.find((r) => r.id === activeRoomId) || rooms[0];

  tabs.appendChild(el('div', { class: 'room-tab-bar' }, rooms.map((room) => el('button', {
    class: `room-tab ${room.id === active.id ? 'active' : ''}`,
    onclick: () => onSelectRoom?.(room.id),
  }, [
    room.title || 'Sans titre',
    room.candidates.length > 0 ? el('span', { class: 'room-tab-count', text: String(room.candidates.length) }) : null,
  ]))));

  const ledgerItems = active.candidates.length === 0
    ? [el('li', { class: 'empty-state', text: '🔴 En direct — en attente de candidats…' })]
    : active.candidates.map((c) => el('li', {}, [
        el('button', { class: 'ledger-row', onclick: () => onOpenCandidate?.(c, active) }, [
          el('span', { class: `ledger-score ${c.total === 0 ? 'weak' : ''}`, text: `${c.total}` }),
          el('span', {}, [
            el('div', { class: 'ledger-title', text: c.displayName || `Pair ${String(c.peerId).slice(0, 10)}…` }),
            el('div', { class: 'ledger-sub', text: `${c.total}/${c.totalRequired} mots-clés${c.cityStatus === 'match' ? ' · 📍' : ''}${c.experienceStatus === 'match' ? ' · ✓ ancienneté' : c.experienceStatus === 'below' ? ' · ⚠ ancienneté' : ''}${c.cvFileName ? '' : ' · CV en cours…'}` }),
          ]),
          aiEnabled ? el('span', { class: 'ai-badge', text: c.aiPending ? 'IA…' : (c.aiScore != null ? `IA ${c.aiScore}pts` : '—') }) : null,
          el('span', { class: 'ledger-chevron', text: '›' }),
        ]),
      ]));

  content.appendChild(el('div', { class: 'posting-card' }, [
    el('div', { style: 'display:flex; justify-content:space-between; align-items:baseline;' }, [
      el('strong', { style: 'font-family:var(--serif); font-size:1.1rem;', text: active.title || 'Annonce sans titre' }),
      el('button', { class: 'link-button', style: 'color:var(--copper);', text: 'retirer cette salle', onclick: () => onRemoveRoom?.(active.id) }),
    ]),
    active.text ? el('details', { class: 'room-text-details' }, [
      el('summary', { text: 'Voir le texte publié' }),
      el('p', { class: 'room-text-preview', text: active.text }),
    ]) : null,
    el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin:0.4rem 0 0.6rem;' }, [
      el('span', { class: 'lede', style: 'font-size:0.8rem;', text: `${active.candidates.length} candidat(s) découvert(s)` }),
      aiEnabled ? el('div', { class: 'sort-toggle' }, [
        el('button', { class: `sort-toggle-btn ${sortMode === 'cpu' ? 'active' : ''}`, text: 'Trier : CPU', onclick: () => onSetSortMode?.('cpu') }),
        el('button', { class: `sort-toggle-btn ${sortMode === 'ai' ? 'active' : ''}`, text: 'Trier : IA', onclick: () => onSetSortMode?.('ai') }),
      ]) : null,
    ]),
    el('ul', { class: 'ledger' }, ledgerItems),
    el('div', { id: 'detail-zone' }),
  ]));
}

// --- Détail d'un match côté recruteur : score, CV téléchargeable, actions ---
export function renderCandidateDetail(entry, { onProposeContact, onBlockPeer, cvUrl }) {
  const zone = document.getElementById('detail-zone');
  if (!zone) return;
  zone.innerHTML = '';

  const reasons = entry.reasons.map((r) =>
    el('div', { class: `reason ${r.type}` }, [r.label])
  );

  const meetingNote = el('input', { type: 'text', placeholder: 'Message ou créneau proposé (optionnel — laissez vide pour un simple chat)…', style: 'width:100%; border:1px solid var(--line); border-radius:var(--radius-sm); padding:0.5rem 0.7rem; margin:0.5rem 0;' });
  const confirmation = el('span', { class: 'send-confirmation', text: '✓ Proposition envoyée' });

  const sendContact = () => {
    onProposeContact(meetingNote.value.trim());
    confirmation.classList.add('visible');
    setTimeout(() => confirmation.classList.remove('visible'), 3000);
  };

  zone.appendChild(el('div', { class: 'section-title', text: entry.displayName || 'Détail du candidat' }));
  zone.appendChild(el('div', { class: 'match-detail' }, [
    el('div', { style: 'display:flex; align-items:baseline; gap:1rem;' }, [
      el('div', { class: 'score-stamp', text: `${entry.total} pts` }),
      el('span', { class: 'lede', style: 'font-size:0.78rem;', text: `mots-clés en commun, sur ${entry.totalRequired} requis` }),
      entry.aiScore != null ? el('span', { class: 'ai-badge', style: 'font-size:0.9rem;', text: `IA ${entry.aiScore} pts` }) : (entry.aiPending ? el('span', { class: 'ai-badge', text: 'IA en cours…' }) : null),
    ]),
    entry.aiJustification ? el('p', { class: 'lede', style: 'font-style:italic; margin:0.3rem 0 0;', text: `IA : « ${entry.aiJustification} »` }) : null,
    cvUrl
      ? el('a', { href: cvUrl, download: entry.cvFileName || 'cv', class: 'btn secondary', style: 'display:inline-block; text-decoration:none; margin-top:0.6rem;', text: `📎 Télécharger le CV (${entry.cvFileName || 'fichier'})` })
      : el('p', { class: 'lede', style: 'margin-top:0.6rem;', text: 'CV en cours de réception…' }),
    el('div', { class: 'section-title', text: 'Pourquoi ce score ?' }),
    el('div', {}, reasons),
    meetingNote,
    el('div', {}, [
      el('button', { class: 'btn', text: 'Proposer un échange', onclick: sendContact }),
      confirmation,
    ]),
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
