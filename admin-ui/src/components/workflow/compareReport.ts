/** Shared bits of the Compare card's node, panel and report. */
import { CompareResults } from "../../api/workflowApi";
import { CsvColumn, toCsv } from "../../pages/usage/export";

/** A Dice chip's colours: at or above the card's threshold agrees, below it
 * doesn't -- and "nothing drawn by either" is neither. */
export function diceTone(dice: number | null, threshold: number): string {
  if (dice === null) return "bg-gray-100 text-gray-500";
  return dice >= threshold ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800";
}

/** One row per image and pair, for a spreadsheet. */
export function compareCsv(results: CompareResults): string {
  const rows = results.images.flatMap((image) => image.pairs.map((pair) => ({ image, pair })));
  const title = (i: number) => results.inputs[i]?.title ?? `Input ${i + 1}`;
  const labels = [...new Set(rows.flatMap((r) => Object.keys(r.pair.by_label)))].sort();
  const columns: CsvColumn<(typeof rows)[number]>[] = [
    { header: "case", value: (r) => r.image.case_title },
    { header: "series_id", value: (r) => r.image.series_id },
    { header: "a", value: (r) => title(r.pair.a) },
    { header: "b", value: (r) => title(r.pair.b) },
    { header: "dice", value: (r) => r.pair.dice },
    ...labels.map((label) => ({ header: `dice_${label}`, value: (r: (typeof rows)[number]) => r.pair.by_label[label] ?? null })),
    { header: "findings_both", value: (r) => r.pair.objects.both },
    { header: "findings_only_a", value: (r) => r.pair.objects.only_a },
    { header: "findings_only_b", value: (r) => r.pair.objects.only_b },
    { header: "voxels_a", value: (r) => r.pair.voxels_a },
    { header: "voxels_b", value: (r) => r.pair.voxels_b },
  ];
  return toCsv(rows, columns);
}
