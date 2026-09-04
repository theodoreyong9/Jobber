import type { ModelInfo } from "../types";

interface Props {
  models: ModelInfo[];
  value: string | null;
  onChange: (modelId: string) => void;
  loading?: boolean;
  error?: string | null;
}

const BADGE: Record<NonNullable<ModelInfo["recommendation"]>, string> = {
  recommended: "✓ Recommended",
  heavy: "⚠ Heavy",
  limited: "⚠ Limited",
  unsupported: "✗ Unsupported",
};

export function ModelSelector({ models, value, onChange, loading, error }: Props) {
  if (loading) return <p className="model-selector__status">Loading models…</p>;
  if (error) return <p className="model-selector__status model-selector__status--error">{error}</p>;

  return (
    <select
      className="model-selector"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" disabled>
        Select a model…
      </option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
          {m.size ? ` (${m.size})` : ""}
          {m.recommendation ? ` — ${BADGE[m.recommendation]}` : ""}
        </option>
      ))}
    </select>
  );
}
