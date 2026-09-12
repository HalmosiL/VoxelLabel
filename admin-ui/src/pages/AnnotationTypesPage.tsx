import { FormEvent, useEffect, useState } from "react";

import { AnnotationType, createAnnotationType, listAnnotationTypes } from "../api/adminApi";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { describeApiError } from "../api/client";
import { ANNOTATION_TYPES_STEPS } from "../guide/adminSteps";
import { useRegisterGuide } from "../guide/GuideContext";

const EXAMPLE_SCHEMA = JSON.stringify(
  {
    type: "object",
    required: ["x", "y", "width", "height"],
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
    },
  },
  null,
  2
);

export default function AnnotationTypesPage() {
  const [types, setTypes] = useState<AnnotationType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [schemaText, setSchemaText] = useState(EXAMPLE_SCHEMA);

  function refresh() {
    listAnnotationTypes()
      .then(setTypes)
      .catch((err) => setError(describeApiError(err)));
  }

  useEffect(refresh, []);
  useRegisterGuide("annotation-types", ANNOTATION_TYPES_STEPS, true, false);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    try {
      const schema = JSON.parse(schemaText);
      await createAnnotationType(name, schema);
      setName("");
      refresh();
    } catch (err) {
      setError(describeApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Annotation types"
        subtitle="Register the payload shapes annotators can use -- new types can be added anytime without a deployment."
      />
      {error && <p className="alert-error">{error}</p>}

      <div className="table-wrap" data-guide="types-table">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>JSON Schema</th>
            </tr>
          </thead>
          <tbody>
            {types.length === 0 && (
              <tr>
                <td colSpan={2}>
                  <EmptyState message="No annotation types registered yet." />
                </td>
              </tr>
            )}
            {types.map((t) => (
              <tr key={t.id}>
                <td>
                  <span className="badge-blue">{t.name}</span>
                </td>
                <td>
                  <code className="code-chip">{JSON.stringify(t.json_schema)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" data-guide="new-type">
        <h2 className="section-title mb-4">Register a new type</h2>
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <label className="field">
            <span className="label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span className="label">JSON Schema (payload validation)</span>
            <textarea
              className="input font-mono text-xs"
              rows={10}
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-primary self-start">
            Register
          </button>
        </form>
      </div>
    </div>
  );
}
