// profiles.js — profile storage and the editor flows: the generic one
// (Dating, plus anything else with no special fields), Employment's
// candidate/recruiter split, Outdoor's organizer/participant split, and
// Business's own asymmetric supply/demand split. See each function's own
// comment for the mechanic it encodes.

import * as db from './db.js';
import * as identity from './identity.js';
import * as matching from './matching.js';
import * as extract from './extract.js';
import * as llm from './llm.js';
import { state, NS_CONFIG, roleLabel } from './state.js';
import { openModal, toast } from './ui-kit.js';

export async function getProfile(identityId) {
  return (await db.get('profiles', identityId)) || {
    identityId, sourceText: '', tokens: [], aiTokens: [],
    lookingForText: '', searchTokens: [],
    category: '', languages: [], availableNow: false,
    yourMineUrl: '',
    // Employment-specific (see editEmploymentProfileFlow):
    country: '', city: '',
    coverLetterText: '', cvFileName: '', cvExtractedText: '', earliestYear: null,
    jobPostingText: '', seniorityMin: null, seniorityMax: null,
    // Business-specific (see editSupplyDemandProfileFlow):
    rate: null, budgetMin: null, budgetMax: null,
    professionalEmail: '', photoDataUrl: '',
    // Outdoor-specific (see editOutdoorProfileFlow) — an organizer's
    // contact method is shown directly on their card (not gated behind a
    // request/consent flow like Employment's cover letter): the whole
    // point of posting an activity is to be reachable about it.
    contactType: 'email', contactValue: '', participantLimit: null,
    // AIWA/YourMine-specific (see editAddressProfileFlow) — addressType is
    // one of NS_CONFIG[ns].addressTypes; exactAddress is optional (a
    // Seeker who leaves it blank falls back to sourceText's normal
    // keyword matching instead).
    addressType: '', exactAddress: '',
    // Universal, every namespace (see secretCodeFieldHtml) — an escape
    // hatch from every other matching field, not specific to one mode.
    secretCode: '',
  };
}

// A single "Display name" field lives at the top of every profile editor
// now — renaming used to be a separate topbar action from editing the
// actual profile, which was two disconnected places to change what's
// really one thing. Saved via identity.renameIdentity alongside the
// profile itself, only if it actually changed.
function nameFieldHtml(id) {
  return `<label>Display name</label><input type="text" id="dispName" value="${id.displayName}">`;
}
async function saveNameIfChanged(id, dlg) {
  const newName = dlg.querySelector('#dispName').value.trim();
  if (newName && newName !== id.displayName) await identity.renameIdentity(id.identityId, newName);
}

// A link to your own page on YourMine (Jobber's separate creator
// marketplace — see NS_CONFIG.creator), optional, same as every other
// profile field — available on every identity's editor regardless of
// namespace, not just Creator's own.
function yourMineFieldHtml(profile) {
  return `<label>YourMine URL (optional)</label>
    <input type="url" id="yourMineUrl" value="${profile.yourMineUrl || ''}" placeholder="https://yourmine-dapp.web.app/u/yourname">`;
}
function readYourMineUrl(dlg) {
  return dlg.querySelector('#yourMineUrl').value.trim();
}

// The one field that overrides every other field in every match form —
// see matching.secretCodesMatch. Present on every editor (like
// yourMineFieldHtml) rather than one mode's own: two people can agree to
// find each other directly regardless of which namespace they're in.
// There's no "create" vs "enter" distinction in the field itself — both
// sides just type the same agreed-on value, whoever thought of it first.
function secretCodeFieldHtml(profile) {
  return `<label>Secret code (optional)</label>
    <input type="text" id="secretCode" value="${profile.secretCode || ''}" placeholder="Agree on this with someone directly">
    <p style="font-size:11px;color:var(--low);margin:-6px 0 4px">
      If you both enter the exact same code, you match each other instantly — no matter what else is filled in above.
    </p>`;
}
function readSecretCode(dlg) {
  return dlg.querySelector('#secretCode').value.trim();
}

