import { FormEvent, useEffect, useState } from "react";

import { AnnotationType, createAnnotationType, listAnnotationTypes } from "../api/adminApi";

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
      .catch((err) => setError(String(err)));
  }

  useEffect(refresh, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    try {
      const schema = JSON.parse(schemaText);
      await createAnnotationType(name, schema);
      setName("");
      refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="page-title">Annotation types</h1>
      {error && <p className="alert-error">{error}</p>}

      <div className="table-wrap">
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
                <td colSpan={2} className="py-6 text-center text-gray-400">
                  No annotation types registered yet.
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

      <div className="card">
        <h2 className="section-title mb-4">Register a new type</h2>
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <div className="field">
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label className="label">JSON Schema (payload validation)</label>
            <textarea
              className="input font-mono text-xs"
              rows={10}
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary self-start">
            Register
          </button>
        </form>
      </div>
    </div>
  );
}
