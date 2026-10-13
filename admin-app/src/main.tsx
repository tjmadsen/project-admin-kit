import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import GitHubBackend from './pages/GitHubBackend'
import { BACKEND, ready } from './data'
import { initTheme } from './lib/theme'
import { projectConfig } from './lib/project-config'
import './index.css'

async function bootstrap() {
  initTheme()
  const root = ReactDOM.createRoot(document.getElementById('root')!)
  // GitHub Issues is the whole interface for the github backend.
  if (BACKEND === 'github') {
    root.render(<React.StrictMode><GitHubBackend /></React.StrictMode>)
    return
  }
  // Waits for the native shell's credential exchange (firestore) before React
  // subscribes to auth.
  await ready()

  root.render(
    <React.StrictMode>
      <BrowserRouter basename={projectConfig.project.adminPath}>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  )
}

void bootstrap()
