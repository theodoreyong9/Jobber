// src/ui/render.js
//
// Rendu DOM vanilla. v6 :
//   - bouton "!" compact (id, restauration, invalidation, suppression) ;
//   - assistant progressif : les champs apparaissent un par un au lieu
//     d'un formulaire complet d'un coup ; le bouton Lancer n'apparait que
//     quand tout est rempli ;
//   - plusieurs recherches en parallele par mode, en onglets, avec un
//     bouton "+ Nouvelle recherche" (au lieu d'un seul flux imposé) ;
//   - a l'interieur d'une recherche active : deux colonnes — liste de
//     resultats a gauche (boost + reinitialiser au-dessus), discussion a
//     droite.

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

// =====================================================================
// Coquille générale
// =====================================================================

const MODE_LABEL = {
  jobCandidate: '🧑\u200d💼 Candidat',
  jobRecruiter: '🏢 Employeur',
  missionSeeker: '📣 Annonceur',
  missionClient: '🤝 Client',
  dating: '💞 Rencontre',
  driveDriver: '🚗 Conducteur',
  drivePassenger: '🧍 Passager',
  near: '📍 Near',
  agent: '🤖 Agent',
};
const MODE_CONTAINER = {
  jobCandidate: 'mode-job-candidate',
  jobRecruiter: 'mode-job-recruiter',
  missionSeeker: 'mode-mission-seeker',
  missionClient: 'mode-mission-client',
  dating: 'mode-dating',
  driveDriver: 'mode-drive-driver',
  drivePassenger: 'mode-drive-passenger',
  near: 'mode-near',
  agent: 'mode-agent',
};

export function renderShell(visibleMode, onToggleMode) {
  const root = app();
  root.innerHTML = '';

  root.appendChild(el('div', { class: 'mode-nav', id: 'mode-nav' }, Object.keys(MODE_LABEL).map((m) => el('button', {
    class: `mode-chip ${m === 'dating' ? 'dating' : ''} ${visibleMode === m ? 'active' : ''}`,
    'data-mode': m,
    onclick: () => onToggleMode(m),
  }, [MODE_LABEL[m], el('span', { class: 'mode-chip-badge', id: `badge-${m}` })]))));

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

// =====================================================================
// Bouton "!" compact : identité + restauration + invalidation + suppression
// =====================================================================

function identityGear(identity, callbacks) {
  const nameInput = field('input', { type: 'text', value: identity.displayName || '', placeholder: 'Votre nom' });
  const save = () => callbacks.onSaveName(nameInput.value.trim());
  nameInput.addEventListener('blur', save);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { save(); nameInput.blur(); } });
  const idInput = field('input', { type: 'text', placeholder: "Coller un ID pour le restaurer..." });

  const popover = el('div', { class: 'gear-popover', hidden: 'true' }, [
    el('span', { class: 'identity-id', text: `id ${identity.id}` }),
    nameInput,
    el('div', { class: 'btn-row' }, [idInput, el('button', { class: 'btn secondary', text: 'Restaurer', onclick: () => { if (idInput.value.trim()) callbacks.onRestoreId(idInput.value.trim()); } })]),
    el('button', { class: 'btn secondary', text: 'Invalider mon ID', onclick: callbacks.onInvalidateId }),
    el('div', { class: 'section-divider' }),
    el('button', { class: 'btn secondary', text: 'Supprimer mes donnees (ce mode)', onclick: callbacks.onWipeMode }),
  ]);
  const btn = el('button', {
    class: 'gear-btn', text: '!',
    onclick: () => { popover.hidden = !popover.hidden; },
  });
  return el('div', { class: 'gear-wrap' }, [btn, popover]);
}

// =====================================================================
// Assistant progressif : les champs apparaissent un par un
// =====================================================================

/**
 * Rend un assistant progressif : n'affiche que les etapes jusqu'a la
 * premiere incomplete (incluse). Le bouton final n'apparait que quand
 * toutes les etapes sont completes. Les elements de `steps[].el` sont
 * crees UNE FOIS par l'appelant et reutilises a chaque appel (juste
 * re-attaches au DOM), donc aucune valeur saisie n'est jamais perdue.
 * @param {HTMLElement} container
 * @param {Array<{el: HTMLElement, isComplete: () => boolean}>} steps
 * @param {{label: string, onClick: () => void}} launch
 */