// Placeholder for a future paid-visibility boost — not built yet. Shown
// disabled, on every editor (like yourMineFieldHtml/secretCodeFieldHtml),
// so the shape of what's coming is visible without pretending it already
// does something.
function advertiseButtonHtml() {
  return `<button type="button" class="btn ghost" disabled style="width:100%;margin:2px 0 10px">Advertise (soon)</button>`;
}

// There's no "Start searching" button (see identity-ui.js) — saving a
// profile that has something to search on goes live automatically the
// first time, and just rebroadcasts the fresh keywords to whoever's
// already connected every time after that.
async function autoSearchOnSave(ns, id, tokens) {
  if (!tokens.length) return;
  if (state.searchLive[ns]?.has(id.identityId)) await state.handlers.rebroadcastDiscovery(ns, id.identityId);
  else await state.handlers.toggleSearchLive(ns, id.identityId);
}

export function editProfileFlow(ns, id) {
  const cfg = NS_CONFIG[ns];
  const roleTag = id.role ? roleLabel(ns, id.role) : null;
  getProfile(id.identityId).then((profile) => {
    const isDating = cfg.kind === 'reciprocal';
    const sourceLabel = roleTag === 'Recruiter' ? 'Job posting (what you\'re hiring for)'
      : roleTag === 'Client' ? 'What you need (brief / request)'
      : roleTag === 'Utilisateur' ? 'What you need help with'
      : roleTag === 'Service' ? 'Describe the service you offer'
      : roleTag === 'Offer' ? 'Describe your offer'
      : roleTag === 'Candidate' ? 'Résumé / skills'
      : roleTag === 'Seeker' ? 'What are you looking for — keywords (this is what gets matched)'
      : roleTag === 'Source' ? 'What you know — free text (this is what gets matched, and is shown to seekers as-is)'
      : isDating ? 'About me'
      : 'Source text (résumé / offer / listing — stays local, never sent as-is)';

    openModal('Edit profile', `
      ${nameFieldHtml(id)}
      ${yourMineFieldHtml(profile)}
      ${secretCodeFieldHtml(profile)}
      ${advertiseButtonHtml()}
      <label>Category / title</label>
      <input type="text" id="cat" value="${profile.category || ''}" placeholder="e.g. Backend Engineer">
      <label>Languages (comma separated)</label>
      <input type="text" id="langs" value="${(profile.languages || []).join(', ')}" placeholder="EN, PT">
      <label><input type="checkbox" id="avail" ${profile.availableNow ? 'checked' : ''}> Available now</label>
      <label>${sourceLabel}</label>
      <textarea id="src" placeholder="Paste text, or load a .txt file below">${profile.sourceText || ''}</textarea>
      <label>Or load from a .txt file</label>
      <input type="file" id="file" accept=".txt,text/plain">
      ${isDating ? `
        <label>What I'm looking for</label>
        <textarea id="looking" placeholder="Describe who/what you're looking for">${profile.lookingForText || ''}</textarea>
      ` : ''}
    `, {
      submitLabel: 'Save profile',
      onOpen: (dlg) => {
        dlg.querySelector('#file').addEventListener('change', async (e) => {
          const f = e.target.files[0];
          if (f) dlg.querySelector('#src').value = await f.text();
        });
      },
      onSubmit: async (dlg) => {
        await saveNameIfChanged(id, dlg);
        const sourceText = dlg.querySelector('#src').value;
        const yourMineUrl = readYourMineUrl(dlg);
        const secretCode = readSecretCode(dlg);
        const category = dlg.querySelector('#cat').value.trim();
        const languages = dlg.querySelector('#langs').value.split(',').map((s) => s.trim()).filter(Boolean);
        const availableNow = dlg.querySelector('#avail').checked;
        const tokens = matching.tokenize(sourceText, category);
        const lookingForText = isDating ? dlg.querySelector('#looking').value : '';
        const searchTokens = isDating ? matching.tokenize(lookingForText) : [];
        await db.put('profiles', {
          identityId: id.identityId, sourceText, yourMineUrl, secretCode, category, languages, availableNow,
          tokens, aiTokens: profile.aiTokens || [], lookingForText, searchTokens,
          updatedAt: Date.now(),
        });
        await autoSearchOnSave(ns, id, tokens);
        toast('Profile saved locally');
        state.render.workspace();
        state.render.topbar();
      },
    });
  });
}

