export default function EmptyState({ message }: { message: string }) {
  return (
    <div className="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-9 w-9 text-gray-300">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.75h16.5M3.75 9.75v9a1.5 1.5 0 001.5 1.5h13.5a1.5 1.5 0 001.5-1.5v-9M3.75 9.75l1.72-4.3a1.5 1.5 0 011.4-.95h10.26a1.5 1.5 0 011.4.95l1.72 4.3" />
      </svg>
      <p className="text-sm">{message}</p>
    </div>
  );
}
