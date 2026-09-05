export default function ProjectMark({ className = '' }: { className?: string }) {
  return <div className={`project-mark ${className}`} aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M24 5 41 15v18L24 43 7 33V15L24 5Z"/><path d="M24 13v22M14.5 18.5 24 24l9.5-5.5M14.5 29.5 24 24l9.5 5.5"/></svg></div>
}
