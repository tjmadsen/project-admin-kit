import ProjectMark from '../components/ProjectMark'
import { projectConfig } from '../lib/project-config'

/** The repository whose Issues hold the backlog (backend.repository, else repository.slug). */
export function githubBacklogRepository(config: { backend?: { repository?: string }; repository: { slug: string } } = projectConfig) {
  return config.backend?.repository || config.repository.slug
}

// Shown by builds configured with backend.type "github": that backend has no
// dashboard, because issues, labels, and comments are the interface.
export default function GitHubBackend() {
  const repository = githubBacklogRepository()
  const prefix = projectConfig.backend?.labelPrefix || 'pa:'
  return (
    <div className="auth-screen">
      <main className="auth-card">
        <ProjectMark className="auth-logo" />
        <p className="eyebrow">GitHub Issues backlog</p>
        <h1>{projectConfig.project.name}</h1>
        <p className="auth-copy">This project uses GitHub Issues for its backlog; manage work there. Agents read labels such as <code>{prefix}waiting:human</code> and act on slash commands like <code>/approve</code> from collaborators with write access.</p>
        <a className="button primary wide" href={`https://github.com/${repository}/issues?q=${encodeURIComponent(`is:open label:${prefix}waiting:human`)}`}>Open work waiting on you</a>
        <p className="auth-footnote"><a href={`https://github.com/${repository}/issues`}>All issues in {repository}</a> · conventions in docs/BACKENDS.md</p>
      </main>
    </div>
  )
}
