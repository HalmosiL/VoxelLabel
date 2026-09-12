import { FormEvent, Fragment, useEffect, useState } from "react";

import {
  getNotificationSettings,
  getNotificationStatus,
  listNotificationLog,
  listNotificationPreferences,
  NotificationLogEntry,
  NotificationPreference,
  NotificationSettings,
  NotificationStatus,
  runNotificationCheckNow,
  sendTestNotificationEmail,
  updateNotificationPreferences,
  updateNotificationSettings,
} from "../api/adminApi";
import { describeApiError } from "../api/client";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { NOTIFICATIONS_STEPS } from "../guide/adminSteps";
import { useRegisterGuide } from "../guide/GuideContext";

const POLL_MS = 10000;

const EVENT_LABELS: Record<string, string> = {
  job_assigned: "New job",
  job_status_changed: "Job status",
  test: "Test email",
};

const STATUS_BADGE: Record<NotificationLogEntry["status"], string> = {
  sent: "badge-green",
  failed: "badge-red",
  skipped: "badge-gray",
};

/** Platform admin's page for the notification service: where email goes
 * out through (and a test send), whether it's on, what the background
 * check is doing, who gets which kind of email, and what was actually
 * sent/skipped/failed. */
export default function NotificationsPage() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [log, setLog] = useState<NotificationLogEntry[] | null>(null);
  const [prefs, setPrefs] = useState<NotificationPreference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function refreshLive() {
    getNotificationStatus().then(setStatus).catch((err) => setError(describeApiError(err)));
    listNotificationLog().then(setLog).catch((err) => setError(describeApiError(err)));
  }

  useEffect(() => {
    getNotificationSettings().then(setSettings).catch((err) => setError(describeApiError(err)));
    listNotificationPreferences().then(setPrefs).catch((err) => setError(describeApiError(err)));
    refreshLive();
    const handle = window.setInterval(refreshLive, POLL_MS);
    return () => window.clearInterval(handle);
  }, []);

  async function handleRunNow() {
    setError(null);
    try {
      const result = await runNotificationCheckNow();
      setNotice(
        result
          ? `Checked ${result.cards} job${result.cards === 1 ? "" : "s"}: ${result.events} change${result.events === 1 ? "" : "s"} found, ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed.`
          : "Check finished."
      );
      refreshLive();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  useRegisterGuide("notifications", NOTIFICATIONS_STEPS, status !== null && settings !== null, false);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notifications"
        subtitle="Emails people automatically when a job is assigned to them or its status changes (To do / In progress / Done). Never per case -- one job, one message."
        action={
          <button onClick={handleRunNow} className="btn-secondary btn-sm" data-guide="notif-run-now">
            Check for changes now
          </button>
        }
      />
      {error && <p className="alert-error">{error}</p>}
      {notice && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">{notice}</p>
      )}

      {status && <StatusCard status={status} />}
      {settings && (
        <SettingsCard
          settings={settings}
          onSaved={(s) => {
            setSettings(s);
            setNotice("Delivery settings saved.");
            refreshLive();
          }}
          onError={setError}
          onNotice={setNotice}
        />
      )}
      <PreferencesCard prefs={prefs} onChange={setPrefs} onError={setError} />
      <LogCard log={log} />
    </div>
  );
}

function StatusCard({ status }: { status: NotificationStatus }) {
  const tone = !status.enabled
    ? "border-amber-200 bg-amber-50 text-amber-800"
    : status.last_error
      ? "border-red-200 bg-red-50 text-red-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-800";
  return (
    <div className={`rounded-lg border px-3.5 py-2.5 text-sm ${tone}`} data-testid="notification-status" data-guide="notif-status">
      <span className="font-medium">
        {!status.enabled ? "Email delivery is off" : status.last_error ? "Last check failed" : "Email delivery is on"}
      </span>
      {" · "}
      the service checks every job every {status.poll_interval_seconds}s
      {status.last_run_at && ` · last check ${new Date(status.last_run_at).toLocaleTimeString()}`}
      {status.last_result &&
        ` (${status.last_result.cards} jobs, ${status.last_result.events} changes, ${status.last_result.sent} sent)`}
      {status.last_error && ` · ${status.last_error}`}
      {!status.enabled && " · changes are still detected and logged as skipped, so nothing is replayed when you switch it on."}
    </div>
  );
}