function renderWizardSteps(container, steps, launch) {
  container.innerHTML = '';
  const wrap = el('div', { class: 'wizard' });
  for (const step of steps) {
    wrap.appendChild(step.el);
    if (!step.isComplete()) { container.appendChild(wrap); return; }
  }
  wrap.appendChild(el('button', { class: 'btn btn-block', text: launch.label, onclick: launch.onClick }));
  container.appendChild(wrap);
}

// =====================================================================
// Onglets de recherches multiples + bouton "+ Nouvelle recherche"
// =====================================================================

function renderInstanceTabs(container, instances, activeId, labelFn, onSelect, onAdd) {
  container.innerHTML = '';
  const row = el('div', { class: 'segmented' });
  for (const inst of instances) {
    row.appendChild(el('button', {
      class: `segmented-item ${inst.id === activeId ? 'active' : ''}`,
      onclick: () => onSelect(inst.id),
    }, [inst.unread > 0 ? '\u{1F514} ' : '', labelFn(inst)]));
  }
  row.appendChild(el('button', { class: 'segmented-item add-btn', text: '+ Nouvelle recherche', onclick: onAdd }));
  container.appendChild(row);
}

function twoColumn(leftChildren, rightChildren) {
  return el('div', { class: 'two-col' }, [
    el('div', { class: 'col-left' }, leftChildren),
    el('div', { class: 'col-right' }, rightChildren),
  ]);
}

// =====================================================================
// Conversations (chat) — vue unique réutilisée à droite partout
// =====================================================================

