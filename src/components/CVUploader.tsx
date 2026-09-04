import { useCallback, useRef, useState } from "react";

interface Props {
  fileName: string | null;
  onFileSelected: (file: File) => void;
}

export function CVUploader({ fileName, onFileSelected }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith(".docx")) {
        alert("Please select a DOCX file.");
        return;
      }
      onFileSelected(file);
    },
    [onFileSelected]
  );

  return (
    <div
      className={`dropzone ${dragOver ? "dropzone--active" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      role="button"
      tabIndex={0}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".docx"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      {fileName ? (
        <span className="dropzone__file">📄 {fileName}</span>
      ) : (
        <span className="dropzone__hint">Drop your DOCX here, or click to browse</span>
      )}
    </div>
  );
}