function SettingsCard({
  settings,
  onSaved,
  onError,
  onNotice,
}: {
  settings: NotificationSettings;
  onSaved: (s: NotificationSettings) => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string | null) => void;
}) {
  const [form, setForm] = useState({ ...settings, smtp_password: "" });
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setForm({ ...settings, smtp_password: "" }), [settings]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      const saved = await updateNotificationSettings({
        enabled: form.enabled,
        smtp_host: form.smtp_host,
        smtp_port: Number(form.smtp_port),
        smtp_username: form.smtp_username || null,
        smtp_password: form.smtp_password === "" ? null : form.smtp_password,
        smtp_use_tls: form.smtp_use_tls,
        smtp_use_ssl: form.smtp_use_ssl,
        from_address: form.from_address,
        platform_base_url: form.platform_base_url,
        poll_interval_seconds: Number(form.poll_interval_seconds),
      });
      onSaved(saved);
    } catch (err) {
      onError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setBusy(true);
    onError(null);
    try {
      const result = await sendTestNotificationEmail(testTo || undefined);
      onNotice(`Test email sent to ${result.to} (through the saved settings).`);
    } catch (err) {
      onError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card flex flex-col gap-4" data-testid="notification-settings" data-guide="notif-settings">
      <div>
        <h2 className="section-title mb-1">Email delivery</h2>
        <p className="hint">
          The SMTP server the platform sends through. In the local stack the Mailpit sandbox (host <code>mailpit</code>,
          port 1025) catches everything and shows it at{" "}
          <a href="http://localhost:8025" target="_blank" rel="noreferrer" className="underline">
            localhost:8025
          </a>{" "}
          -- nothing leaves the machine until you point this at a real server.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        Send emails (switch on delivery)
      </label>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="field">
          <span className="label">SMTP host</span>
          <input className="input" value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} required />
        </label>
        <label className="field">
          <span className="label">SMTP port</span>
          <input className="input" type="number" min={1} max={65535} value={form.smtp_port} onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })} required />
        </label>
        <label className="field">
          <span className="label">Username (optional)</span>
          <input className="input" value={form.smtp_username ?? ""} onChange={(e) => setForm({ ...form, smtp_username: e.target.value })} />
        </label>
        <label className="field">
          <span className="label">Password {settings.smtp_password_set ? "(one is stored -- leave blank to keep it)" : "(optional)"}</span>
          <input className="input" type="password" autoComplete="new-password" value={form.smtp_password} onChange={(e) => setForm({ ...form, smtp_password: e.target.value })} />
        </label>
        <label className="field">
          <span className="label">From address</span>
          <input className="input" value={form.from_address} onChange={(e) => setForm({ ...form, from_address: e.target.value })} required />
          <span className="hint">e.g. VoxelLabel &lt;no-reply@your-hospital.example&gt;</span>
        </label>
        <label className="field">
          <span className="label">Platform address (for links in emails)</span>
          <input className="input" value={form.platform_base_url} onChange={(e) => setForm({ ...form, platform_base_url: e.target.value })} required />
        </label>
        <label className="field">
          <span className="label">Check for changes every (seconds)</span>
          <input className="input" type="number" min={10} value={form.poll_interval_seconds} onChange={(e) => setForm({ ...form, poll_interval_seconds: Number(e.target.value) })} required />
          <span className="hint">How often every job is re-checked for a new assignee, status or case change.</span>
        </label>
        <div className="field">
          <span className="label">Connection security</span>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.smtp_use_tls} onChange={(e) => setForm({ ...form, smtp_use_tls: e.target.checked, smtp_use_ssl: e.target.checked ? false : form.smtp_use_ssl })} />
            STARTTLS (usually port 587)
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.smtp_use_ssl} onChange={(e) => setForm({ ...form, smtp_use_ssl: e.target.checked, smtp_use_tls: e.target.checked ? false : form.smtp_use_tls })} />
            Implicit TLS / SSL (usually port 465)
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4">
        <button type="submit" className="btn-primary btn-sm" disabled={busy}>
          Save settings
        </button>
        <span className="mx-1 text-gray-300">|</span>
        <input className="input w-64" placeholder="test address (defaults to your own)" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
        <button type="button" onClick={handleTest} className="btn-secondary btn-sm" disabled={busy}>
          Send test email
        </button>
        <span className="hint">Uses the saved settings -- save first if you changed anything.</span>
      </div>
    </form>
  );
}

