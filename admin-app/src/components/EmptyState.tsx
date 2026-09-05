export default function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><div>✓</div><h3>{title}</h3><p>{copy}</p></div>
}
