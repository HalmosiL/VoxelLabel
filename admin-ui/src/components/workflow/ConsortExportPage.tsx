import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ConsortExport, ConsortStage, getConsortExport, getWorkflowBoard } from "../../api/workflowApi";

const BOX_WIDTH = 340;
const BOX_HEIGHT = 64;
const SIDE_BOX_WIDTH = 260;
const SIDE_BOX_HEIGHT = 54;
const STAGE_GAP = 120;
const MARGIN = 40;
const MAIN_X = 40;
const SIDE_X = MAIN_X + BOX_WIDTH + 60;

/** Rasterizes an inline <svg> to a PNG and triggers a browser download --
 * plain client-side canvas round-trip, no server involvement. Exported
 * at 2x for a crisper image than the on-screen CSS size. */
function downloadSvgAsPng(svg: SVGSVGElement, filename: string) {
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  const serialized = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    URL.revokeObjectURL(url);
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  };
  img.src = url;
}

function StageBox({
  x,
  y,
  title,
  count,
  highlight,
}: {
  x: number;
  y: number;
  title: string;
  count: number;
  highlight?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={BOX_WIDTH}
        height={BOX_HEIGHT}
        rx={8}
        fill={highlight ? "#eef1fc" : "#ffffff"}
        stroke={highlight ? "#3454d1" : "#cbd0e0"}
        strokeWidth={highlight ? 2 : 1.5}
      />
      <text x={x + BOX_WIDTH / 2} y={y + 26} textAnchor="middle" fontSize={13} fontWeight={600} fill="#1c2130">
        {title.length > 42 ? `${title.slice(0, 41)}…` : title}
      </text>
      <text x={x + BOX_WIDTH / 2} y={y + 46} textAnchor="middle" fontSize={12.5} fill="#565f76">
        n = {count}
      </text>
    </g>
  );
}

function ExcludedBox({ y, stage }: { y: number; stage: ConsortStage }) {
  const label = stage.evaluated
    ? `Kizárva (n = ${stage.excluded_count})`
    : "Kritérium még nincs kiértékelve";
  return (
    <g>
      <line
        x1={MAIN_X + BOX_WIDTH}
        y1={y}
        x2={SIDE_X}
        y2={y}
        stroke="#9aa2b8"
        strokeWidth={1.5}
        markerEnd="url(#consort-arrow)"
      />
      <rect
        x={SIDE_X}
        y={y - SIDE_BOX_HEIGHT / 2}
        width={SIDE_BOX_WIDTH}
        height={SIDE_BOX_HEIGHT}
        rx={8}
        fill={stage.evaluated ? "#fbe9e7" : "#f1f3f9"}
        stroke={stage.evaluated ? "#b3261e" : "#cbd0e0"}
        strokeWidth={1.2}
        strokeDasharray={stage.evaluated ? undefined : "4 3"}
      />
      <text
        x={SIDE_X + SIDE_BOX_WIDTH / 2}
        y={y - 6}
        textAnchor="middle"
        fontSize={12}
        fontWeight={600}
        fill={stage.evaluated ? "#b3261e" : "#767d95"}
      >
        {label}
      </text>
      {stage.evaluated && (
        <text x={SIDE_X + SIDE_BOX_WIDTH / 2} y={y + 14} textAnchor="middle" fontSize={11} fill="#565f76">
          {stage.title.length > 44 ? `${stage.title.slice(0, 43)}…` : stage.title}
        </text>
      )}
    </g>
  );
}

