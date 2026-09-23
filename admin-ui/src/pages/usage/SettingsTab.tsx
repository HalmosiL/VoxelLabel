import { useEffect, useState } from "react";

import { updateUsageSettings, UsagePerson, UsageSettings } from "../../api/adminApi";
import { describeApiError } from "../../api/client";

const CATEGORIES: { key: keyof UsageSettings; label: string; hint: string }[] = [
  { key: "track_pages", label: "Pages & time", hint: "which screens open, how long they stay open, focus and idle gaps" },
  { key: "track_actions", label: "Actions", hint: "viewer tools, save, Mark as Annotated, Submit review, Run, create" },
  { key: "track_clicks", label: "Clicks", hint: "where on the screen and on which control" },
  { key: "track_mouse", label: "Mouse movement", hint: "sampled pointer traces for the replay and heatmap" },
  { key: "track_scroll", label: "Scrolling", hint: "how far down a page people get; wheel use in the viewer" },
  { key: "track_keys", label: "Keyboard shortcuts", hint: "key names only, never anything typed into a field" },
  { key: "track_errors", label: "Errors", hint: "JavaScript errors, with the screen they happened on" },
  { key: "track_perf", label: "Request timings", hint: "how long each API call took, summed per endpoint -- which ones people wait on" },
];

export default function SettingsTab({
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
  return (
    <div className="space-y-5">
      <RecordingCard settings={settings} onSaved={onSaved} onError={onError} />
      <WhoCountsCard settings={settings} people={people} onSaved={onSaved} onSwitch={onSwitch} onOpenSessions={onOpenSessions} onError={onError} />
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
                      <span className="font-medium text-gray-800">{p.username}</span>
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
                          aria-label={`Count ${p.username}`}
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