export function editEmploymentProfileFlow(id) {
  getProfile(id.identityId).then((profile) => {
    const isCandidate = id.role === 'candidate';
    const common = `
      ${nameFieldHtml(id)}
      ${yourMineFieldHtml(profile)}
      ${secretCodeFieldHtml(profile)}
      ${advertiseButtonHtml()}
      <label>${isCandidate ? 'Desired position / title' : 'Position title'}</label>
      <input type="text" id="cat" value="${profile.category || ''}" placeholder="e.g. Backend Engineer">
      <label>Country</label>
      <input type="text" id="country" value="${profile.country || ''}" placeholder="e.g. Switzerland">
      <label>City</label>
      <input type="text" id="city" value="${profile.city || ''}" placeholder="e.g. Lausanne">
    `;

    const candidateFields = `
      <label>Cover letter — shared only when a recruiter requests it, never used for keyword matching</label>
      <textarea id="cover" placeholder="Your motivation letter…">${profile.coverLetterText || ''}</textarea>
      <label>CV file (.docx or .pdf) — this is what keywords are extracted from</label>
      <input type="file" id="cv" accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
      <div id="cvStatus" style="font-size:11.5px;color:var(--low);margin-top:4px">
        ${profile.cvFileName ? `Current file: ${profile.cvFileName} (${profile.tokens.length} keywords, earliest year detected: ${profile.earliestYear ?? '—'})` : 'No CV uploaded yet'}
      </div>
      <label><input type="checkbox" id="avail" ${profile.availableNow ? 'checked' : ''}> Available now</label>
    `;

    const recruiterFields = `
      <label>Seniority range you're hiring for — checked against the earliest year found in each candidate's CV</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="senMin" value="${profile.seniorityMin ?? ''}" placeholder="Min year, e.g. 2010" style="flex:1">
        <input type="text" id="senMax" value="${profile.seniorityMax ?? ''}" placeholder="Max year, e.g. 2020" style="flex:1">
      </div>
      <label>Job posting text — this IS used for keyword matching, and is shown to candidates as-is</label>
      <textarea id="posting" placeholder="Paste the job ad…">${profile.jobPostingText || ''}</textarea>
    `;

    openModal(`Edit profile — ${roleLabel('employment', id.role)}`, common + (isCandidate ? candidateFields : recruiterFields), {
      submitLabel: 'Save profile',
      onSubmit: async (dlg) => {
        await saveNameIfChanged(id, dlg);
        const yourMineUrl = readYourMineUrl(dlg);
        const secretCode = readSecretCode(dlg);
        const category = dlg.querySelector('#cat').value.trim();
        const country = dlg.querySelector('#country').value.trim();
        const city = dlg.querySelector('#city').value.trim();

        if (isCandidate) {
          const coverLetterText = dlg.querySelector('#cover').value; // never tokenized
          const availableNow = dlg.querySelector('#avail').checked;
          const file = dlg.querySelector('#cv').files[0];

          let { cvFileName, cvExtractedText, earliestYear } = profile;
          if (file) {
            toast('Extracting text from ' + file.name + '…');
            try {
              cvExtractedText = await extract.extractText(file);
              cvFileName = file.name;
              earliestYear = matching.extractEarliestYear(cvExtractedText);
            } catch (e) {
              toast('Could not read that file: ' + e.message);
              return;
            }
          }
          // Recomputed on every save, not just when a new CV is uploaded —
          // a file input never keeps a previous selection, so re-saving
          // without re-picking the file used to silently reset tokens to
          // whatever they were before (often still empty, if the very
          // first save had no CV at all). Category alone is now enough to
          // produce some CPU keywords instead of a permanently empty
          // profile until a CV happens to be attached.
          const tokens = matching.tokenize(cvExtractedText, category);
          if (file) toast(`Extracted ${tokens.length} keywords from ${file.name}${earliestYear ? `, earliest year ${earliestYear}` : ''}`);

          await db.put('profiles', {
            ...profile, category, country, city, yourMineUrl, secretCode, coverLetterText, availableNow,
            cvFileName, cvExtractedText, tokens, earliestYear,
            updatedAt: Date.now(),
          });
          await autoSearchOnSave('employment', id, tokens);
        } else {
          const jobPostingText = dlg.querySelector('#posting').value;
          const seniorityMin = dlg.querySelector('#senMin').value.trim();
          const seniorityMax = dlg.querySelector('#senMax').value.trim();
          const tokens = matching.tokenize(jobPostingText, category);
          await db.put('profiles', {
            ...profile, category, country, city, yourMineUrl, secretCode, jobPostingText, tokens,
            seniorityMin: seniorityMin ? parseInt(seniorityMin, 10) : null,
            seniorityMax: seniorityMax ? parseInt(seniorityMax, 10) : null,
            updatedAt: Date.now(),
          });
          await autoSearchOnSave('employment', id, tokens);
        }
        toast('Profile saved locally');
        state.render.workspace();
        state.render.topbar();
      },
    });
  });
}

