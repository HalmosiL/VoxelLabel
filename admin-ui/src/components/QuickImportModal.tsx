import { DragEvent, useEffect, useRef, useState } from "react";

import { getQuickImport, quickImport, QuickImportStatus } from "../api/ingestionApi";
import Modal from "./Modal";

const POLL_INTERVAL_MS = 2000;

/** Drop a whole folder (or select multiple files) of loose DICOM files and
 * get back fully ingested Cases -- no manual "create a case first" step.
 * The server groups files by (PatientID, StudyInstanceUID) and creates or
 * matches a Case for each group itself (see
 * services/ingestion-service/app/quick_import.py). */
export default function QuickImportModal({ studyId, onClose, onImported }: { studyId: string; onClose: () => void; onImported: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [status, setStatus] = useState<"idle" | "uploading" | "running" | "failed" | "completed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<QuickImportStatus, { status: "completed" }> | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ sent: number; total: number } | null>(null);
  const [processingProgress, setProcessingProgress] = useState<Extract<QuickImportStatus, { status: "progress" }> | null>(null);
  const pollRef = useRef<number | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    };
  }, []);

  function addFiles(list: FileList | File[]) {
    // Anything ending .dcm, plus every extension-less file (a lot of
    // real-world DICOM exports carry no file extension at all) --
    // folder pickers/drops routinely also surface stray non-DICOM files
    // (.DS_Store, DICOMDIR) which the server will just report as errors
    // per-file, but filtering the obvious non-candidates here keeps
    // that error list from being dominated by junk.
    const candidates = Array.from(list).filter((f) => !f.name.includes(".") || f.name.toLowerCase().endsWith(".dcm"));
    setFiles(candidates);
  }

  /** Recursively reads one dropped filesystem entry -- a plain File for a
   * dropped file, or every file nested (at any depth) under a dropped
   * folder. `readEntries()` on a directory reader only returns entries in
   * batches and must be called repeatedly until it returns an empty
   * batch (a real DOM API quirk, not a bug) -- looping here is what
   * actually collects a large folder's full contents instead of silently
   * truncating it to the first batch. */
  function readEntry(entry: FileSystemEntry): Promise<File[]> {
    return new Promise((resolve) => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file((file) => resolve([file]), () => resolve([]));
        return;
      }
      if (!entry.isDirectory) {
        resolve([]);
        return;
      }
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const collected: FileSystemEntry[] = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (batch.length === 0) {
            const nested = await Promise.all(collected.map(readEntry));
            resolve(nested.flat());
            return;
          }
          collected.push(...batch);
          readBatch();
        }, () => resolve([]));
      };
      readBatch();
    });
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);

    // A dropped *folder* only ever surfaces its actual contents through
    // DataTransferItem's own filesystem-entry API -- dataTransfer.files
    // for a folder drop is empty or meaningless in every browser that
    // supports webkitGetAsEntry, so that path must be tried first, with
    // a plain-files fallback only for a browser/drop that doesn't
    // support it (a flat multi-file drag always works either way).
    const items = event.dataTransfer.items;
    const entries = items ? Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => e != null) : [];
    if (entries.length > 0) {
      const results = await Promise.all(entries.map(readEntry));
      addFiles(results.flat());
      return;
    }
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  }

  async function handleUpload() {
    setStatus("uploading");
    setError(null);
    setUploadProgress({ sent: 0, total: files.reduce((sum, f) => sum + f.size, 0) });
    try {
      const res = await quickImport(studyId, files, (sent, total) => setUploadProgress({ sent, total }));
      poll(res.import_id);
    } catch (err) {
      setError(String(err));
      setStatus("failed");
    }
  }

  function poll(importId: string) {
    setStatus("running");
    getQuickImport(importId)
      .then((res) => {
        if (res.status === "completed") {
          setResult(res);
          setStatus("completed");
          onImported();
        } else if (res.status === "failed") {
          setError(res.error);
          setStatus("failed");
        } else {
          if (res.status === "progress") setProcessingProgress(res);
          pollRef.current = window.setTimeout(() => poll(importId), POLL_INTERVAL_MS);
        }
      })
      .catch((err) => {
        setError(String(err));
        setStatus("failed");
      });
  }

  const busy = status === "uploading" || status === "running";

  return (
    <Modal title="Quick import" onClose={onClose} maxWidthClassName="max-w-lg">
      <div className="flex flex-col gap-4">
        {status === "idle" && (
          <>
            <p className="hint">
              Drop a folder (or select files) of loose DICOM files -- any mix of patients and studies. Each patient
              is matched or registered automatically, and each distinct study becomes its own Case, titled from its
              own DICOM tags. No manual case creation needed.
            </p>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${
                dragOver ? "border-brand-400 bg-brand-50/50" : "border-gray-200"
              }`}
            >
              <p className="text-sm text-gray-500">
                {files.length > 0 ? `${files.length} file(s) selected` : "Drag files here"}
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => folderInputRef.current?.click()} className="btn-secondary btn-sm">
                  Choose folder
                </button>
                <button type="button" onClick={() => filesInputRef.current?.click()} className="btn-secondary btn-sm">
                  Choose files
                </button>
              </div>
              <input
                ref={folderInputRef}
                type="file"
                multiple
                // webkitdirectory is non-standard but supported by every
                // major browser for exactly this "pick a whole folder"
                // use case -- there is no standards-track alternative yet.
                // @ts-expect-error -- not in the DOM typings
                webkitdirectory=""
                className="hidden"
                onChange={(e) => e.target.files && addFiles(e.target.files)}
              />
              <input
                ref={filesInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && addFiles(e.target.files)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-secondary">
                Cancel
              </button>
              <button type="button" onClick={handleUpload} disabled={files.length === 0} className="btn-primary">
                Import {files.length > 0 ? files.length : ""} file{files.length === 1 ? "" : "s"}
              </button>
            </div>
          </>
        )}

        {busy && (
          <div className="flex flex-col gap-2">
            {status === "uploading" && uploadProgress && (
              <>
                <p className="hint">
                  Uploading… {formatBytes(uploadProgress.sent)} / {formatBytes(uploadProgress.total)}
                </p>
                <ProgressBar fraction={uploadProgress.total > 0 ? uploadProgress.sent / uploadProgress.total : 0} />
              </>
            )}
            {status === "running" && (
              <>
                <p className="hint">
                  {processingProgress
                    ? `Processing ${processingProgress.current} / ${processingProgress.total} -- ${processingProgress.filename.split("/").pop()}`
                    : "Processing…"}
                </p>
                {processingProgress && (
                  <ProgressBar fraction={processingProgress.current / processingProgress.total} />
                )}
              </>
            )}
            <p className="hint text-gray-400">This window can be closed; the import keeps running in the background.</p>
          </div>
        )}

        {status === "failed" && <p className="alert-error">Import failed: {error}</p>}

        {status === "completed" && result && (
          <>
            <p className="hint">
              {result.instances_ingested} instance{result.instances_ingested === 1 ? "" : "s"} ingested across{" "}
              {result.cases.length} case{result.cases.length === 1 ? "" : "s"}
              {result.errors.length > 0 && `, ${result.errors.length} file(s) failed`}.
            </p>
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-lg border border-gray-100 p-2 text-sm">
              {result.cases.map((c) => (
                <li key={c.case_id} className="flex items-center justify-between">
                  <span className="truncate">{c.title}</span>
                  <span className="flex items-center gap-2 text-xs text-gray-400">
                    {c.created && <span className="badge-gray">new</span>}
                    {c.instance_count} instance{c.instance_count === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
            {result.errors.length > 0 && (
              <details open className="text-xs text-gray-500">
                <summary className="cursor-pointer">{result.errors.length} error(s)</summary>
                <ul className="mt-1 flex flex-col gap-1">
                  {result.errors.map((e, i) => (
                    <li key={i} className="alert-error">
                      {e.file.split("/").pop()}: {e.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="btn-primary">
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ProgressBar({ fraction }: { fraction: number }) {
  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
      <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${percent}%` }} />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
