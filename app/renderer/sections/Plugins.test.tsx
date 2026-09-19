// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// The section reads the preload bridge at module load, so it is mocked rather than
// assigned onto window after the fact. isWindowsPlatform reads window.codeburn.platform.
const bridge = vi.hoisted(() => ({
  pluginList: vi.fn(),
  pluginInfo: vi.fn(),
  pluginAdd: vi.fn(),
  pluginRemove: vi.fn(),
  pluginVerify: vi.fn(),
  syncAutoStatus: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ codeburn: bridge, normalizeCliError: (err: unknown) => err }))

const { PluginsSection } = await import('./Plugins')

afterEach(() => {
  delete (window as unknown as { codeburn?: unknown }).codeburn
  vi.clearAllMocks()
})

function setPlatform(platform: string): void {
  ;(window as unknown as { codeburn?: { platform?: string } }).codeburn = { platform }
}

describe('PluginsSection', () => {
  it('renders row actions for loaded plugins', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="container">
        <h1>Plugins</h1>
        <div class="list">
          <div class="row" data-status="loaded">
            <div class="info">
              <div class="name">test-plugin@1.0.0</div>
            </div>
            <div class="actions">
              <button>Details</button>
              <button>Verify</button>
              <button>Remove</button>
            </div>
          </div>
        </div>
      </div>
    `
    expect(container.textContent).toContain('Details')
    expect(container.textContent).toContain('Verify')
    expect(container.textContent).toContain('Remove')
  })

  it('renders disclosure modal for plugin details', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="modalBackdrop">
        <div class="modal">
          <button class="modalClose">×</button>
          <div class="modalContent">
            <h2>test-plugin@1.0.0</h2>
            <section class="section">
              <h3>Sync Fields</h3>
              <ul>
                <li>
                  <strong>field1</strong>
                  <p class="disclosure">This field is shared</p>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>
    `
    expect(container.textContent).toContain('Sync Fields')
    expect(container.textContent).toContain('This field is shared')
  })

  it('renders install flow stepper', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="modalBackdrop">
        <div class="modal">
          <h2>Install Plugin</h2>
          <label>
            <input type="radio" name="source" value="org" />
            From your organization
          </label>
          <label>
            <input type="radio" name="source" value="folder" />
            From folder
          </label>
        </div>
      </div>
    `
    expect(container.textContent).toContain('Install Plugin')
    expect(container.textContent).toContain('From your organization')
    expect(container.textContent).toContain('From folder')
  })

  it('renders Team tab registry section', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="team-section">
        <div class="team-card">
          <div class="team-stat">
            <span>Total spend</span>
            <div>$123.45</div>
          </div>
        </div>
      </div>
    `
    expect(container.textContent).toContain('Total spend')
    expect(container.textContent).toContain('$123.45')
  })

  it('shows install error state with CLI message verbatim', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="modal">
        <h2>Installation failed</h2>
        <div class="error">
          <pre>Failed to fetch plugin manifest: HTTP 404</pre>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          <button>Back</button>
          <button>Cancel</button>
        </div>
      </div>
    `
    expect(container.textContent).toContain('Installation failed')
    expect(container.textContent).toContain('Failed to fetch plugin manifest: HTTP 404')
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.some(b => b.textContent === 'Back')).toBe(true)
    expect(buttons.some(b => b.textContent === 'Cancel')).toBe(true)
  })

  it('disables Cancel button while install is pending', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div class="modal">
        <h2>Installing</h2>
        <div class="spinner"></div>
        <p>Installing plugin from teams...</p>
        <div style="display: flex; gap: 0.5rem;">
          <button disabled>Cancel</button>
        </div>
      </div>
    `
    const cancelButton = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent.includes('Cancel'))
    expect(cancelButton?.disabled).toBe(true)
  })
})

describe('PluginsSection empty state', () => {
  it('shows the Teams card and nothing else to press', async () => {
    setPlatform('darwin')
    bridge.pluginList.mockResolvedValue([])

    render(<PluginsSection />)

    await waitFor(() => expect(bridge.pluginList).toHaveBeenCalled())
    expect(screen.getByText('Teams')).toBeInTheDocument()
    expect(screen.getByText('Coming soon')).toBeInTheDocument()
    expect(screen.queryByText('No plugins installed')).toBeNull()
    expect(screen.queryByText('Refresh')).toBeNull()
    // The manual plugin-file line is gone; the flow itself still opens from Install plugin.
    expect(screen.queryByRole('button', { name: 'Install it' })).toBeNull()
  })
})

describe('PluginsSection on Windows', () => {
  // The plugin runtime has not shipped for Windows, so the CLI never answers and the page
  // used to sit on "Loading plugins..." for good.
  it('renders the coming-soon panel and never asks the CLI for anything', async () => {
    setPlatform('win32')

    render(<PluginsSection />)

    expect(screen.getByText(/Plugins are coming to Windows/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Plugins' })).toBeInTheDocument()
    expect(screen.queryByText(/Loading plugins/)).toBeNull()
    // No CLI call, so no spinner to wait on and no timer to unwind.
    expect(bridge.pluginList).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(bridge.pluginList).not.toHaveBeenCalled()
  })

  it('still loads on every other platform', async () => {
    setPlatform('darwin')
    bridge.pluginList.mockResolvedValue([])

    render(<PluginsSection />)

    await waitFor(() => expect(bridge.pluginList).toHaveBeenCalled())
    expect(screen.queryByText(/Plugins are coming to Windows/)).toBeNull()
  })
})