// Outdoor profile editor — same twoSided mechanic as Employment/Business,
// but there's no rate/budget range to check: an organizer's theme is
// completely free (matched purely by keyword overlap, like everywhere
// else), and the only asymmetric field, participant limit, is display-only
// (a chip on the card) rather than something the other side's profile is
// checked against — Jobber has no reliable central way to count RSVPs
// over P2P, so it doesn't pretend to enforce a real cap.
export function editOutdoorProfileFlow(id) {
  getProfile(id.identityId).then((profile) => {
    const isOrganizer = id.role === 'organizer';
    const common = `
      ${nameFieldHtml(id)}
      ${yourMineFieldHtml(profile)}
      ${secretCodeFieldHtml(profile)}
      ${advertiseButtonHtml()}
      <label>${isOrganizer ? 'Activity theme — anything, freely chosen' : 'What kind of activity are you looking for?'}</label>
      <input type="text" id="cat" value="${profile.category || ''}" placeholder="e.g. Sunrise hike, beach volleyball, board game night">
      <label>Country</label>
      <input type="text" id="country" value="${profile.country || ''}" placeholder="e.g. Switzerland">
      <label>City</label>
      <input type="text" id="city" value="${profile.city || ''}" placeholder="e.g. Lausanne">
    `;

    const organizerFields = `
      <label>Details — this IS used for keyword matching, and is shown to participants as-is</label>
      <textarea id="desc" placeholder="Date, meeting point, what to bring…">${profile.sourceText || ''}</textarea>
      <label>Contact method — shown directly on your card, so interested people can reach you</label>
      <div style="display:flex;gap:8px">
        <select id="contactType" style="flex:0 0 110px">
          <option value="email" ${profile.contactType === 'email' ? 'selected' : ''}>Email</option>
          <option value="phone" ${profile.contactType === 'phone' ? 'selected' : ''}>Phone</option>
          <option value="other" ${profile.contactType === 'other' ? 'selected' : ''}>Other</option>
        </select>
        <input type="text" id="contactValue" value="${profile.contactValue || ''}" placeholder="you@example.com" style="flex:1">
      </div>
      <label>Participant limit — shown as a headcount, not enforced (Jobber has no central RSVP count over P2P)</label>
      <input type="text" id="limit" value="${profile.participantLimit ?? ''}" placeholder="e.g. 8">
      <label><input type="checkbox" id="avail" ${profile.availableNow ? 'checked' : ''}> Still open</label>
    `;

    const participantFields = `
      <label>What you're interested in — this is what gets matched against organizers' themes</label>
      <textarea id="interests" placeholder="e.g. Hiking, casual sports, anything outdoors on weekends">${profile.sourceText || ''}</textarea>
      <label><input type="checkbox" id="avail" ${profile.availableNow ? 'checked' : ''}> Available now</label>
    `;

    openModal(`Edit profile — ${roleLabel('outdoor', id.role)}`, common + (isOrganizer ? organizerFields : participantFields), {
      submitLabel: 'Save profile',
      onSubmit: async (dlg) => {
        await saveNameIfChanged(id, dlg);
        const yourMineUrl = readYourMineUrl(dlg);
        const secretCode = readSecretCode(dlg);
        const category = dlg.querySelector('#cat').value.trim();
        const country = dlg.querySelector('#country').value.trim();
        const city = dlg.querySelector('#city').value.trim();
        const availableNow = dlg.querySelector('#avail').checked;

        if (isOrganizer) {
          const sourceText = dlg.querySelector('#desc').value;
          const contactType = dlg.querySelector('#contactType').value;
          const contactValue = dlg.querySelector('#contactValue').value.trim();
          const limit = dlg.querySelector('#limit').value.trim();
          const tokens = matching.tokenize(sourceText, category);
          await db.put('profiles', {
            ...profile, category, country, city, yourMineUrl, secretCode, sourceText, availableNow, tokens,
            contactType, contactValue,
            participantLimit: limit ? parseInt(limit, 10) : null,
            updatedAt: Date.now(),
          });
          await autoSearchOnSave('outdoor', id, tokens);
        } else {
          const sourceText = dlg.querySelector('#interests').value;
          const tokens = matching.tokenize(sourceText, category);
          await db.put('profiles', {
            ...profile, category, country, city, yourMineUrl, secretCode, sourceText, availableNow, tokens,
            updatedAt: Date.now(),
          });
          await autoSearchOnSave('outdoor', id, tokens);
        }
        toast('Profile saved locally');
        state.render.workspace();
        state.render.topbar();
      },
    });
  });
}

