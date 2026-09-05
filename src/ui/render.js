// src/ui/render.js
//
// Rendu DOM vanilla. v5 :
//   - un seul mode visible a la fois (bascule exclusive, pas d'empilement) ;
//   - dans chaque mode, bloc identite et bloc "details" cote a cote ;
//   - bouton de lancement desactive tant que les champs requis ne sont pas
//     remplis (verifie en direct) ;
//   - suppression des donnees locales PAR MODE (plus de bouton global) ;
//   - re-rendu complet qui restaure les valeurs de champs tapees (capture
//     /restauration par attribut `name`), pour ne jamais perdre de saisie
//     ni faire disparaitre une section a cause d'un re-rendu ailleurs.

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

function field(tag, attrs = {}) {
  return el(tag, { ...attrs, class: `field ${attrs.class || ''}`.trim() });
}

function panel(title, body, opts = {}) {
  return el('div', { class: 'panel', id: opts.id || null }, [
    el('div', { class: 'panel-header' }, [
      el('span', { class: `panel-marker ${opts.marker || 'signal'}` }),
      el('h3', { text: title }),
      opts.meta ? el('span', { class: 'panel-meta', text: opts.meta }) : null,
    ]),
    el('div', { class: 'panel-body' }, body),
  ]);
}

function badge(text, variant) {
  return el('span', { class: `badge ${variant || ''}`.trim(), text });
}

function captureFields(root, names) {
  const values = {};
  for (const name of names) {
    const node = root.querySelector(`[name="${name}"]`);
    if (node) values[name] = node.value;
  }
  return values;
}
function restoreFields(root, values) {
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    const node = root.querySelector(`[name="${name}"]`);
    if (node) node.value = value;
  }
}

const MODE_LABEL = {
  jobCandidate: '🧑\u200d💼 Candidat',
  jobRecruiter: '🏢 Employeur',
  missionSeeker: '📣 Annonceur',
  missionClient: '🤝 Client',
  dating: '💞 Rencontre',
  service: '🔧 Service',
};
const MODE_CONTAINER = {
  jobCandidate: 'mode-job-candidate',
  jobRecruiter: 'mode-job-recruiter',
  missionSeeker: 'mode-mission-seeker',
  missionClient: 'mode-mission-client',
  dating: 'mode-dating',
  service: 'mode-service',
};

export function renderShell(visibleMode, onToggleMode) {
  const root = app();
  root.innerHTML = '';

  root.appendChild(el('div', { class: 'mode-nav', id: 'mode-nav' }, Object.keys(MODE_LABEL).map((m) => el('button', {
    class: `mode-chip ${(m === 'dating' || m === 'service') ? 'dating' : ''} ${visibleMode === m ? 'active' : ''}`,
    'data-mode': m,
    onclick: () => onToggleMode(m),
  }, [MODE_LABEL[m], el('span', { class: 'mode-chip-badge', id: `badge-${m}` })]))));
  root.appendChild(el('p', { class: 'hint', text: 'Un seul mode affiche a la fois, mais chacun continue de tourner en arriere-plan avec sa propre identite.' }));

  for (const containerId of Object.values(MODE_CONTAINER)) {
    root.appendChild(el('div', { id: containerId, hidden: 'true' }));
  }
}

