import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  approveRegistrationRequest,
  createKeycloakUser,
  deleteKeycloakUser,
  getKeycloakUser,
  KeycloakUser,
  listKeycloakUsers,
  listRegistrationRequests,
  RegistrationRequest,
  rejectRegistrationRequest,
  resetKeycloakPassword,
  updateKeycloakUser,
} from "../api/adminApi";
import { describeApiError } from "../api/client";
import { roleLabel, useMe } from "../auth/MeContext";
import Avatar from "../components/Avatar";
import EmptyState from "../components/EmptyState";
import { TrashIcon } from "../components/icons";
import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";
import { USERS_STEPS } from "../guide/adminSteps";
import { useRegisterGuide } from "../guide/GuideContext";

/** Global user management: every realm account, with edit (name, email,
 * enabled, platform-admin flag), password reset, delete, and a view of
 * the study memberships each account holds. Per-study roles are still
 * granted on each Study's Members panel -- this page only manages the
 * account itself and the one platform-wide role Keycloak knows about. */
export default function UsersPage() {
  const { me } = useMe();
  const [users, setUsers] = useState<KeycloakUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<KeycloakUser | null>(null);
  const [resetting, setResetting] = useState<KeycloakUser | null>(null);
  const [pendingRequests, setPendingRequests] = useState<RegistrationRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  useRegisterGuide("users", USERS_STEPS, loaded, false);

  function refresh() {
    listKeycloakUsers()
      .then((list) => {
        setUsers(list);
        setLoaded(true);
      })
      .catch((err) => setError(describeApiError(err)));
    listRegistrationRequests("pending")
      .then(setPendingRequests)
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(refresh, []);

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      users
        .filter(
          (u) =>
            !needle ||
            [u.username, u.email, u.first_name, u.last_name].some((v) => (v ?? "").toLowerCase().includes(needle))
        )
        .sort((a, b) => (a.username ?? "").localeCompare(b.username ?? "")),
    [users, needle]
  );

  async function openEdit(u: KeycloakUser) {
    setError(null);
    try {
      setEditing(await getKeycloakUser(u.id));
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function toggleEnabled(u: KeycloakUser) {
    const next = !(u.enabled ?? true);
    // A signed-in session is a short-lived token the services accept until it expires (A-07).
    if (!next && !window.confirm(`Disable ${u.username}? They won't be able to sign in until re-enabled. A session they already have open keeps working for up to 5 minutes.`)) return;
    try {
      await updateKeycloakUser(u.id, { enabled: next });
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  async function handleDelete(u: KeycloakUser) {
    if (
      !window.confirm(
        `Delete the account "${u.username}"? Their study memberships are removed; annotations they made stay attributed to them. A session they already have open keeps working for up to 5 minutes. This cannot be undone.`
      )
    ) {
      return;
    }
    try {
      await deleteKeycloakUser(u.id);
      setNotice(`Deleted ${u.username}.`);
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        subtitle="Every account in this platform's realm. Study roles are granted on each study's Members panel."
        action={
          <button onClick={() => setCreating(true)} className="btn-primary btn-sm" data-guide="new-user">
            New user
          </button>
        }
      />
      {error && <p className="alert-error">{error}</p>}
      {notice && (
        <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-xs font-medium underline">
            Dismiss
          </button>
        </div>
      )}

      <RegistrationRequestsPanel
        requests={pendingRequests}
        onDecided={(message) => {
          setNotice(message);
          refresh();
        }}
        onError={setError}
      />

      <div className="flex items-center justify-between gap-3">
        <input
          className="input max-w-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search by name, username or email…"
          aria-label="Search users"
          data-guide="user-search"
        />
        <p className="hint">
          {visible.length} of {users.length} account{users.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="table-wrap" data-guide="users-table">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Status</th>
              <th>Platform role</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <EmptyState message={users.length === 0 ? "No users yet -- create one." : "No account matches your search."} />
                </td>
              </tr>
            )}
            {visible.map((u) => {
              const isSelf = u.id === me?.subject;
              const enabled = u.enabled ?? true;
              return (
                <tr key={u.id} className={enabled ? "" : "opacity-60"}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <Avatar id={u.id} name={u.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username} />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium text-gray-800">
                          {[u.first_name, u.last_name].filter(Boolean).join(" ") || u.username}
                          {isSelf && <span className="ml-1.5 text-xs font-normal text-gray-400">(you)</span>}
                        </span>
                        <span className="truncate text-xs text-gray-400">{u.username}</span>
                      </div>
                    </div>
                  </td>
                  <td className="text-sm text-gray-500">{u.email ?? "—"}</td>
                  <td>
                    {enabled ? (
                      <span className="badge-green">active</span>
                    ) : (
                      <span className="badge-red">disabled</span>
                    )}
                    {(u.required_actions ?? []).includes("UPDATE_PASSWORD") && (
                      <span className="badge-gray ml-1.5" title="Must choose a new password at the next login">
                        password reset pending
                      </span>
                    )}
                  </td>
                  <td>{u.is_admin ? <span className="badge-blue">Platform admin</span> : <span className="badge-gray">Standard</span>}</td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => openEdit(u)} className="btn-secondary btn-sm">
                        Edit
                      </button>
                      <button onClick={() => setResetting(u)} className="btn-secondary btn-sm">
                        Reset password
                      </button>
                      {!isSelf && (
                        <>
                          <button onClick={() => toggleEnabled(u)} className="btn-secondary btn-sm">
                            {enabled ? "Disable" : "Enable"}
                          </button>
                          <button onClick={() => handleDelete(u)} className="ml-1 text-gray-400 hover:text-red-600" title="Delete account">
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {creating && (
        <NewUserModal
          onClose={() => setCreating(false)}
          onCreated={(u) => {
            setCreating(false);
            setNotice(`Created ${u.username}. They will be asked to choose their own password at first login.`);
            refresh();
          }}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          isSelf={editing.id === me?.subject}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {resetting && (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setNotice(`Password for ${resetting.username} was reset.`);
            setResetting(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** Pending "I'd like an account" submissions from the public register.html
 * page -- approving creates the real Keycloak account (a random one-time
 * password, emailed to them) and rejecting just declines it, both with
 * one click. Hidden entirely once there's nothing pending, so it never
 * competes for attention with the users table on a quiet day. */
function RegistrationRequestsPanel({
  requests,
  onDecided,
  onError,
}: {
  requests: RegistrationRequest[];
  onDecided: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<RegistrationRequest | null>(null);

  async function handleApprove(req: RegistrationRequest) {
    setBusyId(req.id);
    try {
      await approveRegistrationRequest(req.id);
      onDecided(`Approved ${req.username} -- they've been emailed a temporary password.`);
    } catch (err) {
      onError(describeApiError(err));
    } finally {
      setBusyId(null);
    }
  }

  if (requests.length === 0) return null;

  return (
    <div className="card flex flex-col gap-3" data-testid="registration-requests" data-guide="registration-requests">
      <div className="flex items-center justify-between">
        <h2 className="section-title">
          Registration requests
          <span className="badge-blue ml-2">{requests.length} pending</span>
        </h2>
      </div>
      <p className="hint -mt-1">Submitted through the public registration page. Approve to create their account, or decline with an optional reason.</p>
      <div className="flex flex-col divide-y divide-gray-100">
        {requests.map((req) => (
          <div key={req.id} className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-800">
                {req.first_name} {req.last_name} <span className="font-normal text-gray-400">@{req.username}</span>
              </div>
              <div className="truncate text-xs text-gray-500">{req.email}</div>
              {req.note && <div className="mt-1 rounded-md bg-gray-50 px-2.5 py-1.5 text-xs italic text-gray-600">"{req.note}"</div>}
              <div className="mt-1 text-[11px] text-gray-400">Requested {new Date(req.created_at).toLocaleString()}</div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              <button onClick={() => handleApprove(req)} disabled={busyId === req.id} className="btn-primary btn-sm">
                Approve
              </button>
              <button onClick={() => setRejecting(req)} disabled={busyId === req.id} className="btn-secondary btn-sm">
                Decline
              </button>
            </div>
          </div>
        ))}
      </div>
      {rejecting && (
        <RejectRequestModal
          request={rejecting}
          onClose={() => setRejecting(null)}
          onRejected={(message) => {
            setRejecting(null);
            onDecided(message);
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

function RejectRequestModal({
  request,
  onClose,
  onRejected,
  onError,
}: {
  request: RegistrationRequest;
  onClose: () => void;
  onRejected: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await rejectRegistrationRequest(request.id, reason.trim() || undefined);
      onRejected(`Declined ${request.username}'s request.`);
    } catch (err) {
      onError(describeApiError(err));
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Decline ${request.username}'s request`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="field">
          <span className="label">Reason (optional -- included in the email they get)</span>
          <textarea className="input min-h-[80px]" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} autoFocus />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            Cancel
          </button>
          <button type="submit" disabled={submitting} className="btn-primary btn-sm">
            {submitting ? "Declining…" : "Decline request"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NewUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (u: KeycloakUser) => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await createKeycloakUser({
        username,
        email,
        first_name: firstName,
        last_name: lastName,
        password,
        is_admin: isAdmin,
      });
      onCreated(created);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New user" onClose={onClose}>
      <form onSubmit={handleCreate} className="flex flex-col gap-4">
        <p className="hint">
          Creates a real account with a temporary password -- the person sets their own the first time they sign in.
          Add them to a study afterwards from that study's Members panel.
        </p>
        {error && <p className="alert-error">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <label className="field">
            <span className="label">First name</span>
            <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
          </label>
          <label className="field">
            <span className="label">Last name</span>
            <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
          </label>
        </div>
        <label className="field">
          <span className="label">Username</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" />
        </label>
        <label className="field">
          <span className="label">Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span className="label">Temporary password</span>
          <input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          <span className="hint">At least 8 characters; shown in plain text so you can hand it over.</span>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Platform admin (manages every study, users and configuration)
        </label>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserModal({
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  user: KeycloakUser;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(user.first_name ?? "");
  const [lastName, setLastName] = useState(user.last_name ?? "");
  const [email, setEmail] = useState(user.email ?? "");
  const [enabled, setEnabled] = useState(user.enabled ?? true);
  const [isAdmin, setIsAdmin] = useState(user.is_admin);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await updateKeycloakUser(user.id, {
        first_name: firstName,
        last_name: lastName,
        email,
        enabled,
        is_admin: isAdmin,
      });
      onSaved();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Edit ${user.username}`} onClose={onClose} maxWidthClassName="max-w-lg">
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <label className="field">
            <span className="label">First name</span>
            <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
          </label>
          <label className="field">
            <span className="label">Last name</span>
            <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
          </label>
        </div>
        <label className="field">
          <span className="label">Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <div className="flex flex-col gap-2 rounded-lg bg-gray-50 p-3">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={isSelf} />
            Account enabled (can sign in)
          </label>
          <p className="hint -mt-1 pl-6">Disabling ends sign-in at once; a session already open keeps working for up to 5 minutes.</p>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} disabled={isSelf} />
            Platform admin
          </label>
          {isSelf && <span className="hint">You can't disable or demote your own account.</span>}
        </div>

        <div>
          <p className="label mb-1.5">Study memberships</p>
          {(user.memberships ?? []).length === 0 ? (
            <p className="hint">Not a member of any study yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {(user.memberships ?? []).map((m) => (
                <li key={m.study_id} className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-1.5 text-sm">
                  <Link to={`/studies/${m.study_id}`} className="font-medium text-brand-600 hover:text-brand-700">
                    {m.study_name ?? m.study_id}
                  </Link>
                  <span className="badge-blue">{roleLabel(m.role)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="hint mt-1">Roles are changed on each study's Members panel.</p>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onDone }: { user: KeycloakUser; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [temporary, setTemporary] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await resetKeycloakPassword(user.id, password, temporary);
      onDone();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Reset password -- ${user.username}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <p className="alert-error">{error}</p>}
        <label className="field">
          <span className="label">New password</span>
          <input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={temporary} onChange={(e) => setTemporary(e.target.checked)} />
          Temporary -- they must choose their own password at the next sign-in
        </label>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "Resetting…" : "Reset password"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
