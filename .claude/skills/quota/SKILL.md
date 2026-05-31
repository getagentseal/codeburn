```markdown
# quota Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to contribute to the `quota` TypeScript codebase, which manages AI provider integrations and a cross-platform menubar application. You'll learn the project's coding conventions, how to add or update AI providers, refactor the menubar settings UI, and write and maintain tests for both backend and frontend components. The repository uses conventional commits, TypeScript, and Vitest for testing, with a focus on modular provider management and a Swift-based macOS menubar app.

## Coding Conventions

- **File Naming:** Use `camelCase` for all file and directory names.
  - Example: `providerRegistry.ts`, `settingsView.swift`
- **Import Style:** Use relative imports.
  - Example:
    ```typescript
    import { getProvider } from './providerRegistry'
    ```
- **Export Style:** Use named exports.
  - Example:
    ```typescript
    // src/providers/vertex.ts
    export function createVertexProvider(config: VertexConfig) { ... }
    ```
- **Commit Messages:** Use [Conventional Commits](https://www.conventionalcommits.org/), with prefixes like `fix`, `feat`, `perf`, `refactor`, `test`.
  - Example: `feat: add Vertex AI provider integration`

## Workflows

### Add or Update AI Provider Integration

**Trigger:** When you want to support a new AI provider or update provider toggling/visibility  
**Command:** `/add-provider`

1. **Implement the Provider:**
   - Create or update the provider in `src/providers/` (e.g., `src/providers/vertex.ts`).
     ```typescript
     // src/providers/vertex.ts
     export function createVertexProvider(config: VertexConfig) { ... }
     ```
2. **Register the Provider:**
   - Update `src/providers/index.ts` to include the new provider.
     ```typescript
     export { createVertexProvider } from './vertex'
     ```
3. **Update Configuration Logic:**
   - Modify `src/config.ts` and CLI commands to support toggling/configuring the provider.
4. **Update Dashboard UI:**
   - Edit `src/dashboard.tsx` to display the new provider.
5. **Update Menubar App Settings UI:**
   - Modify Swift files:
     - `mac/Sources/CodeBurnMenubar/Views/SettingsView.swift`
     - `AgentTabStrip.swift`
     - `AppStore.swift`
     - `CodeBurnApp.swift`
   - Add toggle and settings for the provider.
6. **Update Provider Display Names:**
   - Ensure display names are correct in the dashboard or relevant UI.
7. **Update/Add Tests:**
   - Update or add tests in:
     - `tests/provider-registry.test.ts`
     - `mac/Tests/CodeBurnMenubarViewTests/SettingsViewTests.swift`

---

### Refactor Menubar Settings Pane

**Trigger:** When reorganizing, refactoring, or improving the menubar app's settings sidebar/tabs  
**Command:** `/refactor-menubar-settings`

1. **Update Sidebar/Tab Structure:**
   - Edit `mac/Sources/CodeBurnMenubar/Views/SettingsView.swift` for sidebar, tabs, or navigation logic.
2. **Support New UI Logic or State:**
   - Update `CodeBurnApp.swift` and/or `AppStore.swift`.
3. **Modify Tab Strip/Sidebar Content:**
   - Edit `AgentTabStrip.swift` or `MenuBarContent.swift` as needed.
4. **Test UI Interactions:**
   - Verify sidebar selection, tab switching, and provider toggling.
5. **Adjust Layout:**
   - Change window sizing/layout if necessary.

---

### Add or Update Menubar UI Tests

**Trigger:** When adding new settings panes, provider toggles, or changing sidebar/tab logic in the menubar app  
**Command:** `/add-menubar-ui-tests`

1. **Add/Update Unit Tests:**
   - Use ViewInspector for SwiftUI unit tests in `SettingsViewTests.swift`.
2. **Add/Update UI Tests:**
   - Use XCUITest for end-to-end UI tests in `SettingsUITests.swift`.
3. **Update Test Scripts:**
   - Modify `mac/Scripts/test-quality-gate.sh` as needed.
4. **Ensure Test Targets:**
   - Update `mac/project.yml` and `mac/Package.swift` to include new/updated test targets.

---

## Testing Patterns

- **Test Framework:** [Vitest](https://vitest.dev/) for TypeScript code.
- **Test File Naming:** Suffix with `.test.ts`
  - Example: `providerRegistry.test.ts`
- **Swift UI Tests:** Use ViewInspector for unit tests and XCUITest for UI/functional tests.
  - Example:
    ```swift
    // mac/Tests/CodeBurnMenubarViewTests/SettingsViewTests.swift
    func testProviderToggle() { ... }
    ```
- **Test Location:** 
  - TypeScript: `tests/`
  - Swift: `mac/Tests/CodeBurnMenubarViewTests/`, `mac/Tests/CodeBurnMenubarUITests/`

## Commands

| Command                  | Purpose                                                        |
|--------------------------|----------------------------------------------------------------|
| /add-provider            | Add or update an AI provider integration and its UI toggling   |
| /refactor-menubar-settings | Refactor or enhance the menubar app's settings UI             |
| /add-menubar-ui-tests    | Add or update UI/unit tests for the menubar app                |
```