export function setVisibleMode(mode) {
  for (const [m, containerId] of Object.entries(MODE_CONTAINER)) {
    const container = document.getElementById(containerId);
    if (container) container.hidden = m !== mode;
  }
  document.querySelectorAll('.mode-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

export function setModeBadge(mode, count) {
  const badgeEl = document.getElementById(`badge-${mode}`);
  if (!badgeEl) return;
  badgeEl.textContent = count > 0 ? String(count) : '';
  badgeEl.classList.toggle('visible', count > 0);
}

function identityBlock(identity, callbacks) {
  const nameInput = field('input', { type: 'text', name: 'displayName', value: identity.displayName || '', placeholder: 'Votre nom' });
  const save = () => callbacks.onSaveName(nameInput.value.trim());
  nameInput.addEventListener('blur', save);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(); nameInput.blur(); } });
  const idInput = field('input', { type: 'text', placeholder: 'Coller un ID pour le restaurer...' });

  return el('details', { class: 'identity-block' }, [
    el('summary', {}, [
      el('span', { text: `\u{1FAAA} ${identity.displayName || 'Vous'}` }),
      el('span', { class: 'identity-id', text: `id ${identity.id}` }),
    ]),
    el('div', { class: 'identity-block-body' }, [
      nameInput,
      el('div', { class: 'btn-row' }, [
        idInput,
        el('button', { class: 'btn secondary', text: 'Restaurer', onclick: () => { if (idInput.value.trim()) callbacks.onRestoreId(idInput.value.trim()); } }),
      ]),
      el('p', { class: 'hint', text: 'ID compromis ? Genere un nouvel ID (nom conserve) et previent immediatement vos contacts en direct.' }),
      el('button', { class: 'btn secondary', text: 'Invalider mon ID', onclick: callbacks.onInvalidateId }),
      el('div', { class: 'section-divider' }),
      el('button', { class: 'btn secondary', text: 'Supprimer mes donnees (ce mode)', onclick: callbacks.onWipeMode }),
      el('p', { class: 'hint', text: 'Efface uniquement l\'identite et les donnees de CE mode - les autres modes ne sont pas affectes.' }),
    ]),
  ]);
}

function topRow(a, b) {
  return el('div', { class: 'row-of-details' }, [a, b]);
}

function detailsToggle(title, fields, opts = {}) {
  return el('details', { class: 'details-reveal', open: opts.openByDefault !== false ? 'true' : undefined }, [
    el('summary', { text: `Details : ${title}` }),
    el('div', { class: 'details-reveal-body' }, fields),
  ]);
}

export function renderConversations(tabsContainerId, viewContainerId, conversations, activeId, callbacks) {
  const tabs = document.getElementById(tabsContainerId);
  if (tabs) {
    tabs.innerHTML = '';
    if (conversations.length > 0) {
      tabs.appendChild(el('div', { class: 'segmented' }, conversations.map((c) => el('button', {
        class: `segmented-item ${c.id === activeId ? 'active' : ''} ${c.status === 'pending' ? 'pending' : ''}`,
        onclick: () => callbacks.onSelect(c.id),
      }, [
        (c.status === 'pending' && c.direction === 'incoming') ? '\u{1F514} ' : '',
        c.displayName || `Pair ${c.id.slice(0, 8)}...`,
        c.unread > 0 ? badge(String(c.unread), 'signal') : null,
      ]))));
    }
  }
  const conv = conversations.find((c) => c.id === activeId) || null;
  renderConversationView(viewContainerId, conversations.length === 0 ? undefined : conv, callbacks);
}

/**
 * Rend UNE conversation dans un conteneur, sans dépendre d'une barre
 * d'onglets (réutilisé tel quel pour le fil unique du recruteur, où il n'y
 * a pas d'onglets à afficher).
 * `conv === undefined` -> rien du tout (pas d'état vide superflu).
 * `conv === null` -> "Sélectionnez une conversation" (des onglets existent
 * mais aucun n'est actif).
 */
