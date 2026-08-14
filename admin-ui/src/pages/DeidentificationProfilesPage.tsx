import { FormEvent, useEffect, useState } from "react";

import {
  addDeidentificationRule,
  createDeidentificationProfile,
  DeidentificationProfile,
  listDeidentificationProfiles,
} from "../api/adminApi";

export default function DeidentificationProfilesPage() {
  const [profiles, setProfiles] = useState<DeidentificationProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  function refresh() {
    listDeidentificationProfiles()
      .then(setProfiles)
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    try {
      await createDeidentificationProfile(name, isDefault);
      setName("");
      setIsDefault(false);
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="page-title">De-identification profiles</h1>
      {error && <p className="alert-error">{error}</p>}

      {profiles.length === 0 && <p className="hint">No profiles yet -- create one below.</p>}
      {profiles.map((profile) => (
        <ProfileCard key={profile.id} profile={profile} onRuleAdded={refresh} />
      ))}

      <div className="card">
        <h2 className="section-title mb-4">New profile</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-4">
          <div className="field flex-1">
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
            />
            Default profile
          </label>
          <button type="submit" className="btn-primary">
            Create
          </button>
        </form>
      </div>
    </div>
  );
}

function ProfileCard({ profile, onRuleAdded }: { profile: DeidentificationProfile; onRuleAdded: () => void }) {
  const [dicomTag, setDicomTag] = useState("(0010,0010)");
  const [action, setAction] = useState("hash");
  const [replacementValue, setReplacementValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleAddRule(event: FormEvent) {
    event.preventDefault();
    try {
      await addDeidentificationRule(profile.id, dicomTag, action, replacementValue);
      setReplacementValue("");
      onRuleAdded();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="card">
      <div className="mb-4 flex items-center gap-2">
        <h3 className="section-title">{profile.name}</h3>
        {profile.is_default && <span className="badge-green">default</span>}
      </div>
      {error && <p className="alert-error mb-3">{error}</p>}

      <div className="table-wrap mb-4">
        <table>
          <thead>
            <tr>
              <th>DICOM tag</th>
              <th>Action</th>
              <th>Replacement</th>
            </tr>
          </thead>
          <tbody>
            {profile.rules.length === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-center text-gray-400">
                  No rules yet.
                </td>
              </tr>
            )}
            {profile.rules.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.dicom_tag}</td>
                <td>
                  <span className="badge-gray">{r.action}</span>
                </td>
                <td>{r.replacement_value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={handleAddRule} className="flex flex-wrap items-end gap-3">
        <div className="field">
          <label className="label">DICOM tag</label>
          <input
            className="input w-40"
            value={dicomTag}
            onChange={(e) => setDicomTag(e.target.value)}
            placeholder="(gggg,eeee)"
            required
          />
        </div>
        <div className="field">
          <label className="label">Action</label>
          <select className="input w-40" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="keep">keep</option>
            <option value="remove">remove</option>
            <option value="replace_fixed">replace_fixed</option>
            <option value="hash">hash</option>
          </select>
        </div>
        {action === "replace_fixed" && (
          <div className="field">
            <label className="label">Replacement value</label>
            <input
              className="input w-40"
              value={replacementValue}
              onChange={(e) => setReplacementValue(e.target.value)}
            />
          </div>
        )}
        <button type="submit" className="btn-secondary">
          Add rule
        </button>
      </form>
    </div>
  );
}