export function renderConversationView(viewContainerId, conv, callbacks) {
  const view = document.getElementById(viewContainerId);
  if (!view) return;
  view.innerHTML = '';
  if (conv === undefined) { view.appendChild(el('p', { class: 'empty-state', text: 'Choisissez un element de la liste.' })); return; }
  if (!conv) { view.appendChild(el('p', { class: 'empty-state', text: 'Choisissez un element de la liste.' })); return; }

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

// =====================================================================
// SEEKER (candidat / annonceur-mission)
// =====================================================================

const JOB_CANDIDATE_CFG = { containerId: 'mode-job-candidate', panelTitle: 'Candidat - emploi', fileLabel: 'CV', hasExtraText: false, hasPrice: false };
const MISSION_SEEKER_CFG = { containerId: 'mode-mission-seeker', panelTitle: 'Annonceur - mission', fileLabel: 'Propal', hasExtraText: true, hasPrice: true };
const DRIVE_SEEKER_CFG = { containerId: 'mode-drive-driver', panelTitle: 'Conducteur - trajet', fileLabel: 'Trajet', hasExtraText: true, extraTextLabel: 'Decrivez votre trajet (itineraire, horaires, vehicule)...', hasPrice: true, fileOptional: true };

function renderSeekerPanel(cfg, props) {
  const root = document.getElementById(cfg.containerId);
  if (!root) return;
  root.innerHTML = '';

  const topRow = el('div', { class: 'top-row' }, [identityGear(props.identity, props)]);
  const tabsZone = el('div');
  const wizardZone = el('div');
  const bodyZone = el('div');

  root.appendChild(panel(cfg.panelTitle, [topRow, tabsZone, wizardZone, bodyZone], { marker: 'signal' }));

  if (props.creatingNew || props.instances.length === 0) {
    renderSeekerWizard(cfg, wizardZone, props);
    return;
  }

  renderInstanceTabs(tabsZone, props.instances, props.activeInstanceId,
    (inst) => inst.searchKeywords?.join(', ') || 'Recherche',
    props.onSelectInstance, props.onRequestNew);

  const active = props.instances.find((i) => i.id === props.activeInstanceId) || props.instances[0];
  if (!active) return;
  renderSeekerBody(cfg, bodyZone, active, props);
}

/** Bloc "partager ma position" (optionnel) — reutilise dans les deux assistants. Ne bloque jamais l'etape. */
function geoOptInBlock(props) {
  let lat = null;
  let lng = null;
  const status = el('p', { class: 'hint', text: 'Position non partagee (optionnel — utile pour le mode Near).' });
  const btn = el('button', {
    class: 'btn secondary', text: '📍 Partager ma position',
    onclick: async () => {
      status.textContent = 'Localisation en cours...';
      try {
        const coords = await props.onRequestLocation();
        lat = coords.lat; lng = coords.lng;
        status.textContent = `Position partagee (précision ~${Math.round(coords.accuracy || 0)}m).`;
      } catch (e) {
        status.textContent = `Localisation impossible (${e.message}).`;
      }
    },
  });
  const wrap = el('div', {}, [btn, status]);
  return { el: wrap, getLat: () => lat, getLng: () => lng };
}

function renderSeekerWizard(cfg, container, props) {
  const keywordInput = field('input', { type: 'text', placeholder: 'Ex. Data Engineer, Python... (virgules pour plusieurs)' });
  const cityInput = field('input', { type: 'text', placeholder: 'Ville - obligatoire' });
  const countryInput = field('input', { type: 'text', placeholder: 'Pays - obligatoire' });
  const extraTextArea = cfg.hasExtraText ? field('textarea', { placeholder: cfg.extraTextLabel || 'Decrivez votre offre en quelques phrases...' }) : null;
  const priceInput = cfg.hasPrice ? field('input', { type: 'text', placeholder: 'Prix (optionnel)' }) : null;
  const geo = geoOptInBlock(props);
  const fileInput = el('input', { type: 'file', accept: '.docx,.txt' });
  const fileLabel = el('p', { class: 'hint', text: `Deposez votre ${cfg.fileLabel} (.docx/.txt)${cfg.fileOptional ? ' - optionnel si vous avez decrit ci-dessus' : ''}.` });
  let hasProfile = false;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileLabel.textContent = `Analyse de « ${file.name} »...`;
    props.onFileSelected(file, () => { hasProfile = true; fileLabel.textContent = `${cfg.fileLabel} analyse : « ${file.name} ».`; recheck(); });
  });

  const steps = [
    { el: el('div', {}, [el('p', { class: 'field-label', text: `${cfg.fileLabel}${cfg.fileOptional ? ' (optionnel)' : ''}` }), el('div', { class: 'dropzone' }, [fileInput]), fileLabel]), isComplete: () => hasProfile || Boolean(cfg.fileOptional) },
  ];
  if (cfg.hasExtraText) steps.push({ el: extraTextArea, isComplete: () => extraTextArea.value.trim().length > 0 });
  if (cfg.hasPrice) steps.push({ el: priceInput, isComplete: () => true });
  steps.push(
    { el: keywordInput, isComplete: () => keywordInput.value.trim().length > 0 },
    { el: cityInput, isComplete: () => cityInput.value.trim().length > 0 },
    { el: countryInput, isComplete: () => countryInput.value.trim().length > 0 },
    { el: geo.el, isComplete: () => true },
  );

  function recheck() { renderWizardSteps(container, steps, { label: 'Lancer', onClick: launch }); }
  function launch() {
    props.onLaunch({
      keywords: keywordInput.value, city: cityInput.value, country: countryInput.value,
      extraText: extraTextArea ? extraTextArea.value : undefined,
      price: priceInput ? priceInput.value : undefined,
      lat: geo.getLat(), lng: geo.getLng(),
    });
  }
  [keywordInput, cityInput, countryInput, extraTextArea].filter(Boolean).forEach((i) => i.addEventListener('input', recheck));
  recheck();
}

function renderSeekerBody(cfg, container, instance, props) {
  container.innerHTML = '';
  const list = el('ul', { class: 'ledger' });
  if (instance.conversations.length === 0) {
    list.appendChild(el('li', { class: 'empty-state', text: 'Aucune conversation pour le moment.' }));
  } else {
    for (const c of instance.conversations) {
      list.appendChild(el('li', {}, [
        el('button', { class: 'ledger-row-flat', onclick: () => props.onSelectConversation(instance.id, c.id) }, [
          (c.status === 'pending' && c.direction === 'incoming') ? '\u{1F514} ' : '',
          el('span', { class: 'ledger-title', text: c.displayName || `Pair ${c.id.slice(0, 8)}...` }),
          c.unread > 0 ? badge(String(c.unread), 'signal') : null,
        ]),
      ]));
    }
  }

  const leftTop = [];
  if (instance.hasProfile) {
    const boostLabel = instance.boostStatus === 'loading' ? 'Chargement...' : instance.boostStatus === 'done' ? '✓ Boost applique' : instance.boostStatus === 'error' ? 'Reessayer le boost' : '🚀 Booster (optionnel)';
    leftTop.push(el('button', { class: 'btn secondary', text: boostLabel, disabled: instance.boostStatus === 'loading' ? 'true' : undefined, onclick: () => props.onBoost(instance.id) }));
  }
  leftTop.push(el('button', { class: 'btn secondary', text: 'Reinitialiser cette recherche', onclick: () => props.onResetInstance(instance.id) }));

  container.appendChild(twoColumn(
    [el('div', { class: 'btn-row' }, leftTop), list],
    [el('div', { id: `${cfg.containerId}-conv` })],
  ));
  const activeConv = instance.conversations.find((c) => c.id === instance.activeConversationId);
  renderConversationView(`${cfg.containerId}-conv`, instance.conversations.length === 0 ? undefined : (activeConv || null), {
    onAccept: (id) => props.onAcceptConversation(instance.id, id),
    onDecline: (id) => props.onDeclineConversation(instance.id, id),
    onSend: (id, text) => props.onSendMessage(instance.id, id, text),
  });
}

