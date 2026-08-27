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
    <Modal title="Mentés Store-ba" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <p className="hint">
          A kijelölt {cardCount} kártya (és a köztük lévő kapcsolatok) új, újrafelhasználható sablonként kerül a
          Store-ba -- bárki behúzhatja majd bármelyik study board-jára.
        </p>
        <label className="field">
          <span className="label">Cím</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
        </label>
        <label className="field">
          <span className="label">Leírás</span>
          <textarea
            className="input"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Mire jó ez a pipeline?"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            Mégse
          </button>
          <button type="submit" className="btn-secondary btn-sm" disabled={!title.trim()}>
            Mentés
          </button>
        </div>
      </form>
    </Modal>
  );
}
