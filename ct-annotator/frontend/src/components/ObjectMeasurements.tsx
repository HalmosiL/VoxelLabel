import type { ObjectStats } from "../api/annotatorApi";
import { airWarning, measurementParts } from "../lib/objectMeasure";

/** Under the object on the review card: its measurements, a warning when
 * much of it is air, and the slices it is on -- each one click away. */
export default function ObjectMeasurements({
  stats,
  loading,
  slices,
  currentSlice,
  onGoToSlice,
}: {
  stats: ObjectStats | null;
  loading: boolean;
  /** 0-based */
  slices: number[];
  currentSlice: number;
  onGoToSlice: (z: number) => void;
}) {
  const warning = stats ? airWarning(stats) : null;
  // a long run of slices: the ends and the middle, not fifty chips
  const shown = slices.length > 24 ? [slices[0], slices[Math.floor(slices.length / 2)], slices[slices.length - 1]] : slices;
  return (
    <div className="mt-1.5 text-[11px]" data-testid="object-measurements">
      {stats ? (
        <p className="text-gray-300" data-testid="object-measurement-text">
          {measurementParts(stats).join(" · ")}
        </p>
      ) : (
        <p className="text-gray-500">{loading ? "Measuring…" : "No measurements"}</p>
      )}
      {warning && (
        <p className="mt-1 rounded border border-amber-700/60 bg-amber-950/40 px-1.5 py-1 text-amber-200" data-testid="object-air-warning">
          ⚠ {warning}
        </p>
      )}
      {shown.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1" data-testid="object-slice-list" aria-label="Slices this object is on">
          {shown.map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => onGoToSlice(z)}
              title={`Go to slice ${z + 1}`}
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${z === currentSlice ? "border-blue-500 bg-blue-500/20 text-blue-200" : "border-[#444] text-gray-300 hover:bg-[#333]"}`}
            >
              {z + 1}
            </button>
          ))}
          {slices.length > shown.length && <span className="self-center text-gray-500">({slices.length} slices)</span>}
        </div>
      )}
    </div>
  );
}