// Business profile editor — same asymmetric mechanic as Employment (a
// single declared value on the supply side, checked against a range
// declared on the demand side) but with a rate/budget instead of a
// seniority year, and the attachment is optional and additive rather than
// the sole keyword source: the description text always gets tokenized,
// and a file — if provided — adds to it rather than replacing it.
export function editSupplyDemandProfileFlow(ns, id) {
  const cfg = NS_CONFIG[ns];
  const isSupply = id.role === cfg.roles[0].key; // offer / client
  getProfile(id.identityId).then((profile) => {
    const common = `
      ${nameFieldHtml(id)}
      ${yourMineFieldHtml(profile)}
      ${secretCodeFieldHtml(profile)}
      ${advertiseButtonHtml()}
      <label>${isSupply ? 'What you offer — category' : 'What you need — category'}</label>
      <input type="text" id="cat" value="${profile.category || ''}" placeholder="e.g. Web development">
      <label>Country</label>
      <input type="text" id="country" value="${profile.country || ''}" placeholder="e.g. Switzerland">
      <label>City</label>
      <input type="text" id="city" value="${profile.city || ''}" placeholder="e.g. Lausanne">
    `;

    const supplyFields = `
      <label>Your rate (numeric — checked against declared budgets)</label>
      <input type="text" id="rate" value="${profile.rate ?? ''}" placeholder="e.g. 650">
      <label>Professional email (required)</label>
      <input type="email" id="proEmail" value="${profile.professionalEmail || ''}" placeholder="you@company.com" required>
      <label>Description — this is what gets matched</label>
      <textarea id="desc" placeholder="Describe your expertise or service">${profile.sourceText || ''}</textarea>
      <label>Optional: attach a portfolio/CV (.docx or .pdf) to add more keywords — it enriches the description above, it doesn't replace it</label>
      <input type="file" id="file" accept=".docx,.pdf,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
      <div id="fileStatus" style="font-size:11.5px;color:var(--low);margin-top:4px">${profile.cvFileName ? `Attached: ${profile.cvFileName}` : 'No file attached'}</div>
      <label><input type="checkbox" id="avail" ${profile.availableNow ? 'checked' : ''}> Available now</label>
    `;

    const demandFields = `
      <label>Budget range (numeric — checked against declared rates)</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="budgetMin" value="${profile.budgetMin ?? ''}" placeholder="Min" style="flex:1">
        <input type="text" id="budgetMax" value="${profile.budgetMax ?? ''}" placeholder="Max" style="flex:1">
      </div>
      <label>Describe what you need — this is what gets matched, and is shown to candidates as-is</label>
      <textarea id="desc" placeholder="Describe your request">${profile.sourceText || ''}</textarea>
    `;

    openModal(`Edit profile — ${roleLabel(ns, id.role)}`, common + (isSupply ? supplyFields : demandFields), {
      submitLabel: 'Save profile',
      onSubmit: async (dlg) => {
        await saveNameIfChanged(id, dlg);
        const yourMineUrl = readYourMineUrl(dlg);
        const secretCode = readSecretCode(dlg);
        const category = dlg.querySelector('#cat').value.trim();
        const country = dlg.querySelector('#country').value.trim();
        const city = dlg.querySelector('#city').value.trim();
        const desc = dlg.querySelector('#desc').value;

        if (isSupply) {
          const availableNow = dlg.querySelector('#avail').checked;
          const rate = dlg.querySelector('#rate').value.trim();
          const professionalEmail = dlg.querySelector('#proEmail').value.trim();

          let { cvFileName, cvExtractedText } = profile;
          const file = dlg.querySelector('#file').files[0];
          if (file) {
            toast('Extracting text from ' + file.name + '…');
            try {
              cvExtractedText = await extract.extractText(file);
              cvFileName = file.name;
              toast(`Extracted text from ${file.name}`);
            } catch (e) {
              toast('Could not read that file: ' + e.message);
              return;
            }
          }
          const tokens = matching.tokenize([desc, cvExtractedText].filter(Boolean).join(' '), category);
          await db.put('profiles', {
            ...profile, category, country, city, yourMineUrl, secretCode, sourceText: desc, tokens,
            cvFileName, cvExtractedText, rate: rate ? parseFloat(rate) : null, availableNow,
            professionalEmail,
            updatedAt: Date.now(),
          });
          await autoSearchOnSave(ns, id, tokens);
        } else {
          const budgetMin = dlg.querySelector('#budgetMin').value.trim();
          const budgetMax = dlg.querySelector('#budgetMax').value.trim();
          const tokens = matching.tokenize(desc, category);
          await db.put('profiles', {
            ...profile, category, country, city, yourMineUrl, secretCode, sourceText: desc, tokens,
            budgetMin: budgetMin ? parseFloat(budgetMin) : null,
            budgetMax: budgetMax ? parseFloat(budgetMax) : null,
            updatedAt: Date.now(),
          });
          await autoSearchOnSave(ns, id, tokens);
        }
        toast('Profile saved locally');
        state.render.workspace();
        state.render.topbar();
      },
    });
  });
}

