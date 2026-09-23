import { UsageDriver, UsageSummary } from "../../api/adminApi";
import EmptyState from "../../components/EmptyState";
import { exportFilename } from "./export";
import { ACCENT, CardHeader, DownloadCsvButton, formatDuration } from "./shared";

/** "Which cases are hard, and why?" -- the per-case cost next to what
 * the case was like, so a slow case can be told apart from a slow tool
 * or a slow person: a 300-slice case with five lesions is expected to
 * take longer than a two-slice one with none. */
export default function CasesTab({ summary }: { summary: UsageSummary }) {
  return (
    <div className="space-y-5">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <DriversCard summary={summary} />
        <FeltDifficultyCard summary={summary} />
      </div>
      <CasesTableCard summary={summary} />
    </div>
  );
}

function strength(r: number): { word: string; tone: string } {
  const a = Math.abs(r);
  if (a >= 0.6) return { word: "strongly", tone: "text-gray-900 font-medium" };
  if (a >= 0.3) return { word: "somewhat", tone: "text-gray-700" };
  return { word: "hardly", tone: "text-gray-400" };
}

function DriverRow({ d }: { d: UsageDriver }) {
  const s = strength(d.r);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm" data-testid="usage-driver" title={`Pearson r = ${d.r} over ${d.n} cases`}>
      <div className="min-w-0">
        <div className={s.tone}>
          Hands-on time {s.word} {d.r >= 0 ? "rises" : "falls"} with <strong>{d.label}</strong>
        </div>
        <div className="mt-1 h-2 w-full rounded-sm bg-gray-100">
          <div className="h-2 rounded-sm" style={{ width: `${Math.max(Math.abs(d.r) * 100, 2)}%`, background: ACCENT }} />
        </div>
      </div>
      <span className="w-20 text-right text-xs tabular-nums text-gray-500">
        r = {d.r} · {d.n}
      </span>
    </li>
  );
}

