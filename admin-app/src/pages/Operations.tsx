import { useState } from 'react'
import PageHeader from '../components/PageHeader'
import { projectConfig } from '../lib/project-config'

const commands = [
  { label: 'Feature smoke test', command: 'scripts/agent-loops/run-loop.sh terra feature --once' },
  { label: 'Bug smoke test', command: 'scripts/agent-loops/run-loop.sh sonnet bug --once' },
  { label: 'Deploy smoke test', command: 'scripts/agent-loops/run-loop.sh configured deploy --once' },
  { label: 'Provision scheduled loops', command: 'scripts/agent-loops/provision-machine.sh install' },
  { label: 'Check runner readiness', command: 'scripts/agent-loops/provision-machine.sh check' },
]

export default function Operations() {
  const [copied, setCopied] = useState('')
  const copy = async (command: string) => { await navigator.clipboard.writeText(command); setCopied(command); window.setTimeout(() => setCopied(''), 1600) }
  return <>
    <PageHeader eyebrow="Runbook" title="Operations" description="The few commands worth keeping close at hand for this lightweight app." />
    <section className="ops-grid">
      <div className="panel"><div className="panel-heading"><div><p className="eyebrow">{projectConfig.automation.defaultMachineLabel}</p><h2>Loop controls</h2></div></div><div className="command-list">{commands.map((item) => <article key={item.command}><div><strong>{item.label}</strong><code>{item.command}</code></div><button onClick={() => copy(item.command)}>{copied === item.command ? 'Copied' : 'Copy'}</button></article>)}</div></div>
      <div className="panel system-card"><p className="eyebrow">Production</p><h2>System map</h2><dl><div><dt>Admin</dt><dd>{projectConfig.project.productionUrl.replace(/^https?:\/\//, '')}{projectConfig.project.adminPath}</dd></div><div><dt>Project</dt><dd>{projectConfig.project.firebaseProjectId}</dd></div><div><dt>Data</dt><dd>Firestore · {projectConfig.project.firestoreLocation}</dd></div><div><dt>Auth</dt><dd>Google · role based</dd></div><div><dt>Deploy</dt><dd>{Object.entries(projectConfig.deployments).filter(([, enabled]) => enabled).map(([target]) => target.replace(/([A-Z])/g, ' $1').trim()).join(' · ') || 'Configure targets'}</dd></div></dl></div>
    </section>
    <section className="panel policy-panel"><div><p className="eyebrow">Lifecycle</p><h2>Approval unlocks the next capability.</h2></div><div className="policy-grid"><article><span>01</span><strong>Build</strong><p>The selected model works in isolation, tests, and returns a PR.</p></article><article><span>02</span><strong>Review</strong><p>Questions, plans, and PRs have distinct gates with context-specific actions.</p></article><article><span>03</span><strong>Release</strong><p>A deploy approval is durable authority to execute the exact recorded scope.</p></article><article><span>04</span><strong>Accept</strong><p>TestFlight returns to the project owner for hands-on acceptance or another agent pass.</p></article></div></section>
  </>
}
