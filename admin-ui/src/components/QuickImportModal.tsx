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

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  }

  async function handleUpload() {
    setStatus("uploading");
    setError(null);
    try {
      const res = await quickImport(studyId, files);
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
          <p className="hint">
            {status === "uploading" ? "Uploading…" : "Processing…"} This window can be closed; the import keeps
            running in the background.
          </p>
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
              <details className="text-xs text-gray-500">
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
