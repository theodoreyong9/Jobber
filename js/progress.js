// Etape 17 : un seul indicateur d'avancement général (pas de barre de
// chargement dédiée au modèle) + un journal technique détaillé et repliable
// où, lui, on peut voir le détail du chargement du modèle, etc.

const fill = document.getElementById("progress-fill");
const pctLabel = document.getElementById("progress-pct");
const logOutput = document.getElementById("log-output");

export function setProgress(pct) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  fill.style.width = `${clamped}%`;
  pctLabel.textContent = `${clamped}%`;
}

export function log(message) {
  const time = new Date().toLocaleTimeString();
  logOutput.textContent += `[${time}] ${message}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

export function resetProgress() {
  setProgress(0);
  logOutput.textContent = "";
}