export function renderJobCandidatePanel(props) { renderSeekerPanel(JOB_CANDIDATE_CFG, props); }
export function renderMissionSeekerPanel(props) { renderSeekerPanel(MISSION_SEEKER_CFG, props); }
export function renderDriveDriverPanel(props) { renderSeekerPanel(DRIVE_SEEKER_CFG, props); }

// =====================================================================
// POSTER (employeur / client)
// =====================================================================

export const JOB_RECRUITER_CFG = { containerId: 'mode-job-recruiter', panelTitle: 'Employeur - emploi', roleLabel: 'poste' };
export const MISSION_CLIENT_CFG = { containerId: 'mode-mission-client', panelTitle: 'Client - mission', roleLabel: 'besoin' };
export const DRIVE_PASSENGER_CFG = { containerId: 'mode-drive-passenger', panelTitle: 'Passager - trajet', roleLabel: 'trajet recherche' };

function renderPosterPanel(cfg, props) {
  const root = document.getElementById(cfg.containerId);
  if (!root) return;
  root.innerHTML = '';

  const topRow = el('div', { class: 'top-row' }, [identityGear(props.identity, props)]);
  const tabsZone = el('div');
  const wizardZone = el('div');
  const bodyZone = el('div');
  root.appendChild(panel(cfg.panelTitle, [topRow, tabsZone, wizardZone, bodyZone], { marker: 'copper' }));

  if (props.creatingNew || props.rooms.length === 0) {
    renderPosterWizard(cfg, wizardZone, props);
    return;
  }

  renderInstanceTabs(tabsZone, props.rooms, props.activeRoomId, (r) => r.title || 'Sans titre', props.onSelectRoom, props.onRequestNew);

  const active = props.rooms.find((r) => r.id === props.activeRoomId) || props.rooms[0];
  if (!active) return;
  renderPosterBody(cfg, bodyZone, active, props);
}

function renderPosterWizard(cfg, container, props) {
  const titleInput = field('input', { type: 'text', placeholder: `Intitule du ${cfg.roleLabel}` });
  const cityInput = field('input', { type: 'text', placeholder: 'Ville - obligatoire' });
  const countryInput = field('input', { type: 'text', placeholder: 'Pays - obligatoire' });
  const minYearsInput = field('input', { type: 'number', min: '0', max: '60', placeholder: 'Anciennete min. (annees, optionnel)' });
  const maxYearsInput = field('input', { type: 'number', min: '0', max: '60', placeholder: 'Anciennete max. (annees, optionnel)' });
  const textArea = field('textarea', { placeholder: 'Collez ici le texte...' });

  const steps = [
    { el: titleInput, isComplete: () => true },
    { el: cityInput, isComplete: () => cityInput.value.trim().length > 0 },
    { el: countryInput, isComplete: () => countryInput.value.trim().length > 0 },
    { el: minYearsInput, isComplete: () => true },
    { el: maxYearsInput, isComplete: () => true },
    { el: textArea, isComplete: () => textArea.value.trim().length > 0 },
  ];
  function recheck() { renderWizardSteps(container, steps, { label: 'Publier et rechercher en direct', onClick: launch }); }
  function launch() {
    props.onCreateRoom({
      title: titleInput.value.trim() || null, text: textArea.value,
      city: cityInput.value.trim(), country: countryInput.value.trim(),
      minYearsRequired: minYearsInput.value.trim() ? Number(minYearsInput.value) : null,
      maxYearsRequired: maxYearsInput.value.trim() ? Number(maxYearsInput.value) : null,
    });
  }
  [cityInput, countryInput, textArea].forEach((i) => i.addEventListener('input', recheck));
  recheck();
}