export function renderConversationView(viewContainerId, conv, callbacks) {
  const view = document.getElementById(viewContainerId);
  if (!view) return;
  view.innerHTML = '';
  if (conv === undefined) return;
  if (!conv) { view.appendChild(el('p', { class: 'empty-state', text: 'Selectionnez une conversation.' })); return; }

  if (conv.status === 'pending' && conv.direction === 'incoming') {
    view.appendChild(el('div', { class: 'panel nested' }, [
      el('div', { class: 'panel-body' }, [
        el('p', {}, [el('strong', { text: conv.displayName || 'Un contact' }), ` propose ${conv.kind === 'meeting' ? 'un rendez-vous' : 'un echange'}.`]),
        conv.note ? el('p', { class: 'hint', text: `« ${conv.note} »` }) : null,
        conv.roomTitle ? el('p', { class: 'hint', text: `A propos de : ${conv.roomTitle}` }) : null,
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn', text: 'Accepter', onclick: () => callbacks.onAccept(conv.id) }),
          el('button', { class: 'btn secondary', text: 'Refuser', onclick: () => callbacks.onDecline(conv.id) }),
        ]),
      ]),
    ]));
    return;
  }
  if (conv.status === 'pending' && conv.direction === 'outgoing') {
    view.appendChild(el('p', { class: 'empty-state', text: `En attente de reponse de ${conv.displayName || 'ce contact'}...` }));
    return;
  }

  const messages = el('div', { class: 'chat-messages' });
  for (const m of conv.history) messages.appendChild(el('div', { class: `chat-bubble ${m.senderId === 'me' ? 'me' : 'them'}`, text: m.text }));
  const input = field('input', { type: 'text', placeholder: 'Ecrire un message...' });
  const send = () => { if (!input.value.trim()) return; callbacks.onSend(conv.id, input.value.trim()); input.value = ''; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  view.appendChild(el('div', { class: 'panel nested' }, [
    el('div', { class: 'panel-body' }, [messages, el('div', { class: 'chat-input-row' }, [input, el('button', { class: 'btn', text: 'Envoyer', onclick: send })])]),
  ]));
  messages.scrollTop = messages.scrollHeight;
}

const JOB_CANDIDATE_CFG = {
  containerId: 'mode-job-candidate', analysisId: 'jc-cv-analysis', tabsId: 'jc-tabs', convId: 'jc-conversation',
  panelTitle: 'Candidat - emploi', detailsTitle: 'Recherche', fileLabel: 'CV', fileHint: 'Votre CV (.docx/.txt), analyse localement des le depot.',
  hasExtraText: false,
};
const MISSION_SEEKER_CFG = {
  containerId: 'mode-mission-seeker', analysisId: 'ms-analysis', tabsId: 'ms-tabs', convId: 'ms-conversation',
  panelTitle: 'Annonceur - mission', detailsTitle: 'Offre', fileLabel: 'Propal', fileHint: 'Votre propal (.docx/.txt), analysee localement des le depot.',
  hasExtraText: true, extraTextPlaceholder: 'Decrivez votre offre en quelques phrases...',
};

function renderSeekerPanel(cfg, props) {
  const root = document.getElementById(cfg.containerId);
  if (!root) return;
  const draft = captureFields(root, ['keywords', 'city', 'country', 'extraText']);
  root.innerHTML = '';

  const keywordInput = field('input', { type: 'text', name: 'keywords', placeholder: 'Ex. Data Engineer, Python... (virgules pour plusieurs)' });
  const cityInput = field('input', { type: 'text', name: 'city', placeholder: 'Ville - obligatoire' });
  const countryInput = field('input', { type: 'text', name: 'country', placeholder: 'Pays - obligatoire' });
  const extraTextArea = cfg.hasExtraText ? field('textarea', { name: 'extraText', placeholder: cfg.extraTextPlaceholder || 'Texte...' }) : null;
  const fileInput = el('input', { type: 'file', accept: '.docx,.txt' });
  const fileLabel = el('p', { class: 'hint', text: props.hasProfile ? `${cfg.fileLabel} analyse.` : `Aucun ${cfg.fileLabel} selectionne.` });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) { fileLabel.textContent = `Aucun ${cfg.fileLabel} selectionne.`; return; }
    fileLabel.textContent = `Analyse de « ${file.name} »...`;
    props.onFileSelected(file);
  });

  const launchBtn = el('button', {
    class: 'btn btn-block',
    text: props.isLive ? '\u{1F534} En direct' : 'Lancement',
    disabled: props.isLive ? 'true' : undefined,
    onclick: () => props.onStartLive(keywordInput.value, cityInput.value, countryInput.value, extraTextArea ? extraTextArea.value : undefined),
  });
  const checkValidity = () => {
    const ok = props.hasProfile && keywordInput.value.trim() && cityInput.value.trim() && countryInput.value.trim()
      && (!cfg.hasExtraText || extraTextArea.value.trim());
    launchBtn.disabled = props.isLive || !ok;
  };
  [keywordInput, cityInput, countryInput, extraTextArea].filter(Boolean).forEach((i) => i.addEventListener('input', checkValidity));

  const detailsFields = [keywordInput, cityInput, countryInput];
  if (extraTextArea) detailsFields.push(extraTextArea);
  detailsFields.push(
    el('div', { class: 'dropzone' }, [el('div', { class: 'hint', text: cfg.fileHint }), fileInput]),
    fileLabel,
    el('div', { id: cfg.analysisId }),
  );

  root.appendChild(panel(cfg.panelTitle, [
    topRow(identityBlock(props.identity, props), detailsToggle(cfg.detailsTitle, detailsFields, { openByDefault: !props.isLive })),
    launchBtn,
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn secondary', text: 'Reinitialiser ma recherche', onclick: props.onResetSearch })]),
    el('div', { class: 'section-divider' }),
    el('div', { id: cfg.tabsId }),
    el('div', { id: cfg.convId }),
  ], { marker: 'signal', meta: props.isLive ? '🔴 en direct' : null }));

  restoreFields(root, draft);
  checkValidity();
  if (props.profile) renderCvAnalysisSection(cfg.analysisId, props.profile, props.analysisOpts);
}

