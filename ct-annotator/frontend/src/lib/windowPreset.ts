/** The window a case opens in. Every case used to open in the image's own
 * window, so in a lung-nodule study some opened in soft tissue, where a
 * ground-glass nodule is invisible (K8). */

export const WINDOW_PRESETS: { label: string; center: number; width: number }[] = [
  { label: "Soft tissue", center: 40, width: 400 },
  { label: "Lung", center: -600, width: 1500 },
  { label: "Bone", center: 300, width: 1500 },
  { label: "Brain", center: 40, width: 80 },
];

export const DEFAULT_WINDOW = { center: 40, width: 400 };

function preset(name: string | null | undefined) {
  return WINDOW_PRESETS.find((p) => p.label === name) ?? null;
}

/** The job's Surface preset first, then the preset this person last chose
 * in this job, then the image's own window, then soft tissue. */
export function initialWindow({
  surfacePreset,
  rememberedPreset,
  dicom,
}: {
  surfacePreset: string | null | undefined;
  rememberedPreset: string | null | undefined;
  dicom: { center: number; width: number } | null;
}): { center: number; width: number; source: "surface" | "remembered" | "image" | "default" } {
  const fromSurface = preset(surfacePreset);
  if (fromSurface) return { center: fromSurface.center, width: fromSurface.width, source: "surface" };
  const remembered = preset(rememberedPreset);
  if (remembered) return { center: remembered.center, width: remembered.width, source: "remembered" };
  if (dicom) return { ...dicom, source: "image" };
  return { ...DEFAULT_WINDOW, source: "default" };
}

const KEY = (jobId: string | null) => `vl.viewer.window.${jobId ?? "none"}`;

export function rememberWindowPreset(jobId: string | null, label: string): void {
  try {
    localStorage.setItem(KEY(jobId), label);
  } catch {
    // private mode / blocked storage: nothing to remember
  }
}

export function rememberedWindowPreset(jobId: string | null): string | null {
  try {
    return localStorage.getItem(KEY(jobId));
  } catch {
    return null;
  }
}