function renderPosterBody(cfg, container, room, props) {
  container.innerHTML = '';
  const ledgerItems = room.candidates.length === 0
    ? [el('li', { class: 'empty-state', text: '🔴 En direct - en attente de candidats...' })]
    : room.candidates.map((c) => el('li', {}, [
        el('button', { class: 'ledger-row', onclick: () => props.onOpenCandidate(room.id, c) }, [
          el('span', { class: `ledger-score ${c.total === 0 ? 'weak' : ''}`, text: `${c.total}` }),
          el('span', {}, [
            el('div', { class: 'ledger-title', text: c.displayName || `Pair ${String(c.peerId).slice(0, 10)}...` }),
            el('div', { class: 'ledger-sub', text: `${c.total}/${c.totalRequired} mots-cles${c.cityStatus === 'match' ? ' · 📍' : ''}${c.countryStatus === 'match' ? ' · 🌍' : ''}` }),
          ]),
        ]),
      ]));

  const left = [
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn secondary', text: 'Retirer cette recherche', onclick: () => props.onRemoveRoom(room.id) })]),
    room.text ? el('details', { class: 'room-text-details' }, [el('summary', { text: 'Voir le texte publie' }), el('p', { class: 'room-text-preview', text: room.text })]) : null,
    el('ul', { class: 'ledger' }, ledgerItems),
  ];
  container.appendChild(twoColumn(left, [el('div', { id: `${cfg.containerId}-detail` })]));
  props.onBodyMounted?.(room.id);
}

export function renderJobRecruiterPanel(props) { renderPosterPanel(JOB_RECRUITER_CFG, props); }
export function renderMissionClientPanel(props) { renderPosterPanel(MISSION_CLIENT_CFG, props); }
export function renderDrivePassengerPanel(props) { renderPosterPanel(DRIVE_PASSENGER_CFG, props); }

export function renderCandidateDetail(detailZoneId, entry, callbacks) {
  const zone = document.getElementById(detailZoneId);
  if (!zone) return;
  zone.innerHTML = '';
  const reasons = entry.reasons.map((r) => el('div', { class: `reason ${r.type}` }, [r.label]));
  const meetingNote = field('input', { type: 'text', placeholder: 'Message ou creneau propose (optionnel)...' });
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
        ? el('a', { href: callbacks.cvUrl, download: entry.cvFileName || 'cv', class: 'btn secondary', style: 'display:inline-block; text-decoration:none; width:fit-content;', text: `📎 Telecharger (${entry.cvFileName || 'fichier'})` })
        : el('p', { class: 'hint', text: 'Document en cours de reception...' }),
      el('div', {}, reasons),
      meetingNote,
      el('div', { class: 'btn-row' }, [el('button', { class: 'btn', text: 'Proposer un echange', onclick: sendContact }), confirmation]),
    ]),
  ]));
}

// =====================================================================
// SYMÉTRIQUE (rencontre)
// =====================================================================

export const DATING_CFG = { containerId: 'mode-dating', panelTitle: 'Rencontre' };

function renderSymmetricPanel(cfg, props) {
  const root = document.getElementById(cfg.containerId);
  if (!root) return;
  root.innerHTML = '';

  const topRow = el('div', { class: 'top-row' }, [identityGear(props.identity, props)]);
  const tabsZone = el('div');
  const wizardZone = el('div');
  const bodyZone = el('div');
  root.appendChild(panel(cfg.panelTitle, [topRow, tabsZone, wizardZone, bodyZone], { marker: 'signal' }));

  if (props.creatingNew || props.instances.length === 0) {
    renderSymmetricWizard(cfg, wizardZone, props);
    return;
  }

  renderInstanceTabs(tabsZone, props.instances, props.activeInstanceId, (i) => i.myTitle || 'Profil', props.onSelectInstance, props.onRequestNew);
  const active = props.instances.find((i) => i.id === props.activeInstanceId) || props.instances[0];
  if (!active) return;
  renderSymmetricBody(cfg, bodyZone, active, props);
}

