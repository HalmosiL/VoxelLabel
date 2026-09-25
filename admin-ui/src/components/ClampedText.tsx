import { useState } from "react";

/** Long text (a reviewer's comment) shortened to a few lines' worth, with
 * "Show more": a 6 000-character comment filled more than the screen and
 * pushed the rest of the case list far down (F-16). */
const LIMIT = 240;

export default function ClampedText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= LIMIT) return <>{text}</>;
  return (
    <>
      {open ? text : `${text.slice(0, LIMIT).trimEnd()}…`}{" "}
      <button type="button" onClick={() => setOpen((o) => !o)} className="font-medium text-brand-600 hover:text-brand-700">
        {open ? "Show less" : "Show more"}
      </button>
    </>
  );
}
