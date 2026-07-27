import { useCallback, useRef, useState } from 'react';

interface Props {
  onFile: (file: File) => void;
  compact?: boolean;
}

export default function DropZone({ onFile, compact }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Drag events fire for every child element, so track depth rather than a flag.
  const dragDepth = useRef(0);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <div
      className={`dropzone${dragging ? ' dropzone--active' : ''}${compact ? ' dropzone--compact' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current--;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".ply,.stl,.obj,.dcm,.dicom"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
      {compact ? (
        <span>Drop another file, or click to browse</span>
      ) : (
        <>
          <div className="dropzone__icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z" strokeLinejoin="round" />
              <path d="M3 7.5 12 12l9-4.5M12 12v9" strokeLinejoin="round" />
            </svg>
          </div>
          <h2>Drop a 3D model here</h2>
          <p>or click to browse your files</p>
          <p className="dropzone__formats">PLY · STL · OBJ · DICOM</p>
        </>
      )}
    </div>
  );
}
