import { FormEvent, useEffect, useState } from "react";

import {
  addDeidentificationRule,
  createDeidentificationProfile,
  DeidentificationProfile,
  listDeidentificationProfiles,
} from "../api/adminApi";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { describeApiError } from "../api/client";
import { DEID_STEPS } from "../guide/adminSteps";
import { useRegisterGuide } from "../guide/GuideContext";

export default function DeidentificationProfilesPage() {
  const [profiles, setProfiles] = useState<DeidentificationProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  function refresh() {
    listDeidentificationProfiles()
      .then(setProfiles)
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(refresh, []);
  useRegisterGuide("deidentification", DEID_STEPS, true, false);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    try {
      await createDeidentificationProfile(name, isDefault);
      setName("");
      setIsDefault(false);
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="De-identification profiles"
        subtitle="Configure how DICOM tags are handled on import. Choose a study's profile under Edit study; the one marked default applies to every study without its own."
      />
      {error && <p className="alert-error">{error}</p>}

      {profiles.length === 0 && <EmptyState message="No profiles yet -- create one below." />}
      {profiles.map((profile, i) => (
        <ProfileCard key={profile.id} profile={profile} onRuleAdded={refresh} first={i === 0} />
      ))}

      <div className="card" data-guide="new-profile">
        <h2 className="section-title mb-4">New profile</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-4">
          <label className="field flex-1">
            <span className="label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
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

/** `first`: only the first profile carries the page tour's data-guide anchors. */
function ProfileCard({ profile, onRuleAdded, first }: { profile: DeidentificationProfile; onRuleAdded: () => void; first: boolean }) {
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
      setError(describeApiError(err));
    }
  }

  return (
    <div className="card" data-guide={first ? "profile" : undefined}>
      <div className="mb-4 flex items-center gap-3">
        <span className="stat-icon bg-brand-50 text-brand-600" style={{ height: "2.25rem", width: "2.25rem" }}>
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path
              fillRule="evenodd"
              d="M10 1l7 3v6c0 4.418-3.134 7.803-7 9-3.866-1.197-7-4.582-7-9V4l7-3zm0 3.5a1 1 0 00-1 1v4a1 1 0 001 1 1 1 0 001-1v-4a1 1 0 00-1-1zm0 8a1 1 0 100 2 1 1 0 000-2z"
              clipRule="evenodd"
            />
          </svg>
        </span>
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

      <form onSubmit={handleAddRule} className="flex flex-wrap items-end gap-3" data-guide={first ? "add-rule" : undefined}>
        <label className="field">
          <span className="label">DICOM tag</span>
          <input
            className="input w-40"
            value={dicomTag}
            onChange={(e) => setDicomTag(e.target.value)}
            placeholder="(gggg,eeee)"
            required
          />
        </label>
        <label className="field">
          <span className="label">Action</span>
          <select className="input w-40" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="keep">keep</option>
            <option value="remove">remove</option>
            <option value="replace_fixed">replace_fixed</option>
            <option value="hash">hash</option>
          </select>
        </label>
        {action === "replace_fixed" && (
          <label className="field">
            <span className="label">Replacement value</span>
            <input
              className="input w-40"
              value={replacementValue}
              onChange={(e) => setReplacementValue(e.target.value)}
            />
          </label>
        )}
        <button type="submit" className="btn-secondary">
          Add rule
        </button>
      </form>
    </div>
  );
}
