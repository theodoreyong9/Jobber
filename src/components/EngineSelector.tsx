import type { EngineKind } from "../types";

interface Props {
  value: EngineKind;
  onChange: (engine: EngineKind) => void;
  allowLocal: boolean;
}

export function EngineSelector({ value, onChange, allowLocal }: Props) {
  return (
    <div className="engine-selector">
      <label className={`engine-selector__option ${value === "webllm" ? "engine-selector__option--active" : ""}`}>
        <input
          type="radio"
          name="engine"
          checked={value === "webllm"}
          onChange={() => onChange("webllm")}
        />
        <div>
          <strong>WebLLM</strong>
          <p>Runs in your browser</p>
        </div>
      </label>

      <label
        className={`engine-selector__option ${value === "local" ? "engine-selector__option--active" : ""} ${
          allowLocal ? "" : "engine-selector__option--disabled"
        }`}
      >
        <input
          type="radio"
          name="engine"
          checked={value === "local"}
          disabled={!allowLocal}
          onChange={() => onChange("local")}
        />
        <div>
          <strong>Local</strong>
          <p>{allowLocal ? "Uses models installed on your computer" : "Not available on this device"}</p>
        </div>
      </label>
    </div>
  );
}
