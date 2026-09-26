import { useEffect, useState } from "react";

import { clearUsageLog, deleteUsageClear, listUsageClears, restoreUsageClear, updateUsageSettings, UsageClear, UsageClears, UsagePerson, UsageSettings } from "../../api/adminApi";
import { describeApiError } from "../../api/client";
import Modal from "../../components/Modal";
import { formatWhen } from "./shared";

const CATEGORIES: { key: keyof UsageSettings; label: string; hint: string }[] = [
  { key: "track_pages", label: "Pages & time", hint: "which screens open, how long they stay open, focus and idle gaps" },
  { key: "track_actions", label: "Actions", hint: "viewer tools, save, Mark as Annotated, Submit review, Run, create" },
  { key: "track_clicks", label: "Clicks", hint: "where on the screen and on which control" },
  { key: "track_mouse", label: "Mouse movement", hint: "sampled pointer traces for the replay and heatmap" },
  { key: "track_scroll", label: "Scrolling", hint: "how far down a page people get; wheel use in the viewer" },
  { key: "track_keys", label: "Keyboard shortcuts", hint: "key names only, never anything typed into a field" },
  { key: "track_errors", label: "Errors", hint: "JavaScript errors, with the screen they happened on" },
  { key: "track_perf", label: "Request timings", hint: "how long each API call took, summed per endpoint -- which ones people wait on" },
  { key: "track_screen_images", label: "Case images in screen pictures", hint: "the slices as they were on screen, behind the replay and the heatmap -- off: grey blocks. Much bigger; rides on Clicks" },
];

export default function SettingsTab({
  settings,
  people,
  onSaved,
  onSwitch,
  onOpenSessions,
  onLogChanged,
  onError,
}: {
  settings: UsageSettings;
  people: UsagePerson[] | null;
  onSaved: (s: UsageSettings) => void;
  onSwitch: (userId: string, change: { enabled?: boolean; counted?: boolean }) => void;
  onOpenSessions: (userId: string, username: string) => void;
  /** The log was cleared or restored: every figure needs reloading. */
  onLogChanged: () => void;
  onError: (m: string) => void;
}) {
  return (
    <div className="space-y-5">
      <RecordingCard settings={settings} onSaved={onSaved} onError={onError} />
      <WhoCountsCard settings={settings} people={people} onSaved={onSaved} onSwitch={onSwitch} onOpenSessions={onOpenSessions} onError={onError} />
      <ClearLogCard retentionDays={settings.retention_days} onLogChanged={onLogChanged} onError={onError} />
    </div>
  );
}

const STATUS_LABEL: Record<UsageClear["status"], string> = {
  archived: "restorable",
  restored: "restored",
  deleted: "deleted for good",
  expired: "aged out",
};
const STATUS_BADGE: Record<UsageClear["status"], string> = {
  archived: "badge-blue",
  restored: "badge-green",
  deleted: "badge-gray",
  expired: "badge-gray",
};

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Start the usage figures from zero -- without losing anything: a
 * clear moves the whole log aside, and it can be put back until someone
 * deletes it for good (or the retention period ages it out). */
