import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { auth } from './lib/firebase'
import { initNativeBridge } from './lib/native-bridge'
import { initTheme } from './lib/theme'
import { projectConfig } from './lib/project-config'
import './index.css'

async function bootstrap() {
  initTheme()
  const nativeBridge = initNativeBridge(auth)
  await nativeBridge.authReady

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter basename={projectConfig.project.adminPath}>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  )
}

void bootstrap()
