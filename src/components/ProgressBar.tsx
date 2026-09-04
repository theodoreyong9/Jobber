interface Props {
  value: number; // 0-100
  stage: string;
}

export function ProgressBar({ value, stage }: Props) {
  return (
    <div className="progress">
      <div className="progress__track">
        <div className="progress__fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <div className="progress__label">
        {Math.round(value)}% — {stage}
      </div>
    </div>
  );
}