export function renderJobCandidatePanel(props) { renderSeekerPanel(JOB_CANDIDATE_CFG, props); }
export function renderMissionSeekerPanel(props) { renderSeekerPanel(MISSION_SEEKER_CFG, props); }

export function renderCvAnalysisSection(containerId, profile, opts) {
  const zone = document.getElementById(containerId);
  if (!zone) return;
  zone.innerHTML = '';
  const expNote = profile.yearsOfExperience == null ? 'anciennete inconnue'
    : `${profile.yearsOfExperience} an(s)${profile.yearsOfExperienceEstimated ? ' (estimee)' : ''}`;
  const boostLabel = opts.boostStatus === 'loading' ? 'Chargement du modele...'
    : opts.boostStatus === 'done' ? '✓ Boost applique'
    : opts.boostStatus === 'error' ? 'Reessayer le boost'
    : '🚀 Booster avec l\'IA (optionnel)';

  zone.appendChild(el('div', { class: 'panel nested' }, [
    el('div', { class: 'panel-body' }, [
      el('p', { class: 'hint', text: `Mots-cles detectes (${profile.keywords.length}) : ${profile.keywords.join(', ') || 'aucun'}` }),
      el('p', { class: 'hint', text: `Anciennete : ${expNote}` }),
      el('div', { class: 'btn-row' }, [
        opts.webgpuAvailable
          ? el('button', { class: 'btn secondary', text: boostLabel, disabled: opts.boostStatus === 'loading' ? 'true' : undefined, onclick: opts.onBoost })
          : el('p', { class: 'hint', text: 'WebGPU indisponible : boost IA impossible ici.' }),
        opts.boostStatus === 'done' ? badge('enrichi par IA', 'signal serif') : null,
      ]),
    ]),
  ]));
}

export const JOB_RECRUITER_CFG = {
  containerId: 'mode-job-recruiter', tabsId: 'jr-room-tabs', contentId: 'jr-room-content', detailZoneId: 'jr-detail-zone',
  panelTitle: 'Employeur - emploi', roleLabel: 'poste',
};
export const MISSION_CLIENT_CFG = {
  containerId: 'mode-mission-client', tabsId: 'mc-room-tabs', contentId: 'mc-room-content', detailZoneId: 'mc-detail-zone',
  panelTitle: 'Client - mission', roleLabel: 'besoin',
};

