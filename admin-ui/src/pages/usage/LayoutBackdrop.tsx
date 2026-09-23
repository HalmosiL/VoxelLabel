import { UsageLayout } from "../../api/adminApi";

/** A miniature of a screen, drawn from its recorded layout (see the
 * tracker's captureLayout): panels in their own colours, buttons with
 * their labels, inputs as empty fields, headings as text -- and every
 * image, canvas or video (the CT slices) as a grey "image" block, since
 * its content is never recorded. Draws into a width x height SVG box
 * (the heatmap's and replay's 160 x 90); `opacity` keeps it behind the
 * dots and pointer paths drawn on top. */

function luminance(color: string | undefined): number | null {
  const m = color?.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!m) return null;
  return (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
}

export default function LayoutBackdrop({ layout, width = 160, height = 90, opacity = 0.6 }: { layout: UsageLayout; width?: number; height?: number; opacity?: number }) {
  const [vw, vh] = layout.viewport;
  if (!vw || !vh) return null;
  const sx = width / vw;
  const sy = height / vh;
  const pageDark = (luminance(layout.bg) ?? 1) < 0.45;
  const ink = (bg: string | undefined) => ((luminance(bg) ?? (pageDark ? 0 : 1)) < 0.45 ? "#e5e7eb" : "#374151");
  const pageBg = layout.bg ?? (pageDark ? "#111827" : "#f9fafb");
  return (
    <g opacity={opacity} pointerEvents="none" data-testid="usage-layout-backdrop">
      <rect x={0} y={0} width={width} height={height} fill={pageBg} />
      {layout.elements.map((box, i) => {
        const [x, y, w, h, kind, label, bg] = box;
        const X = x * sx;
        const Y = y * sy;
        const W = Math.max(w * sx, 0.4);
        const H = Math.max(h * sy, 0.4);
        const font = Math.min(H * 0.62, 2.2);
        const text = label && font >= 0.9 ? label : null;
        switch (kind) {
          case "panel":
            return <rect key={i} x={X} y={Y} width={W} height={H} fill={bg ?? (pageDark ? "#1f2937" : "#ffffff")} stroke={pageDark ? "#374151" : "#e5e7eb"} strokeWidth={0.15} />;
          case "media":
            return (
              <g key={i}>
                <rect x={X} y={Y} width={W} height={H} fill="#6b7280" fillOpacity={0.35} stroke="#6b7280" strokeWidth={0.15} strokeDasharray="0.8 0.6" />
                {W > 10 && H > 4 && (
                  <text x={X + W / 2} y={Y + H / 2} textAnchor="middle" dominantBaseline="central" fontSize={Math.min(3, H / 3)} fill={pageDark ? "#d1d5db" : "#4b5563"}>
                    image
                  </text>
                )}
              </g>
            );
          case "input":
            return <rect key={i} x={X} y={Y} width={W} height={H} rx={0.4} fill={pageDark ? "#111827" : "#ffffff"} stroke={pageDark ? "#4b5563" : "#9ca3af"} strokeWidth={0.2} />;
          case "heading":
            return text ? (
              <text key={i} x={X} y={Y + H / 2} dominantBaseline="central" fontSize={Math.min(H * 0.7, 3)} fontWeight={600} fill={ink(undefined)}>
                {text}
              </text>
            ) : null;
          case "link":
            return text ? (
              <text key={i} x={X} y={Y + H / 2} dominantBaseline="central" fontSize={font} fill={pageDark ? "#93c5fd" : "#1d4ed8"}>
                {text}
              </text>
            ) : null;
          case "button":
            return (
              <g key={i}>
                <rect x={X} y={Y} width={W} height={H} rx={0.5} fill={bg ?? (pageDark ? "#2a2a3e" : "#ffffff")} stroke={pageDark ? "#4b5563" : "#d1d5db"} strokeWidth={0.18} />
                {text && W > 4 && (
                  <text x={X + W / 2} y={Y + H / 2} textAnchor="middle" dominantBaseline="central" fontSize={font} fill={ink(bg)}>
                    {text.length * font * 0.55 > W ? `${text.slice(0, Math.max(1, Math.floor(W / (font * 0.55)) - 1))}…` : text}
                  </text>
                )}
              </g>
            );
          default:
            return null;
        }
      })}
    </g>
  );
}