// AIWA/YourMine profile editor. Both roles get the same fields — unlike
// Outdoor/Business's organizer-vs-participant split, there's no separate
// shape per role here, just which side of the same address the text
// describes. This supports both matching styles at once rather than
// making you pick a mode: fill in the exact address if you already know
// it (a Seeker who does only ever sees holders of that exact value — see
// renderClassicWorkspace's requiredExactAddress in discovery-ui.js), and
// the free-text description always gets tokenized too, so the namespace's
// normal keyword-overlap matching (matching.matchTokens, the same
// baseline every twoSided namespace already gets) still works whenever
// neither side knows the exact value yet.
export function editAddressProfileFlow(ns, id) {
  const cfg = NS_CONFIG[ns];
  const isAddressHolder = id.role === cfg.roles[0].key;
  getProfile(id.identityId).then((profile) => {
    const typeOptions = cfg.addressTypes
      .map((t) => `<option value="${t}" ${profile.addressType === t ? 'selected' : ''}>${t}</option>`)
      .join('');
    openModal(`Edit profile — ${roleLabel(ns, id.role)}`, `
      ${nameFieldHtml(id)}
      ${yourMineFieldHtml(profile)}
      ${secretCodeFieldHtml(profile)}
      ${advertiseButtonHtml()}
      <p style="font-size:11.5px;color:var(--low);margin:-6px 0 4px">
        Look it up on <a href="${cfg.url}" target="_blank" rel="noopener">the ${cfg.label} app ↗</a> first if you don't have it handy.
      </p>
      <label>Type</label>
      <select id="addrType">${typeOptions}</select>
      <label>Exact address (optional) — ${isAddressHolder ? 'only Seekers who type this exact value will find you' : 'leave blank to be matched by keyword instead'}</label>
      <input type="text" id="exactAddr" value="${profile.exactAddress || ''}" placeholder="Paste the exact value">
      <label>${isAddressHolder ? 'Describe this address — used for keyword matching, and shown to Seekers as-is' : 'What are you looking for? — matched by keyword unless you entered an exact address above'}</label>
      <textarea id="desc" placeholder="${isAddressHolder ? 'What it’s for, how it’s used…' : 'e.g. a devnet wallet for tips, a minimalist theme…'}">${profile.sourceText || ''}</textarea>
    `, {
      submitLabel: 'Save profile',
      onSubmit: async (dlg) => {
        await saveNameIfChanged(id, dlg);
        const yourMineUrl = readYourMineUrl(dlg);
        const secretCode = readSecretCode(dlg);
        const addressType = dlg.querySelector('#addrType').value;
        const exactAddress = dlg.querySelector('#exactAddr').value.trim();
        const sourceText = dlg.querySelector('#desc').value;
        const tokens = matching.tokenize(sourceText, addressType);
        await db.put('profiles', {
          ...profile, yourMineUrl, secretCode, addressType, exactAddress, sourceText, tokens,
          updatedAt: Date.now(),
        });
        await autoSearchOnSave(ns, id, tokens);
        toast('Profile saved locally');
        state.render.workspace();
        state.render.topbar();
      },
    });
  });
}

