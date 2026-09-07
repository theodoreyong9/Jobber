// src/models/catalog.js
//
// Catalogue contrôlé de modèles (§79). Les identifiants doivent correspondre
// à ceux exposés par la version de @mlc-ai/web-llm utilisée — à vérifier /
// mettre à jour lors de l'intégration réelle (prebuiltAppConfig.model_list).

export const MODEL_CATALOG = Object.freeze([
  {
    id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    tier: 'light',
    label: 'Léger',
    description: 'Petit modèle multilingue, rapide à charger, adapté aux machines modestes.',
    approxDownloadMb: 950,
    minRecommendedVramGb: 2,
  },
  {
    id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC',
    tier: 'balanced',
    label: 'Équilibré (recommandé)',
    description: 'Bon compromis qualité / ressources pour l\'extraction sémantique de CV et d\'annonces.',
    approxDownloadMb: 4500,
    minRecommendedVramGb: 6,
  },
  {
    id: 'Llama-3.1-70B-Instruct-q4f16_1-MLC',
    tier: 'advanced',
    label: 'Avancé',
    description: 'Qualité supérieure, nécessite un GPU puissant et beaucoup de mémoire.',
    approxDownloadMb: 39000,
    minRecommendedVramGb: 24,
  },
]);

/**
 * Recommande un modèle selon les capacités détectées (§80). Reste
 * volontairement simple en V1 : se base sur la mémoire GPU estimée si
 * disponible, sinon propose le modèle "léger" par défaut.
 * @param {{ webgpuAvailable: boolean, estimatedVramGb?: number }} caps
 */
export function recommendModel(caps) {
  if (!caps.webgpuAvailable) return null;
  const vram = caps.estimatedVramGb ?? 0;
  const candidates = MODEL_CATALOG.filter((m) => vram === 0 || vram >= m.minRecommendedVramGb);
  if (candidates.length === 0) return MODEL_CATALOG[0];
  // Le plus qualitatif parmi ceux compatibles.
  return candidates[candidates.length - 1];
}
