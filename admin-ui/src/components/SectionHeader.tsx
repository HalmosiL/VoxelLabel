import { ReactNode } from "react";

export default function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="section-title">{title}</h2>
      {action}
    </div>
  );
}
