// ui-kit.js — generic, app-agnostic UI primitives. No imports from any
// other app module, so nothing can create a cycle through this file.

export function openModal(title, bodyHtml, { submitLabel = 'Save', onOpen, onSubmit } = {}) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.innerHTML = `
    <form method="dialog" class="modal-form">
      <h3>${title}</h3>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions">
        <button value="cancel" class="btn ghost">Cancel</button>
        <button value="ok" class="btn primary">${submitLabel}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  onOpen && onOpen(dlg);
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