function renderPosterPanel(cfg, props) {
  const root = document.getElementById(cfg.containerId);
  if (!root) return;
  root.innerHTML = '';

  let addFormVisible = props.rooms.length === 0;
  const addFormContainer = el('div', { class: 'add-room-popover' });

  function renderAddForm() {
    const d = captureFields(addFormContainer, ['title', 'roomCity', 'roomCountry', 'minYears', 'maxYears', 'text']);
    addFormContainer.innerHTML = '';
    addFormContainer.hidden = !addFormVisible;
    if (!addFormVisible) return;
    const titleInput = field('input', { type: 'text', name: 'title', placeholder: `Intitule du ${cfg.roleLabel}` });
    const cityInput = field('input', { type: 'text', name: 'roomCity', placeholder: 'Ville - obligatoire' });
    const countryInput = field('input', { type: 'text', name: 'roomCountry', placeholder: 'Pays - obligatoire' });
    const minYearsInput = field('input', { type: 'number', name: 'minYears', min: '0', max: '60', placeholder: 'Anciennete min. (annees, optionnel)' });
    const maxYearsInput = field('input', { type: 'number', name: 'maxYears', min: '0', max: '60', placeholder: 'Anciennete max. (annees, optionnel)' });
    const textArea = field('textarea', { name: 'text', placeholder: 'Collez ici le texte...' });
    const publishBtn = el('button', {
      class: 'btn btn-block', text: 'Publier et rechercher en direct', disabled: 'true',
      onclick: () => {
        props.onCreateRoom({
          title: titleInput.value.trim() || null, text: textArea.value,
          city: cityInput.value.trim(), country: countryInput.value.trim(),
          minYearsRequired: minYearsInput.value.trim() ? Number(minYearsInput.value) : null,
          maxYearsRequired: maxYearsInput.value.trim() ? Number(maxYearsInput.value) : null,
        });
        addFormVisible = props.rooms.length === 0;
        renderAddForm();
      },
    });
    const checkValidity = () => { publishBtn.disabled = !(cityInput.value.trim() && countryInput.value.trim() && textArea.value.trim()); };
    [cityInput, countryInput, textArea].forEach((i) => i.addEventListener('input', checkValidity));

    addFormContainer.appendChild(el('div', { class: 'panel nested' }, [
      el('div', { class: 'panel-body' }, [titleInput, cityInput, countryInput, minYearsInput, maxYearsInput, textArea, el('div', { class: 'btn-row' }, [publishBtn])]),
    ]));
    restoreFields(addFormContainer, d);
    checkValidity();
  }

  const tabsRow = el('div', { class: 'tabs-with-add' }, [
    el('div', { id: cfg.tabsId, style: 'flex:1;' }),
    el('button', { class: 'segmented-item add-btn', text: '+ Nouvelle salle', onclick: () => { addFormVisible = !addFormVisible; renderAddForm(); } }),
  ]);
  renderAddForm();

  root.appendChild(panel(cfg.panelTitle, [
    topRow(identityBlock(props.identity, props), el('div', { class: 'flex-spacer' })),
    tabsRow,
    addFormContainer,
    el('div', { id: cfg.contentId }),
  ], { marker: 'copper' }));

  renderRoomsList(cfg, props.rooms, props.activeRoomId, props);
}

export function renderJobRecruiterPanel(props) { renderPosterPanel(JOB_RECRUITER_CFG, props); }
export function renderMissionClientPanel(props) { renderPosterPanel(MISSION_CLIENT_CFG, props); }

const roomTextOpenState = new Set();