function ConsortDiagram({ data, svgRef }: { data: ConsortExport; svgRef: React.RefObject<SVGSVGElement> }) {
  const stageCount = data.stages.length;
  const height = MARGIN * 2 + BOX_HEIGHT + stageCount * (STAGE_GAP + BOX_HEIGHT);
  const width = SIDE_X + SIDE_BOX_WIDTH + MARGIN;

  // The last stage that's actually been evaluated is the current final
  // cohort -- highlighted regardless of whether it's literally the last
  // box (a trailing un-evaluated Criterion doesn't get a result box of
  // its own, since it produced nothing yet).
  let finalBoxIndex = -1; // -1 means the root itself is still final
  data.stages.forEach((s, i) => {
    if (s.evaluated) finalBoxIndex = i;
  });

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="mx-auto"
      style={{ background: "#ffffff" }}
    >
      <defs>
        <marker id="consort-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L7,4 L0,8 Z" fill="#9aa2b8" />
        </marker>
      </defs>

      <StageBox x={MAIN_X} y={MARGIN} title={data.root.title} count={data.root.case_count} highlight={finalBoxIndex === -1} />

      {data.stages.map((stage, i) => {
        const prevY = MARGIN + i * (STAGE_GAP + BOX_HEIGHT) + BOX_HEIGHT;
        const branchY = prevY + STAGE_GAP / 2;
        const nextY = prevY + STAGE_GAP;
        return (
          <g key={stage.criterion_card_id}>
            <line
              x1={MAIN_X + BOX_WIDTH / 2}
              y1={prevY}
              x2={MAIN_X + BOX_WIDTH / 2}
              y2={stage.evaluated ? nextY : branchY}
              stroke="#9aa2b8"
              strokeWidth={1.5}
              markerEnd={stage.evaluated ? "url(#consort-arrow)" : undefined}
            />
            <ExcludedBox y={branchY} stage={stage} />
            {stage.evaluated && (
              <StageBox
                x={MAIN_X}
                y={nextY}
                title={`${stage.title} — bevonva`}
                count={stage.included_count ?? 0}
                highlight={finalBoxIndex === i}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export default function ConsortExportPage({ studyId, onClose }: { studyId: string; onClose: () => void }) {
  const [candidates, setCandidates] = useState<{ id: string; title: string }[]>([]);
  const [rootCardId, setRootCardId] = useState<string | null>(null);
  const [data, setData] = useState<ConsortExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    getWorkflowBoard(studyId)
      .then((board) => {
        // A "root" is a plain Dataset with nothing feeding into it --
        // the natural starting population for an eligibility chain, the
        // same assumption the backend's own consort-export makes.
        const targets = new Set(board.edges.map((e) => e.target_card_id));
        const roots = board.cards.filter((c) => c.type === "dataset" && !targets.has(c.id));
        setCandidates(roots.map((c) => ({ id: c.id, title: c.title })));
        if (roots.length === 1) setRootCardId(roots[0].id);
      })
      .catch((err) => setError(String(err)));
  }, [studyId]);

  useEffect(() => {
    if (!rootCardId) return;
    getConsortExport(studyId, rootCardId).then(setData).catch((err) => setError(String(err)));
  }, [studyId, rootCardId]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <header className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-6 py-4">
        <div>
          <p className="section-title">CONSORT export</p>
          <p className="hint">A kiválasztott kiindulási Dataset-től a beválasztási lánc valós esetszámaival.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="field">
            <span className="label">Kiindulási populáció</span>
            <select className="input" value={rootCardId ?? ""} onChange={(e) => setRootCardId(e.target.value || null)}>
              <option value="" disabled>
                Válassz egy Dataset kártyát…
              </option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => svgRef.current && downloadSvgAsPng(svgRef.current, "consort-diagram.png")}
            disabled={!data}
            className="btn-secondary btn-sm self-end"
          >
            Letöltés PNG-ként
          </button>
          <button
            onClick={onClose}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center self-end rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
      </header>

      {error && (
        <div className="flex-shrink-0 px-6 pt-4">
          <p className="alert-error">{error}</p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto bg-gray-50 p-8">
        {!rootCardId && candidates.length === 0 && !error && (
          <p className="hint">Ehhez a study-hoz nincs olyan Dataset kártya, amihez nem fut be él -- hozz létre egyet a kiindulási populációként.</p>
        )}
        {!rootCardId && candidates.length > 1 && <p className="hint">Válassz egy kiindulási Dataset kártyát fent.</p>}
        {data && <ConsortDiagram data={data} svgRef={svgRef} />}
      </div>
    </div>,
    document.body
  );
}
