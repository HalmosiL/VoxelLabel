import { FormEvent, useEffect, useState } from "react";

import { createKeycloakUser, KeycloakUser, listKeycloakUsers } from "../api/adminApi";
import Avatar from "../components/Avatar";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";

/** Global user management -- lists every realm account and lets an admin
 * create new ones directly (a real Keycloak account with a temporary
 * password, not just an existing user picked for a study). Per-study
 * roles (data_manager/annotator/reviewer/viewer) are still assigned via
 * each Study's Members panel; the only role fixed here is the platform-
 * wide "admin" flag, since that's the only role Keycloak itself knows
 * about (see infra/keycloak/setup-dev-realm.sh). */
export default function UsersPage() {
  const [users, setUsers] = useState<KeycloakUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listKeycloakUsers()
      .then(setUsers)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Users" subtitle="Every account in this platform's realm, and its global admin flag." />
      {error && <p className="alert-error">{error}</p>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={3}>
                    <EmptyState message="No users yet -- create one below." />
                  </td>
                </tr>
              )}
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <Avatar id={u.id} />
                      <span className="text-sm text-gray-700">{u.username ?? u.id}</span>
                    </div>
                  </td>
                  <td className="text-sm text-gray-500">{u.email ?? "—"}</td>
                  <td>
                    {u.is_admin ? <span className="badge-green">admin</span> : <span className="badge-gray">standard</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <NewUserForm onCreated={refresh} />
    </div>
  );
}

function NewUserForm({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"standard" | "admin">("standard");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createKeycloakUser({
        username,
        email,
        first_name: firstName,
        last_name: lastName,
        password,
        is_admin: role === "admin",
      });
      setUsername("");
      setEmail("");
      setFirstName("");
      setLastName("");
      setPassword("");
      setRole("standard");
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2 className="section-title mb-1">New user</h2>
      <p className="hint mb-4">
        Creates a real account with a temporary password -- the user sets their own password the first time they log in.
      </p>
      {error && <p className="alert-error mb-3">{error}</p>}

      <form onSubmit={handleCreate} className="flex max-w-sm flex-col gap-4">
        <label className="field">
          <span className="label">Username</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span className="label">Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span className="label">First name</span>
          <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
        </label>
        <label className="field">
          <span className="label">Last name</span>
          <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
        </label>
        <label className="field">
          <span className="label">Temporary password</span>
          <input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label className="field">
          <span className="label">Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as "standard" | "admin")}>
            <option value="standard">Standard user</option>
            <option value="admin">Platform admin</option>
          </select>
        </label>
        <button type="submit" className="btn-primary self-start" disabled={submitting}>
          Create
        </button>
      </form>
    </div>
  );
}