export function renderRoomsList(cfg, rooms, activeRoomId, callbacks) {
  const tabs = document.getElementById(cfg.tabsId);
  const content = document.getElementById(cfg.contentId);
  if (!tabs || !content) return;
  tabs.innerHTML = '';
  content.innerHTML = '';

  if (rooms.length === 0) {
    content.appendChild(el('p', { class: 'empty-state', text: 'Aucune salle publiee - creez-en une avec le bouton "+ Nouvelle salle".' }));
    return;
  }
  const active = rooms.find((r) => r.id === activeRoomId) || rooms[0];

  tabs.appendChild(el('div', { class: 'segmented' }, rooms.map((room) => el('button', {
    class: `segmented-item ${room.id === active.id ? 'active' : ''}`,
    onclick: () => callbacks.onSelectRoom?.(room.id),
  }, [room.unread > 0 ? '\u{1F514} ' : '', room.title || 'Sans titre', room.candidates.length > 0 ? badge(String(room.candidates.length)) : null]))));

  const ledgerItems = active.candidates.length === 0
    ? [el('li', { class: 'empty-state', text: '🔴 En direct - en attente de candidats...' })]
    : active.candidates.map((c) => el('li', {}, [
        el('button', { class: 'ledger-row', onclick: () => callbacks.onOpenCandidate?.(c, active) }, [
          el('span', { class: `ledger-score ${c.total === 0 ? 'weak' : ''}`, text: `${c.total}` }),
          el('span', {}, [
            el('div', { class: 'ledger-title', text: c.displayName || `Pair ${String(c.peerId).slice(0, 10)}...` }),
            el('div', { class: 'ledger-sub', text: `${c.total}/${c.totalRequired} mots-cles${c.cityStatus === 'match' ? ' · 📍' : ''}${c.countryStatus === 'match' ? ' · 🌍' : ''}${(c.experienceStatus === 'below' || c.experienceStatus === 'above') ? ' · ⚠ anciennete' : c.experienceStatus === 'match' ? ' · ✓ anciennete' : ''}${c.cvFileName ? '' : ' · document en cours...'}` }),
          ]),
          el('span', { class: 'ledger-chevron', text: '›' }),
        ]),
      ]));

  content.appendChild(el('div', { style: 'display:flex; justify-content:space-between; align-items:baseline; margin-bottom:0.4rem;' }, [
    el('strong', { style: 'font-family:var(--serif); font-size:1.02rem;', text: active.title || 'Annonce sans titre' }),
    el('button', { class: 'link-button', text: 'retirer cette salle', onclick: () => callbacks.onRemoveRoom?.(active.id) }),
  ]));
  if (active.text) {
    content.appendChild(el('details', {
      class: 'room-text-details',
      open: roomTextOpenState.has(active.id) ? 'true' : undefined,
      ontoggle: (e) => { if (e.target.open) roomTextOpenState.add(active.id); else roomTextOpenState.delete(active.id); },
    }, [el('summary', { text: 'Voir le texte publie' }), el('p', { class: 'room-text-preview', text: active.text })]));
  }
  content.appendChild(el('p', { class: 'hint', style: 'margin:0.5rem 0;', text: `${active.candidates.length} candidat(s) decouvert(s)` }));
  content.appendChild(el('ul', { class: 'ledger' }, ledgerItems));
  content.appendChild(el('div', { id: cfg.detailZoneId }));
}

export function renderCandidateDetail(detailZoneId, entry, callbacks) {
  const zone = document.getElementById(detailZoneId);
  if (!zone) return;
  zone.innerHTML = '';
  const reasons = entry.reasons.map((r) => el('div', { class: `reason ${r.type}` }, [r.label]));
  const meetingNote = field('input', { type: 'text', placeholder: 'Message ou creneau propose (optionnel - laissez vide pour un simple chat)...' });
  const confirmation = el('span', { class: 'send-confirmation', text: '✓ Proposition envoyee' });
  const sendContact = () => {
    callbacks.onProposeContact(meetingNote.value.trim());
    confirmation.classList.add('visible');
    setTimeout(() => confirmation.classList.remove('visible'), 3000);
  };

  zone.appendChild(el('div', { class: 'panel nested' }, [
    el('div', { class: 'panel-header' }, [el('span', { class: 'panel-marker' }), el('h3', { text: entry.displayName || 'Detail du candidat' })]),
    el('div', { class: 'panel-body' }, [
      el('div', { style: 'display:flex; align-items:baseline; gap:1rem;' }, [
        el('div', { class: 'score-stamp', text: `${entry.total} pts` }),
        el('span', { class: 'hint', text: `mots-cles en commun, sur ${entry.totalRequired} requis` }),
      ]),
      callbacks.cvUrl
        ? el('a', { href: callbacks.cvUrl, download: entry.cvFileName || 'cv', class: 'btn secondary', style: 'display:inline-block; text-decoration:none; width:fit-content;', text: `📎 Telecharger le CV (${entry.cvFileName || 'fichier'})` })
        : el('p', { class: 'hint', text: 'CV en cours de reception...' }),
      el('div', {}, reasons),
      meetingNote,
      el('div', { class: 'btn-row' }, [el('button', { class: 'btn', text: 'Proposer un echange', onclick: sendContact }), confirmation]),
    ]),
  ]));
}