function renderSymmetricWizard(cfg, container, props) {
  const titleInput = field('input', { type: 'text', placeholder: 'Intitule de votre profil' });
  const demandInput = field('input', { type: 'text', placeholder: 'Ce que vous recherchez (virgules pour plusieurs mots-cles)' });
  const cityInput = field('input', { type: 'text', placeholder: 'Votre ville - obligatoire' });
  const countryInput = field('input', { type: 'text', placeholder: 'Votre pays - obligatoire' });
  const ageInput = field('input', { type: 'number', min: '18', max: '120', placeholder: 'Votre age (optionnel, affiche dans les resultats)' });
  const bioArea = field('textarea', { placeholder: 'Parlez de vous...' });
  const photoInput = el('input', { type: 'file', accept: 'image/*' });
  const photoLabel = el('p', { class: 'hint', text: 'Photo (optionnelle) - jointe uniquement a la diffusion.' });
  const geo = geoOptInBlock(props);
  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    if (!file) return;
    photoLabel.textContent = `Selectionnee : ${file.name}`;
    props.onPhotoSelected(file);
  });

  const steps = [
    { el: titleInput, isComplete: () => true },
    { el: demandInput, isComplete: () => demandInput.value.trim().length > 0 },
    { el: cityInput, isComplete: () => cityInput.value.trim().length > 0 },
    { el: countryInput, isComplete: () => countryInput.value.trim().length > 0 },
    { el: ageInput, isComplete: () => true },
    { el: bioArea, isComplete: () => bioArea.value.trim().length > 0 },
    { el: el('div', {}, [el('div', { class: 'dropzone' }, [photoInput]), photoLabel]), isComplete: () => true },
    { el: geo.el, isComplete: () => true },
  ];
  function recheck() { renderWizardSteps(container, steps, { label: 'Lancer', onClick: launch }); }
  function launch() {
    props.onLaunch({ title: titleInput.value, demand: demandInput.value, city: cityInput.value, country: countryInput.value, age: ageInput.value, bio: bioArea.value, lat: geo.getLat(), lng: geo.getLng() });
  }
  [demandInput, cityInput, countryInput, bioArea].forEach((i) => i.addEventListener('input', recheck));
  recheck();
}

function renderSymmetricBody(cfg, container, instance, props) {
  container.innerHTML = '';
  const matches = instance.matches || [];
  const listItems = matches.length === 0
    ? [el('li', { class: 'empty-state', text: 'Aucun profil compatible pour le moment.' })]
    : matches.map((m) => el('li', {}, [
        el('button', { class: 'ledger-row', onclick: () => props.onOpenMatch(instance.id, m) }, [
          el('span', { class: `ledger-score ${m.total === 0 ? 'weak' : ''}`, text: `${m.total}` }),
          el('span', {}, [
            el('div', { class: 'ledger-title', text: `${m.displayName || `Pair ${String(m.peerId).slice(0, 10)}...`}${m.age != null ? ` · ${m.age} ans` : ''}` }),
            el('div', { class: 'ledger-sub', text: `${m.cityStatus === 'match' ? '📍 meme ville' : ''}` }),
          ]),
        ]),
      ]));

  const boostLabel = instance.boostStatus === 'loading' ? 'Chargement...' : instance.boostStatus === 'done' ? '✓ Boost applique' : instance.boostStatus === 'error' ? 'Reessayer le boost' : '🚀 Booster (optionnel)';
  const left = [
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', text: boostLabel, disabled: instance.boostStatus === 'loading' ? 'true' : undefined, onclick: () => props.onBoost(instance.id) }),
      el('button', { class: 'btn secondary', text: 'Reinitialiser', onclick: () => props.onResetInstance(instance.id) }),
    ]),
    el('ul', { class: 'ledger' }, listItems),
  ];
  container.appendChild(twoColumn(left, [el('div', { id: `${cfg.containerId}-detail` })]));
}

export function renderDatingPanel(props) { renderSymmetricPanel(DATING_CFG, props); }

