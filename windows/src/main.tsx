import React from 'react'
import ReactDOM from 'react-dom/client'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { App } from './App'
import { Dock } from './Dock'
import { Settings } from './Settings'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { applyLanguage, useLocale, type Locale } from './i18n'
import { applyAccent, savedAccent } from './lib/accent'
import { applyTheme, readSetting } from './lib/settings'
import './styles.css'

void invoke<{ locale: Locale }>('language_state')
  .then(state => applyLanguage(state.locale))
  .catch(() => {})
void listen('codeburn://language-changed', () => {
  void invoke<{ locale: Locale }>('language_state').then(state => applyLanguage(state.locale)).catch(() => {})
})

// Every window loads the one bundle, so the label decides which surface mounts.
const label = getCurrentWindow().label

// Before the first paint, so nothing tinted by the accent renders in the default ember and
// then jumps. localStorage is the fast cache for both; the file the settings window writes
// is the source of truth and corrects them a round trip later.
applyAccent(savedAccent())
const savedTheme = readSetting('theme')
if (savedTheme === 'dark' || savedTheme === 'light') applyTheme(savedTheme)

function surface() {
  if (label === 'dock') return <Dock />
  if (label === 'settings') return <Settings />
  return <App />
}

function Root() {
  const locale = useLocale()
  return <React.StrictMode key={locale}>{surface()}</React.StrictMode>
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<Root />)