// The caller (discovery-ui.js's click handler) drives the progress UI
// directly on the button itself — this function stays pure logic plus
// storage, no toast spam for every progress tick. Returns null for the
// "nothing to do" cases (already toasted here) so the caller can tell
// those apart from a real failure it needs to catch and report.
export async function enrichProfileWithAI(ns, id, onProgress = () => {}) {
  if (!llm.isWebGPUAvailable()) { toast('WebGPU not available — local AI enrichment is disabled on this device.'); return null; }
  const profile = await getProfile(id.identityId);
  const textToEnrich = ns === 'employment'
    ? (id.role === 'candidate' ? profile.cvExtractedText : profile.jobPostingText)
    : profile.sourceText;
  if (!textToEnrich) { toast('Add source text to your profile first.'); return null; }
  const extra = await llm.enrichKeywords(textToEnrich, onProgress); // throws on a real failure — let the caller handle it
  profile.aiTokens = extra;
  await db.put('profiles', profile);
  return extra;
}

// One place that picks the right editor — used to be duplicated between
// discovery-ui.js's card-click binding and (now) identity-ui.js's topbar
// pencil, which is exactly the kind of duplication that drifts.
export function openProfileEditor(ns, id) {
  if (ns === 'employment') editEmploymentProfileFlow(id);
  else if (ns === 'outdoor') editOutdoorProfileFlow(id);
  else if (ns === 'business') editSupplyDemandProfileFlow(ns, id);
  else if (ns === 'wallet' || ns === 'creator') editAddressProfileFlow(ns, id);
  else editProfileFlow(ns, id);
}