const DATING_CFG = {
  containerId: 'mode-dating', analysisId: 'dt-analysis', matchesId: 'dt-matches', tabsId: 'dt-tabs', convId: 'dt-conversation',
  panelTitle: 'Rencontre', extraField: 'age',
};
const SERVICE_CFG = {
  containerId: 'mode-service', analysisId: 'sv-analysis', matchesId: 'sv-matches', tabsId: 'sv-tabs', convId: 'sv-conversation',
  panelTitle: 'Service', extraField: 'link',
};

function renderSymmetricPanel(cfg, props) {
  const root = document.getElementById(cfg.containerId);
  if (!root) return;
  const draft = captureFields(root, ['title', 'demand', 'city', 'country', 'extra', 'bio']);
  root.innerHTML = '';

  const titleInput = field('input', { type: 'text', name: 'title', placeholder: 'Intitule de votre profil' });
  const demandInput = field('input', { type: 'text', name: 'demand', placeholder: 'Ce que vous recherchez (virgules pour plusieurs mots-cles)' });
  const cityInput = field('input', { type: 'text', name: 'city', placeholder: 'Votre ville - obligatoire' });
  const countryInput = field('input', { type: 'text', name: 'country', placeholder: 'Votre pays - obligatoire' });
  const extraInput = cfg.extraField === 'age'
    ? field('input', { type: 'number', name: 'extra', min: '18', max: '120', placeholder: 'Votre age (optionnel, affiche dans les resultats)' })
    : field('input', { type: 'text', name: 'extra', placeholder: 'Un lien (optionnel, affiche dans les resultats)' });
  const bioArea = field('textarea', { name: 'bio', placeholder: 'Parlez de votre offre...' });
  const photoInput = el('input', { type: 'file', accept: 'image/*' });
  const photoLabel = el('p', { class: 'hint', text: props.hasPhoto ? 'Photo selectionnee.' : 'Aucune photo selectionnee.' });
  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    if (!file) { photoLabel.textContent = 'Aucune photo selectionnee.'; return; }
    photoLabel.textContent = `Selectionnee : ${file.name}`;
    props.onPhotoSelected(file);
  });

  const launchBtn = el('button', {
    class: 'btn btn-block', text: props.isLive ? '\u{1F534} En direct' : 'Lancement',
    disabled: props.isLive ? 'true' : undefined,
    onclick: () => props.onStartLive({ title: titleInput.value, demand: demandInput.value, city: cityInput.value, country: countryInput.value, extra: extraInput.value, bio: bioArea.value }),
  });
  const checkValidity = () => {
    const ok = demandInput.value.trim() && cityInput.value.trim() && countryInput.value.trim() && bioArea.value.trim();
    launchBtn.disabled = props.isLive || !ok;
  };
  [demandInput, cityInput, countryInput, bioArea].forEach((i) => i.addEventListener('input', checkValidity));

  root.appendChild(panel(cfg.panelTitle, [
    topRow(
      identityBlock(props.identity, props),
      detailsToggle('Profil', [
        titleInput, demandInput, cityInput, countryInput, extraInput, bioArea,
        el('div', { class: 'dropzone' }, [el('div', { class: 'hint', text: 'Votre photo - jointe uniquement a la diffusion, jamais stockee ailleurs.' }), photoInput]),
        photoLabel,
        el('div', { id: cfg.analysisId }),
      ], { openByDefault: !props.isLive }),
    ),
    launchBtn,
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn secondary', text: 'Reinitialiser', onclick: props.onResetSearch })]),
    el('div', { class: 'section-divider' }),
    el('div', { class: 'section-title-sm', text: 'Profils compatibles' }),
    el('ul', { class: 'ledger', id: cfg.matchesId }, [el('li', { class: 'empty-state', text: props.isLive ? 'En attente de profils...' : 'Lancez la recherche pour decouvrir des profils.' })]),
    el('div', { id: cfg.tabsId }),
    el('div', { id: cfg.convId }),
  ], { marker: 'signal', meta: props.isLive ? '🔴 en direct' : null }));

  restoreFields(root, draft);
  checkValidity();
  if (props.profile) renderCvAnalysisSection(cfg.analysisId, props.profile, props.analysisOpts);
}