function DriversCard({ summary }: { summary: UsageSummary }) {
  const c = summary.complexity;
  const devices = Object.entries(summary.effort_by_device).filter(([, e]) => e.cases > 0);
  return (
    <div className="card" data-guide="usage-case-drivers" data-testid="usage-case-drivers">
      <CardHeader
        title="What makes a case expensive"
        hint={
          <>
            How closely hands-on time moves with each property of the case, over the cases worked in this period (r: 0 = unrelated, 1 = moves in lockstep; needs at least 5 cases). It describes, it doesn't prove a cause -- but the strongest one is where making a case cheaper pays off.
          </>
        }
      />
      <p className="mb-3 text-sm text-gray-600">
        {c.cases} cases worked · median hands-on time <strong>per object drawn: {formatDuration(c.per_object_median_ms)}</strong>
      </p>
      {c.drivers.length === 0 ? (
        <EmptyState message="Needs at least 5 worked cases to say what drives the effort." />
      ) : (
        <ul className="space-y-3">
          {c.drivers.map((d) => (
            <DriverRow key={d.factor} d={d} />
          ))}
        </ul>
      )}
      {devices.length > 1 && (
        <div className="mt-4 border-t border-gray-100 pt-3" data-testid="usage-device-split">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Tablet (touch) vs. mouse</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-400">
                <th className="text-left font-normal">Input</th>
                <th className="text-right font-normal">Cases</th>
                <th className="text-right font-normal">Hands-on / case</th>
                <th className="text-right font-normal">Wait before first action</th>
              </tr>
            </thead>
            <tbody>
              {devices.map(([device, e]) => (
                <tr key={device}>
                  <td className="capitalize">{device}</td>
                  <td className="text-right tabular-nums">{e.cases}</td>
                  <td className="text-right tabular-nums">{formatDuration(e.active_median_ms)}</td>
                  <td className="text-right tabular-nums">{formatDuration(e.first_input_median_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const FELT = ["", "Easy", "Fine", "Some effort", "Hard", "Very demanding"];

function FeltDifficultyCard({ summary }: { summary: UsageSummary }) {
  const r = summary.ratings;
  const max = Math.max(1, ...Object.values(r.distribution));
  return (
    <div className="card" data-guide="usage-felt" data-testid="usage-felt">
      <CardHeader
        title="How demanding cases feel"
        hint="After every few finished cases the viewer asks, in one optional click, how demanding it was (1 easy, 5 very demanding). The only direct measure of mental effort here -- time and clicks can't tell hard thinking from slow tools."
      />
      {r.count === 0 ? (
        <EmptyState message="No answers yet -- they come in as people finish cases (how often it asks is in Settings)." />
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-600">
            Average <strong className="tabular-nums">{r.mean}</strong> of 5 from {r.count} answers
          </p>
          <ul className="space-y-1.5" data-testid="usage-felt-distribution">
            {[1, 2, 3, 4, 5].map((n) => {
              const count = r.distribution[String(n)] ?? 0;
              return (
                <li key={n} className="grid grid-cols-[7.5rem_minmax(0,1fr)_2rem] items-center gap-2 text-sm">
                  <span className="text-gray-600">
                    {n} · {FELT[n]}
                  </span>
                  <div className="h-2 rounded-sm bg-gray-100">
                    <div className="h-2 rounded-sm" style={{ width: `${(count / max) * 100}%`, background: ACCENT }} />
                  </div>
                  <span className="text-right tabular-nums text-gray-900">{count}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function CasesTableCard({ summary }: { summary: UsageSummary }) {
  const rows = summary.cases;
  return (
    <div className="card" data-guide="usage-cases" data-testid="usage-cases">
      <CardHeader
        title="Cases worked"
        hint="Every case opened in the viewer from a job in this period, most hands-on time first. Compare within a row: a long time on a case with many objects is the case; a long time on a small case is the tool or the workflow."
        actions={
          <DownloadCsvButton
            filename={exportFilename("cases", summary.since, summary.until, "csv")}
            rows={rows}
            columns={[
              { header: "Case", value: (r) => r.case_title ?? r.case_id },
              { header: "Case id", value: (r) => r.case_id },
              { header: "Job", value: (r) => r.job_type },
              { header: "Job id", value: (r) => r.job_id },
              { header: "People", value: (r) => r.people.join(" ") },
              { header: "Sittings", value: (r) => r.sittings },
              { header: "Hands-on (ms)", value: (r) => r.active_ms },
              { header: "Slices", value: (r) => r.slices },
              { header: "Objects", value: (r) => r.objects },
              { header: "Per object (ms)", value: (r) => r.per_object_ms },
              { header: "Undos", value: (r) => r.undos },
              { header: "Wait before first action (ms)", value: (r) => r.first_input_ms },
              { header: "Felt difficulty (1-5)", value: (r) => r.rating },
              { header: "Sent back", value: (r) => r.sent_back },
            ]}
            testId="usage-export-cases"
          />
        }
      />
      {rows.length === 0 ? (
        <EmptyState message="No case was worked in the viewer in this period." />
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Case</th>
                <th>Job</th>
                <th>People</th>
                <th className="text-right" title="Active time in the viewer across every sitting, idle stretches left out">
                  Hands-on
                </th>
                <th className="text-right" title="Separate sittings it took">
                  Sittings
                </th>
                <th className="text-right" title="Images in its largest series">
                  Slices
                </th>
                <th className="text-right" title="Objects in its latest annotation">
                  Objects
                </th>
                <th className="text-right" title="Hands-on time divided by objects -- the fairest way to compare cases">
                  Per object
                </th>
                <th className="text-right">Undos</th>
                <th className="text-right" title="From opening the case to the first click or key">
                  First action
                </th>
                <th className="text-right" title="Average of the 1-5 answers about this case">
                  Felt
                </th>
                <th className="text-right" title="Times a review sent it back">
                  Sent back
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.job_id}-${r.case_id}`} data-testid="usage-case-row">
                  <td className="max-w-[14rem] truncate" title={r.case_title ?? r.case_id}>
                    {r.case_title ?? r.case_id.slice(0, 8)}
                  </td>
                  <td className="capitalize">{r.job_type ?? "–"}</td>
                  <td className="text-xs text-gray-500">{r.people.join(", ")}</td>
                  <td className="text-right tabular-nums" title={r.active_ms ? undefined : "Not measured: the sitting never ended cleanly (tab closed or crashed), so its time is unknown"}>
                    {r.active_ms ? formatDuration(r.active_ms) : "–"}
                  </td>
                  <td className="text-right tabular-nums">{r.sittings}</td>
                  <td className="text-right tabular-nums">{r.slices ?? "–"}</td>
                  <td className="text-right tabular-nums">{r.objects ?? "–"}</td>
                  <td className="text-right tabular-nums">{formatDuration(r.per_object_ms)}</td>
                  <td className="text-right tabular-nums">{r.undos}</td>
                  <td className="text-right tabular-nums">{formatDuration(r.first_input_ms)}</td>
                  <td className="text-right tabular-nums">{r.rating ?? "–"}</td>
                  <td className={`text-right tabular-nums ${r.sent_back ? "font-semibold text-red-700" : ""}`}>{r.sent_back}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