export function renderDatingMatchDetail(containerSuffix, entry, callbacks) {
  const zone = document.getElementById(`mode-dating-detail`);
  if (!zone) return;
  zone.innerHTML = '';
  const reasons = entry.reasons.map((r) => el('div', { class: `reason ${r.type}` }, [r.label]));
  const note = field('input', { type: 'text', placeholder: 'Message (optionnel)...' });
  const confirmation = el('span', { class: 'send-confirmation', text: '✓ Proposition envoyee' });

  zone.appendChild(el('div', { class: 'panel nested' }, [
    el('div', { class: 'panel-header' }, [el('span', { class: 'panel-marker' }), el('h3', { text: `${entry.displayName || 'Profil'}${entry.age != null ? ` · ${entry.age} ans` : ''}` })]),
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

// =====================================================================
// Journal technique
// =====================================================================

// =====================================================================
// Near — super mode : agrège les résultats déjà découverts dans un rayon
// géographique choisi par l'utilisateur (localisation strictement opt-in).
// =====================================================================

export function renderNearPanel(props) {
  const root = document.getElementById('mode-near');
  if (!root) return;
  root.innerHTML = '';

  const statusText = el('p', { class: 'hint', text: props.myLat != null ? `Localise (précision ~${Math.round(props.accuracy || 0)}m).` : 'Non localise — activez la localisation pour utiliser Near.' });
  const locateBtn = el('button', { class: 'btn secondary', text: props.myLat != null ? '📍 Actualiser ma position' : '📍 Me localiser', onclick: props.onLocate });
  const stopBtn = props.myLat != null ? el('button', { class: 'btn secondary', text: 'Arreter le partage', onclick: props.onStopLocating }) : null;

  const radiusInput = el('input', { type: 'range', min: '1', max: '200', value: String(props.radiusKm), class: 'field' });
  const radiusLabel = el('span', { class: 'hint', text: `${props.radiusKm} km` });
  radiusInput.addEventListener('input', () => { radiusLabel.textContent = `${radiusInput.value} km`; });
  radiusInput.addEventListener('change', () => props.onRadiusChange(Number(radiusInput.value)));

  const items = props.entries.length === 0
    ? [el('li', { class: 'empty-state', text: props.myLat == null ? 'Localisez-vous pour voir les resultats proches.' : 'Aucun resultat localise dans ce rayon pour le moment.' })]
    : props.entries.map((e) => el('li', {}, [
        el('button', { class: 'ledger-row', onclick: () => props.onOpen(e) }, [
          el('span', { class: 'ledger-score', text: `${Math.round(e.distanceKm)}km` }),
          el('span', {}, [
            el('div', { class: 'ledger-title', text: `${e.label} · ${e.modeLabel}` }),
            el('div', { class: 'ledger-sub', text: e.subLabel || '' }),
          ]),
          el('span', { class: 'ledger-chevron', text: '›' }),
        ]),
      ]));

  root.appendChild(panel('Near', [
    el('div', { class: 'btn-row' }, [locateBtn, stopBtn, statusText]),
    props.myLat != null ? el('div', {}, [el('p', { class: 'field-label', text: 'Rayon' }), el('div', { class: 'btn-row' }, [radiusInput, radiusLabel])]) : null,
    el('div', { class: 'section-divider' }),
    el('ul', { class: 'ledger' }, items),
  ], { marker: 'signal' }));
}

// =====================================================================
// Agent — prototype simple a base de regles (pas une IA), suggere des
// actions a partir de ce qui est deja actif dans les autres modes.
// =====================================================================

export function renderAgentPanel(props) {
  const root = document.getElementById('mode-agent');
  if (!root) return;
  root.innerHTML = '';

  const items = props.suggestions.length === 0
    ? [el('li', { class: 'empty-state', text: 'Aucune suggestion pour le moment — activez des modes et lancez des recherches.' })]
    : props.suggestions.map((s) => el('li', { class: 'panel nested', style: 'margin-bottom:0.5rem;' }, [
        el('div', { class: 'panel-body' }, [
          el('p', { text: s.text }),
          s.actionLabel ? el('button', { class: 'btn secondary', text: s.actionLabel, onclick: s.onAction }) : null,
        ]),
      ]));

  root.appendChild(panel('Agent (prototype)', [
    el('p', { class: 'hint', text: 'Prototype simple, a base de regles — pas encore une IA. Analyse ce qui est deja actif dans vos autres modes pour suggerer des actions.' }),
    el('ul', { style: 'list-style:none; margin:0; padding:0;' }, items),
  ], { marker: 'copper' }));
}

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
