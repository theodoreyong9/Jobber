// profiles.js — profile storage and the three editor flows: the generic
// one (Business/Independant/Dating share it... actually Business/
// Independant get their own asymmetric editor below), Employment's
// candidate/recruiter split, and the Business/Independant supply/demand
// split. See each function's own comment for the mechanic it encodes.

import * as db from './db.js';
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
    // Employment-specific (see editEmploymentProfileFlow):
    country: '', city: '',
    coverLetterText: '', cvFileName: '', cvExtractedText: '', earliestYear: null,
    jobPostingText: '', seniorityMin: null, seniorityMax: null,
    // Business / Independant specific:
    rate: null, budgetMin: null, budgetMax: null,
  };
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
      : isDating ? 'About me'
      : 'Source text (résumé / offer / listing — stays local, never sent as-is)';

    openModal('Edit profile', `
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
        const sourceText = dlg.querySelector('#src').value;
        const category = dlg.querySelector('#cat').value.trim();
        const languages = dlg.querySelector('#langs').value.split(',').map((s) => s.trim()).filter(Boolean);
        const availableNow = dlg.querySelector('#avail').checked;
        const tokens = matching.tokenize(sourceText + ' ' + category);
        const lookingForText = isDating ? dlg.querySelector('#looking').value : '';
        const searchTokens = isDating ? matching.tokenize(lookingForText) : [];
        await db.put('profiles', {
          identityId: id.identityId, sourceText, category, languages, availableNow,
          tokens, aiTokens: profile.aiTokens || [], lookingForText, searchTokens,
          updatedAt: Date.now(),
        });
        toast('Profile saved locally');
        state.render.workspace();
      },
    });
  });
}

export function editEmploymentProfileFlow(id) {
  getProfile(id.identityId).then((profile) => {
    const isCandidate = id.role === 'candidate';
    const common = `
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
        const category = dlg.querySelector('#cat').value.trim();
        const country = dlg.querySelector('#country').value.trim();
        const city = dlg.querySelector('#city').value.trim();

        if (isCandidate) {
          const coverLetterText = dlg.querySelector('#cover').value; // never tokenized
          const availableNow = dlg.querySelector('#avail').checked;
          const file = dlg.querySelector('#cv').files[0];

          let { cvFileName, cvExtractedText, tokens, earliestYear } = profile;
          if (file) {
            toast('Extracting text from ' + file.name + '…');
            try {
              cvExtractedText = await extract.extractText(file);
              cvFileName = file.name;
              tokens = matching.tokenize(cvExtractedText + ' ' + category);
              earliestYear = matching.extractEarliestYear(cvExtractedText);
              toast(`Extracted ${tokens.length} keywords from ${file.name}${earliestYear ? `, earliest year ${earliestYear}` : ''}`);
            } catch (e) {
              toast('Could not read that file: ' + e.message);
              return;
            }
          }

          await db.put('profiles', {
            ...profile, category, country, city, coverLetterText, availableNow,
            cvFileName, cvExtractedText, tokens, earliestYear,
            updatedAt: Date.now(),
          });
        } else {
          const jobPostingText = dlg.querySelector('#posting').value;
          const seniorityMin = dlg.querySelector('#senMin').value.trim();
          const seniorityMax = dlg.querySelector('#senMax').value.trim();
          const tokens = matching.tokenize(jobPostingText + ' ' + category);
          await db.put('profiles', {
            ...profile, category, country, city, jobPostingText, tokens,
            seniorityMin: seniorityMin ? parseInt(seniorityMin, 10) : null,
            seniorityMax: seniorityMax ? parseInt(seniorityMax, 10) : null,
            updatedAt: Date.now(),
          });
        }
        toast('Profile saved locally');
        state.render.workspace();
      },
    });
  });
}

// Business / Independant profile editor — same asymmetric mechanic as
// Employment (a single declared value on the supply side, checked against
// a range declared on the demand side) but with a rate/budget instead of a
// seniority year, and the attachment is optional and additive rather than
// the sole keyword source: the description text always gets tokenized,
// and a file — if provided — adds to it rather than replacing it.
export function editSupplyDemandProfileFlow(ns, id) {
  const cfg = NS_CONFIG[ns];
  const isSupply = id.role === cfg.roles[0].key; // offer / provider
  getProfile(id.identityId).then((profile) => {
    const common = `
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
      <label>Description of what you offer — this is what gets matched</label>
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
        const category = dlg.querySelector('#cat').value.trim();
        const country = dlg.querySelector('#country').value.trim();
        const city = dlg.querySelector('#city').value.trim();
        const desc = dlg.querySelector('#desc').value;

        if (isSupply) {
          const availableNow = dlg.querySelector('#avail').checked;
          const rate = dlg.querySelector('#rate').value.trim();
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
          const tokens = matching.tokenize([desc, category, cvExtractedText].filter(Boolean).join(' '));
          await db.put('profiles', {
            ...profile, category, country, city, sourceText: desc, tokens,
            cvFileName, cvExtractedText, rate: rate ? parseFloat(rate) : null, availableNow,
            updatedAt: Date.now(),
          });
        } else {
          const budgetMin = dlg.querySelector('#budgetMin').value.trim();
          const budgetMax = dlg.querySelector('#budgetMax').value.trim();
          const tokens = matching.tokenize(desc + ' ' + category);
          await db.put('profiles', {
            ...profile, category, country, city, sourceText: desc, tokens,
            budgetMin: budgetMin ? parseFloat(budgetMin) : null,
            budgetMax: budgetMax ? parseFloat(budgetMax) : null,
            updatedAt: Date.now(),
          });
        }
        toast('Profile saved locally');
        state.render.workspace();
      },
    });
  });
}

export async function enrichProfileWithAI(ns, id) {
  if (!llm.isWebGPUAvailable()) { toast('WebGPU not available — local AI enrichment is disabled on this device.'); return; }
  const profile = await getProfile(id.identityId);
  const textToEnrich = ns === 'employment'
    ? (id.role === 'candidate' ? profile.cvExtractedText : profile.jobPostingText)
    : profile.sourceText;
  if (!textToEnrich) { toast('Add source text to your profile first.'); return; }
  toast('Loading local model — first run downloads weights, this can take a while…');
  try {
    const extra = await llm.enrichKeywords(textToEnrich, (p) => { if (p.text) toast(p.text); });
    profile.aiTokens = extra;
    await db.put('profiles', profile);
    toast(`AI added ${extra.length} derived keywords (marked separately from source text)`);
    state.render.workspace();
  } catch (e) {
    toast('Local AI failed: ' + e.message);
  }
}
