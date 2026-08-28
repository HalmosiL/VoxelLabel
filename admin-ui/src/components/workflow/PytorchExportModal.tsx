import { useEffect, useRef, useState } from "react";

import { createPytorchExport, getPytorchExport, PytorchExportManifest } from "../../api/ingestionApi";
import Modal from "../Modal";

const POLL_INTERVAL_MS = 3000;

/** A reference PyTorch Dataset the exported manifest is shaped for --
 * shown as a starting point, not shipped as a package (every series is
 * already a plain .npy of real HU values, so there's nothing left for a
 * helper library to decode). */
const SNIPPET = `import json, urllib.request
import numpy as np
from torch.utils.data import Dataset

class ManifestDataset(Dataset):
    def __init__(self, manifest_path: str):
        with open(manifest_path) as f:
            manifest = json.load(f)
        # One entry per (case, series) pair -- flatten for indexing.
        self.items = [
            (case, series)
            for case in manifest["cases"]
            for series in case["series"]
        ]

    def __len__(self):
        return len(self.items)

    def __getitem__(self, idx):
        case, series = self.items[idx]
        with urllib.request.urlopen(series["image_url"]) as resp:
            volume = np.load(resp)  # shape: series["shape"], real HU values
        return volume, case["annotations"]
`;

/** Kicks off a PyTorch-ready export for one Dataset card's resolved case
 * list, polls it to completion, and hands the user a manifest they can
 * download and feed straight into a local PyTorch Dataset (see SNIPPET
 * above) -- see services/ingestion-service/app/pytorch_export.py for
 * what actually gets built. */
export default function PytorchExportModal({
  studyId,
  caseIds,
  onClose,
}: {
  studyId: string;
  caseIds: string[];
  onClose: () => void;
}) {
  const [status, setStatus] = useState<"queued" | "running" | "failed" | "completed">("queued");
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<PytorchExportManifest | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll(exportId: string) {
      try {
        const result = await getPytorchExport(exportId);
        if (cancelled) return;
        if (result.status === "completed") {
          setManifest(result.manifest);
          setStatus("completed");
        } else if (result.status === "failed") {
          setError(result.error);
          setStatus("failed");
        } else {
          setStatus("running");
          pollRef.current = window.setTimeout(() => poll(exportId), POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setStatus("failed");
        }
      }
    }

    createPytorchExport(studyId, caseIds)
      .then((res) => poll(res.export_id))
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setStatus("failed");
        }
      });

    return () => {
      cancelled = true;
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    };
  }, [studyId, caseIds]);

  function downloadManifest() {
    if (!manifest) return;
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `pytorch-export-${manifest.export_id.slice(0, 8)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <Modal title="Export for PyTorch" onClose={onClose} maxWidthClassName="max-w-lg">
      <div className="flex flex-col gap-4">
        {(status === "queued" || status === "running") && (
          <p className="hint">
            Decoding {caseIds.length} case{caseIds.length === 1 ? "" : "s"} into real-HU-value numpy arrays and
            uploading them -- this can take a while for a large cohort. This window can be closed; the export keeps
            running.
          </p>
        )}
        {status === "failed" && <p className="alert-error">Export failed: {error}</p>}
        {status === "completed" && manifest && (
          <>
            <p className="hint">
              Ready: {manifest.case_count} case{manifest.case_count === 1 ? "" : "s"}, every image series as a
              downloadable <code>.npy</code> array of real HU values. Image and annotation-asset links are valid for
              ~24 hours from whenever the manifest is fetched.
            </p>
            <button onClick={downloadManifest} className="btn-secondary btn-sm self-start">
              Download manifest.json
            </button>
            <div>
              <p className="label mb-1">Loading it in PyTorch</p>
              <pre className="max-h-64 overflow-auto rounded-lg bg-gray-900 p-3 text-xs text-gray-100">{SNIPPET}</pre>
            </div>
          </>
        )}
        <div className="flex justify-end">
          <button onClick={onClose} className="btn-secondary btn-sm">
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
