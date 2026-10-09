import './install'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from '../App'
import { clearHeadlinesOnUpgrade } from '../lib/overviewSnapshot'
import { installPageHiddenClass } from '../lib/pageVisibility'
import { version } from '../../package.json'
import '../styles/indigo.css'
import '../styles/plain.css'
import './vscode.css'

clearHeadlinesOnUpgrade(version)
installPageHiddenClass()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
