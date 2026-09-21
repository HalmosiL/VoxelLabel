import { useEffect, useState } from "react";

import { updateUsageSettings, UsageSettings } from "../../api/adminApi";
import { describeApiError } from "../../api/client";

const CATEGORIES: { key: keyof UsageSettings; label: string; hint: string }[] = [
  { key: "track_pages", label: "Pages & time", hint: "which screens open, how long they stay open, focus and idle gaps" },
  { key: "track_actions", label: "Actions", hint: "viewer tools, save, Mark as Annotated, Submit review, Run, create" },
  { key: "track_clicks", label: "Clicks", hint: "where on the screen and on which control" },
  { key: "track_mouse", label: "Mouse movement", hint: "sampled pointer traces for the replay and heatmap" },
  { key: "track_scroll", label: "Scrolling", hint: "how far down a page people get; wheel use in the viewer" },
  { key: "track_keys", label: "Keyboard shortcuts", hint: "key names only, never anything typed into a field" },
  { key: "track_errors", label: "Errors", hint: "JavaScript errors, with the screen they happened on" },
];

export default function SettingsTab({ settings, onSaved, onError }: { settings: UsageSettings; onSaved: (s: UsageSettings) => void; onError: (m: string) => void }) {
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
        mouse_sample_ms: form.mouse_sample_ms,
        retention_days: form.retention_days,
      });
      onSaved(next);
      setSaved(true);
    } catch (err) {
      onError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  const excluded = settings.disabled_user_ids.length;
  return (
    <div className="card" data-guide="usage-recording" data-testid="usage-recording">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="section-title mb-0">Recording</h2>
          <p className="hint">
            {settings.enabled
              ? excluded
                ? `Recording everyone except ${excluded} ${excluded === 1 ? "person" : "people"} (switched off in the People tab).`
                : "Recording everyone. Switch a single person off in the People tab."
              : "Recording is off for everyone."}{" "}
            Open tabs pick up a change within five minutes. Patient data and typed text are never recorded whatever is switched on here.
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