function PreferencesCard({
  prefs,
  onChange,
  onError,
}: {
  prefs: NotificationPreference[] | null;
  onChange: (p: NotificationPreference[]) => void;
  onError: (msg: string | null) => void;
}) {
  async function toggle(p: NotificationPreference, key: keyof NotificationPreference) {
    if (!prefs) return;
    const next = !p[key];
    onChange(prefs.map((x) => (x.user_id === p.user_id ? { ...x, [key]: next } : x)));
    try {
      await updateNotificationPreferences(p.user_id, { [key]: next });
    } catch (err) {
      onError(describeApiError(err));
      onChange(prefs);
    }
  }
  const columns: { key: keyof NotificationPreference; label: string }[] = [
    { key: "email_enabled", label: "Any email" },
    { key: "notify_new_job", label: "New job" },
    { key: "notify_status_change", label: "Job status" },
  ];
  return (
    <div className="card" data-testid="notification-preferences" data-guide="notif-preferences">
      <h2 className="section-title mb-1">Who gets which email</h2>
      <p className="hint mb-4">
        Every account, with the address the service would deliver to (set on the Users page) and what they've opted into.
        People can also change their own row from My Jobs.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Email address</th>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prefs && prefs.length === 0 && (
              <tr>
                <td colSpan={2 + columns.length}>
                  <EmptyState message="No users found." />
                </td>
              </tr>
            )}
            {(prefs ?? []).map((p) => (
              <tr key={p.user_id}>
                <td className="font-medium text-gray-800">{p.username ?? p.user_id.slice(0, 8)}</td>
                <td className="text-sm text-gray-500">{p.email ?? <span className="text-amber-700">no address -- emails will be skipped</span>}</td>
                {columns.map((c) => (
                  <td key={c.key}>
                    <input type="checkbox" checked={Boolean(p[c.key])} disabled={c.key !== "email_enabled" && !p.email_enabled} onChange={() => toggle(p, c.key)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LogCard({ log }: { log: NotificationLogEntry[] | null }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="card" data-testid="notification-log" data-guide="notif-log">
      <h2 className="section-title mb-1">Delivery log</h2>
      <p className="hint mb-4">Every email the service decided about, newest first -- click a row to read it.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Kind</th>
              <th>To</th>
              <th>Subject</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {log && log.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState message="Nothing yet -- the log fills as jobs change." />
                </td>
              </tr>
            )}
            {(log ?? []).map((r) => (
              <Fragment key={r.id}>
                <tr className="cursor-pointer hover:bg-gray-50" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                  <td className="whitespace-nowrap text-sm text-gray-500">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="text-sm">{EVENT_LABELS[r.event_type] ?? r.event_type}</td>
                  <td className="text-sm text-gray-600">{r.email ?? "-"}</td>
                  <td className="text-sm">{r.subject}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[r.status]}`} title={r.error ?? undefined}>
                      {r.status}
                      {r.error && " ⓘ"}
                    </span>
                  </td>
                </tr>
                {openId === r.id && (
                  <tr>
                    <td colSpan={5} className="bg-gray-50/60">
                      {r.error && <p className="mb-2 text-sm text-red-700">{r.error}</p>}
                      <pre className="whitespace-pre-wrap font-sans text-sm text-gray-700">{r.body}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
