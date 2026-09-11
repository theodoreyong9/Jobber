// ui-kit.js — generic, app-agnostic UI primitives. No imports from any
// other app module, so nothing can create a cycle through this file.

export function openModal(title, bodyHtml, { submitLabel = 'Save', onOpen, onSubmit, noSubmit = false } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `
    <form method="dialog" class="modal-form">
      <h3>${title}</h3>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions">
        <button type="button" value="cancel" class="btn ghost" id="__modalCancel">Cancel</button>
        ${noSubmit ? '' : `<button type="submit" value="ok" class="btn primary">${submitLabel}</button>`}
      </div>
    </form>`;
  document.body.appendChild(dlg);
  onOpen && onOpen(dlg);
  // Cancel is explicitly type="button" (not submit) precisely so pressing
  // Enter in a text field always confirms — the browser picks the *first*
  // submit button on Enter, and Cancel being first in the DOM was
  // dismissing the dialog on Enter instead of submitting it.
  dlg.querySelector('#__modalCancel').addEventListener('click', () => { dlg.returnValue = 'cancel'; dlg.close(); });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'ok' && onSubmit) onSubmit(dlg);
    dlg.remove();
  });
  dlg.showModal();
  return dlg;
}

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