function ClearLogCard({ retentionDays, onLogChanged, onError }: { retentionDays: number; onLogChanged: () => void; onError: (m: string) => void }) {
  const [data, setData] = useState<UsageClears | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState<UsageClear | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: string } | null>(null);

  useEffect(() => {
    listUsageClears()
      .then(setData)
      .catch((err) => onError(describeApiError(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, []);

  async function run(what: string, work: () => Promise<void>) {
    setBusy(what);
    try {
      await work();
    } catch (err) {
      onError(describeApiError(err));
    } finally {
      setBusy(null);
    }
  }

  const clear = () =>
    run("clear", async () => {
      const r = await clearUsageLog();
      setData(r);
      setConfirming(false);
      setNotice({ text: `Cleared ${count(r.clear.events, "event", "events")} and ${count(r.clear.snapshots, "screen picture", "screen pictures")}.`, undo: r.clear.id });
      onLogChanged();
    });
  const restore = (id: string) =>
    run(`restore-${id}`, async () => {
      const r = await restoreUsageClear(id);
      setData(r);
      setNotice({ text: `Restored ${count(r.restored.events, "event", "events")} and ${count(r.restored.snapshots, "screen picture", "screen pictures")}.` });
      onLogChanged();
    });
  const deleteForGood = (id: string) =>
    run(`delete-${id}`, async () => {
      setData(await deleteUsageClear(id));
      setDeleting(null);
      setNotice({ text: "Deleted for good." });
    });

  const live = data?.live ?? null;
  const empty = live !== null && live.events === 0 && live.snapshots === 0;
  return (
    <div className="card" data-testid="usage-clear-log">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-title mb-0">Clear the usage log</h2>
          <p className="hint">
            Starts every figure, finding, replay and heatmap from zero -- and study analytics&apos; working time, which comes from the same log. Nothing is lost: the cleared log waits below and can be restored (merged with whatever was recorded since) until you delete it for good, or for {retentionDays} days, the retention period. The recording switches stay as they are.
          </p>
        </div>
        <button type="button" className="btn btn-danger" disabled={!live || empty || busy !== null} onClick={() => setConfirming(true)} data-testid="usage-clear-log-button">
          Clear the log…
        </button>
      </div>
      <p className="text-sm text-gray-600" data-testid="usage-clear-live">
        {live === null ? "Loading…" : empty ? "The log is empty." : `In the log now: ${count(live.events, "event", "events")}, ${count(live.snapshots, "screen picture", "screen pictures")}.`}
      </p>
      {notice && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800" data-testid="usage-clear-notice">
          <span>{notice.text}</span>
          {notice.undo && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => restore(notice.undo as string)} data-testid="usage-clear-undo">
              Undo
            </button>
          )}
        </div>
      )}
      {data && data.clears.length > 0 && (
        <div className="table-wrap mt-4">
          <table className="w-full text-sm" data-testid="usage-clears">
            <thead>
              <tr>
                <th>Cleared</th>
                <th>By</th>
                <th>What</th>
                <th>Recorded between</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.clears.map((c) => (
                <tr key={c.id} data-testid="usage-clear-row">
                  <td className="whitespace-nowrap">{c.cleared_at ? formatWhen(c.cleared_at) : "–"}</td>
                  <td>{c.cleared_by ?? "–"}</td>
                  <td className="tabular-nums">
                    {count(c.events, "event", "events")}, {count(c.snapshots, "picture", "pictures")}
                    {c.status === "archived" && (c.remaining.events < c.events || c.remaining.snapshots < c.snapshots) && (
                      <span className="block text-xs text-amber-700">{count(c.remaining.events, "event", "events")} left -- the rest aged out</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-xs text-gray-500">{c.first_at && c.last_at ? `${formatWhen(c.first_at)} – ${formatWhen(c.last_at)}` : "–"}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[c.status]}`} data-testid="usage-clear-status">
                      {STATUS_LABEL[c.status]}
                    </span>
                    {c.status === "restored" && c.restored_by && <span className="block text-xs text-gray-400">by {c.restored_by}</span>}
                    {c.status === "deleted" && c.deleted_by && <span className="block text-xs text-gray-400">by {c.deleted_by}</span>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {c.status === "archived" && (
                      <span className="inline-flex gap-2">
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => restore(c.id)} data-testid="usage-clear-restore">
                          {busy === `restore-${c.id}` ? "Restoring…" : "Restore"}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm text-red-700" disabled={busy !== null} onClick={() => setDeleting(c)} data-testid="usage-clear-delete">
                          Delete for good…
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirming && live && (
        <Modal title="Clear the usage log?" onClose={() => setConfirming(false)}>
          <p className="text-sm text-gray-700">
            {count(live.events, "event", "events")} and {count(live.snapshots, "screen picture", "screen pictures")} leave every figure on the Usage page and the working time in study analytics.
          </p>
          <p className="mt-2 text-sm text-gray-700">You can restore them from this card until you delete them for good or they pass the {retentionDays}-day retention period.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={clear} data-testid="usage-clear-confirm">
              {busy === "clear" ? "Clearing…" : "Clear the log"}
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title="Delete for good?" onClose={() => setDeleting(null)}>
          <p className="text-sm text-gray-700">
            The {count(deleting.remaining.events, "event", "events")} and {count(deleting.remaining.snapshots, "screen picture", "screen pictures")} cleared on {deleting.cleared_at ? formatWhen(deleting.cleared_at) : "that day"} are deleted permanently. This cannot be undone.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => deleteForGood(deleting.id)} data-testid="usage-clear-delete-confirm">
              {busy?.startsWith("delete") ? "Deleting…" : "Delete for good"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RecordingCard({ settings, onSaved, onError }: { settings: UsageSettings; onSaved: (s: UsageSettings) => void; onError: (m: string) => void }) {
  const [form, setForm] = useState<UsageSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(settings), [settings]);
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);

  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      const next = await updateUsageSettings({
        enabled: form.enabled,
        track_pages: form.track_pages,
        track_actions: form.track_actions,
        track_clicks: form.track_clicks,
        track_mouse: form.track_mouse,
        track_scroll: form.track_scroll,
        track_keys: form.track_keys,
        track_errors: form.track_errors,
        track_perf: form.track_perf,
        track_screen_images: form.track_screen_images,
        mouse_sample_ms: form.mouse_sample_ms,
        retention_days: form.retention_days,
        rating_every_n: form.rating_every_n,
      });
      onSaved(next);
      setSaved(true);
    } catch (err) {
      onError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const off = settings.disabled_user_ids.length;
  return (
    <div className="card" data-guide="usage-recording" data-testid="usage-recording">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="section-title mb-0">Recording</h2>
          <p className="hint">
            {settings.enabled
              ? off
                ? `Recording everyone except ${off} ${off === 1 ? "person" : "people"} (switched off below).`
                : "Recording everyone. Switch a single person off below."
              : "Recording is off for everyone."}{" "}
            Open tabs pick up a change within five minutes. Typed text is never recorded.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} data-testid="usage-switch-enabled" />
          Record usage
        </label>
      </div>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        {CATEGORIES.map((c) => (
          <label key={c.key} className={`flex items-start gap-2 text-sm ${form.enabled ? "" : "opacity-50"}`} title={c.hint}>
            <input
              type="checkbox"
              className="mt-0.5"
              checked={Boolean(form[c.key])}
              disabled={!form.enabled}
              onChange={(e) => setForm({ ...form, [c.key]: e.target.checked })}
              data-testid={`usage-switch-${c.key}`}
            />
            <span>
              {c.label}
              <span className="block text-xs text-gray-500">{c.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div className="field">
          <label className="label" htmlFor="usage-sample">
            Mouse sample every (ms)
          </label>
          <input id="usage-sample" type="number" className="input w-32" min={20} max={2000} value={form.mouse_sample_ms} onChange={(e) => setForm({ ...form, mouse_sample_ms: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label className="label" htmlFor="usage-rating" title="After finishing a case the viewer asks, in one optional click, how demanding it was. 0 = never.">
            Ask &quot;how demanding?&quot; every n-th case
          </label>
          <input
            id="usage-rating"
            type="number"
            className="input w-32"
            min={0}
            max={50}
            value={form.rating_every_n}
            onChange={(e) => setForm({ ...form, rating_every_n: Number(e.target.value) })}
            data-testid="usage-rating-every"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="usage-retention">
            Keep events for (days)
          </label>
          <input id="usage-retention" type="number" className="input w-32" min={1} max={3650} value={form.retention_days} onChange={(e) => setForm({ ...form, retention_days: Number(e.target.value) })} />
        </div>
        <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={save} data-testid="usage-save-settings">
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && !dirty && <span className="text-sm text-green-700">Saved.</span>}
      </div>
    </div>
  );
}

/** Two separate questions per account: is it recorded at all, and does
 * it count in the figures. A test or demo account can keep recording
 * (its sessions stay replayable) while leaving every number alone. */
function WhoCountsCard({
  settings,
  people,
  onSaved,
  onSwitch,
  onOpenSessions,
  onError,
}: {
  settings: UsageSettings;
  people: UsagePerson[] | null;
  onSaved: (s: UsageSettings) => void;
  onSwitch: (userId: string, change: { enabled?: boolean; counted?: boolean }) => void;
  onOpenSessions: (userId: string, username: string) => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function setExcludeAdmins(value: boolean) {
    setBusy(true);
    try {
      onSaved(await updateUsageSettings({ exclude_admins: value }));
    } catch (err) {
      onError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }
  const notCounted = (people ?? []).filter((p) => !p.counted).length;
  return (
    <div className="card" data-testid="usage-who-counts">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="section-title mb-0">Who counts in the figures</h2>
          <p className="hint">
            Admin, test and demo accounts click around configuring things, not doing the work -- counted, they skew every "how do people work" number. Left out here, they are still recorded (their sessions can still be replayed) but appear in no figure, finding or export.
            {people && ` ${notCounted} of ${people.length} accounts are left out right now.`}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={settings.exclude_admins} disabled={busy} onChange={(e) => setExcludeAdmins(e.target.checked)} data-testid="usage-exclude-admins" />
          Leave out every admin account
        </label>
      </div>
      {people === null ? (
        <p className="hint">Loading…</p>
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th>Account</th>
                <th>Recorded</th>
                <th>Counted in the figures</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const byAdminRule = p.is_admin && settings.exclude_admins;
                return (
                  <tr key={p.user_id} data-testid={`usage-person-${p.username}`}>
                    <td>
                      <span className="font-medium text-gray-800">{p.name || p.username}</span>
                      {p.is_admin && <span className="badge badge-gray ml-2">admin</span>}
                      {p.email && <div className="text-xs text-gray-400">{p.email}</div>}
                    </td>
                    <td>
                      <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={p.recorded} disabled={!settings.enabled} onChange={(e) => onSwitch(p.user_id, { enabled: e.target.checked })} aria-label={`Record ${p.username}`} data-testid={`usage-record-${p.username}`} />
                        {p.recorded ? "on" : "off"}
                      </label>
                    </td>
                    <td>
                      <label className="flex items-center gap-1.5 text-xs" title={byAdminRule ? "Left out by the admin rule above" : undefined}>
                        <input
                          type="checkbox"
                          checked={p.counted}
                          disabled={byAdminRule}
                          onChange={(e) => onSwitch(p.user_id, { counted: e.target.checked })}
                          aria-label={`Count ${p.name || p.username}`}
                          data-testid={`usage-count-${p.username}`}
                        />
                        {byAdminRule ? "no -- admin account" : p.counted ? "yes" : "no -- test account"}
                      </label>
                    </td>
                    <td className="text-right">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpenSessions(p.user_id, p.username)} data-testid={`usage-person-sessions-${p.username}`}>
                        Sessions
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
