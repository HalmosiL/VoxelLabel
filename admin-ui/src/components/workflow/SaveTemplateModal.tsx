import { FormEvent, useState } from "react";

import Modal from "../Modal";

/** Asks for a title/description before saving the current selection to
 * the Store as a reusable template -- the actual card/edge snapshotting
 * happens in WorkflowBoardPage (this modal only collects the two text
 * fields nothing else can infer). */
export default function SaveTemplateModal({
  cardCount,
  onClose,
  onSave,
}: {
  cardCount: number;
  onClose: () => void;
  onSave: (title: string, description: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    onSave(title.trim(), description.trim());
  }

  return (
    <Modal title="Save to Store" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="hint">
          The selected {cardCount} card(s) (and the connections between them) will become a new, reusable template in
          the Store for everyone who builds boards. It keeps the structure, surfaces and label forms; who is assigned
          each job and which cases a dataset holds stay with this study -- you pick assignees after inserting. Cards a
          Split or Review makes when it runs are made fresh on insert.
        </p>
        <label className="field">
          <span className="label">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
        </label>
        <label className="field">
          <span className="label">Description</span>
          <textarea
            className="input"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this pipeline good for?"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            Cancel
          </button>
          <button type="submit" className="btn-secondary btn-sm" disabled={!title.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
