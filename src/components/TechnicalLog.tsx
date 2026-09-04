export interface LogLine {
  time: string;
  level: "info" | "warn" | "error";
  message: string;
}

interface Props {
  lines: LogLine[];
}

export function TechnicalLog({ lines }: Props) {
  return (
    <details className="technical-log">
      <summary>Technical log</summary>
      <div className="technical-log__body">
        {lines.map((line, i) => (
          <div key={i} className={`technical-log__line technical-log__line--${line.level}`}>
            <span className="technical-log__time">[{line.time}]</span> {line.message}
          </div>
        ))}
      </div>
    </details>
  );
}
