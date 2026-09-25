import { DragEvent, useEffect, useRef, useState } from "react";

import { alreadyImportedMessage, getQuickImport, quickImport, QuickImportStatus } from "../api/ingestionApi";
import { describeApiError } from "../api/client";
import Modal from "./Modal";

const POLL_INTERVAL_MS = 2000;

/** Drop a whole folder (or select multiple files) of loose DICOM files and
 * get back fully ingested Cases -- no manual "create a case first" step.
 * The server groups files by (PatientID, StudyInstanceUID) and creates or
 * matches a Case for each group itself (see
 * services/ingestion-service/app/quick_import.py). */
export default function QuickImportModal({
  studyId,
  onClose,
  onImported,
  onStarted,
}: {
  studyId: string;
  onClose: () => void;
  onImported: () => void;
  // Fired with the import id once the batch is queued, so the owning
  // panel can keep tracking it after this modal is closed.
  onStarted?: (importId: string) => void;
}) {
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
    // Appended, not replaced: a native folder picker only ever lets you
    // choose *one* folder per invocation (a real browser limitation, not
    // fixable from here) -- clicking "Choose folder" again for a second,
    // third, etc. folder needs to add to the running selection, not
    // silently throw away everything picked so far. Deduped by name+size
    // (File has no stable id) so re-picking the same folder twice by
    // mistake doesn't double the batch.
    setFiles((prev) => {
      const seen = new Set(prev.map(fileKey));
      return [...prev, ...candidates.filter((f) => !seen.has(fileKey(f)))];
    });
  }

  function fileKey(f: File): string {
    return `${(f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name}:${f.size}`;
  }

  /** Every selected file's top-level source -- the folder name for a
   * folder-picker/drop selection (via webkitRelativePath), or "Files"
   * for anything picked through the plain multi-file input, which
   * carries no path at all. Purely for the "what have I picked so far"
   * summary below the dropzone. */
  function groupedSources(list: File[]): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const f of list) {
      const relPath = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
      const name = relPath ? relPath.split("/")[0] : "Files";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return Array.from(counts, ([name, count]) => ({ name, count }));
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
      onStarted?.(res.import_id);
      poll(res.import_id);
    } catch (err) {
      setError(describeApiError(err));
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
        setError(describeApiError(err));
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
              Drop one or more folders at once (or select files) of loose DICOM files -- any mix of patients and
              studies. Each patient is matched or registered automatically, and each distinct study becomes its own
              Case, titled from its own DICOM tags. No manual case creation needed.
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
              <p className="text-sm text-gray-500">{files.length > 0 ? `${files.length} file(s) selected` : "Drag files here"}</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => folderInputRef.current?.click()} className="btn-secondary btn-sm">
                  Choose folder
                </button>
                <button type="button" onClick={() => filesInputRef.current?.click()} className="btn-secondary btn-sm">
                  Choose files
                </button>
              </div>
              <p className="text-xs text-gray-400">
                A folder picker only takes one folder at a time -- click "Choose folder" again for each additional
                one, they'll add up.
              </p>
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
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  // Reset so picking the exact same folder again still
                  // fires this handler -- an <input>'s change event
                  // otherwise won't re-fire when its value doesn't
                  // actually change.
                  e.target.value = "";
                }}
              />
              <input
                ref={filesInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            {files.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-lg border border-gray-100 p-2.5">
                {groupedSources(files).map((g) => (
                  <div key={g.name} className="flex items-center justify-between text-xs text-gray-600">
                    <span className="truncate">{g.name}</span>
                    <span className="flex-shrink-0 text-gray-400">
                      {g.count} file{g.count === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
                <button type="button" onClick={() => setFiles([])} className="self-start text-xs text-gray-400 underline hover:text-gray-600">
                  Clear selection
                </button>
              </div>
            )}

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
              {result.errors.length > 0 && `, ${result.errors.length} file(s) failed`}
              {(result.already_imported?.length ?? 0) > 0 && `, ${result.already_imported!.length} already imported (skipped)`}.
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
            {(result.already_imported?.length ?? 0) > 0 && (
              <details className="text-xs text-gray-500" data-testid="already-imported">
                <summary className="cursor-pointer">{result.already_imported!.length} already imported</summary>
                <ul className="mt-1 flex flex-col gap-1">
                  {result.already_imported!.map((d, i) => (
                    <li key={i} className="rounded bg-gray-50 px-2 py-1">
                      {alreadyImportedMessage(d.file.split("/").pop() ?? d.file, d.where)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
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
