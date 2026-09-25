/** The slice number under a pane's slice strip, counted from 1. The
 * viewer showed the 0-based index and the tutorial index + 1, so the same
 * first slice read "0" in one and "1" in the other (G-15); both use this. */
export default function SliceNumber({ index, className = "text-gray-400" }: { index: number; className?: string }) {
  return <span className={`w-full text-center font-mono text-[10px] leading-tight ${className}`}>{index + 1}</span>;
}