export function renderDatingPanel(props) { renderSymmetricPanel(DATING_CFG, props); }
export function renderServicePanel(props) { renderSymmetricPanel(SERVICE_CFG, props); }

function extraLabel(cfg, entry) {
  if (cfg.extraField === 'age') return entry.age != null ? ` · ${entry.age} ans` : '';
  return entry.link ? ` · ${entry.link}` : '';
}

function renderSymmetricMatchesGeneric(cfg, matches, callbacks) {
  const list = document.getElementById(cfg.matchesId);
  if (!list) return;
  list.innerHTML = '';
  if (matches.length === 0) {
    list.appendChild(el('li', { class: 'empty-state', text: 'Aucun profil compatible pour le moment.' }));
    return;
  }
  for (const m of matches) {
    list.appendChild(el('li', {}, [
      el('button', { class: 'ledger-row', onclick: () => callbacks.onOpen(m) }, [
        el('span', { class: `ledger-score ${m.total === 0 ? 'weak' : ''}`, text: `${m.total}` }),
        el('span', {}, [
          el('div', { class: 'ledger-title', text: `${m.displayName || `Pair ${String(m.peerId).slice(0, 10)}...`}${extraLabel(cfg, m)}` }),
          el('div', { class: 'ledger-sub', text: `${m.cityStatus === 'match' ? '📍 meme ville' : ''}${m.photoUrl ? ' · photo recue' : ' · photo en cours...'}` }),
        ]),
        el('span', { class: 'ledger-chevron', text: '›' }),
      ]),
    ]));
  }
}
export function renderDatingMatches(matches, callbacks) { renderSymmetricMatchesGeneric(DATING_CFG, matches, callbacks); }
export function renderServiceMatches(matches, callbacks) { renderSymmetricMatchesGeneric(SERVICE_CFG, matches, callbacks); }

function renderSymmetricMatchDetailGeneric(cfg, entry, callbacks) {
  const zone = document.getElementById(cfg.convId);
  if (!zone) return;
  zone.innerHTML = '';
  const reasons = entry.reasons.map((r) => el('div', { class: `reason ${r.type}` }, [r.label]));
  const note = field('input', { type: 'text', placeholder: 'Message (optionnel)...' });
  const confirmation = el('span', { class: 'send-confirmation', text: '✓ Proposition envoyee' });

  zone.appendChild(el('div', { class: 'panel nested' }, [
    el('div', { class: 'panel-header' }, [el('span', { class: 'panel-marker' }), el('h3', { text: `${entry.displayName || 'Profil'}${extraLabel(cfg, entry)}` })]),
    el('div', { class: 'panel-body' }, [
      callbacks.photoUrl ? el('img', { src: callbacks.photoUrl, alt: 'Photo de profil', style: 'max-width:100%; border-radius:var(--radius-sm);' }) : el('p', { class: 'hint', text: 'Photo en cours de reception...' }),
      el('div', {}, reasons),
      note,
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn', text: 'Proposer un echange', onclick: () => { callbacks.onProposeContact(note.value.trim()); confirmation.classList.add('visible'); setTimeout(() => confirmation.classList.remove('visible'), 3000); } }),
        confirmation,
      ]),
    ]),
  ]));
}
export function renderDatingMatchDetail(entry, callbacks) { renderSymmetricMatchDetailGeneric(DATING_CFG, entry, callbacks); }
export function renderServiceMatchDetail(entry, callbacks) { renderSymmetricMatchDetailGeneric(SERVICE_CFG, entry, callbacks); }


export function renderLog(line) {
  const panelEl = document.getElementById('log-panel');
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
    openBtn.addEventListener('click', () => { panelEl.hidden = false; });
    closeBtn.addEventListener('click', () => { panelEl.hidden = true; });
  }
}
