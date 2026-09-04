import Foundation

struct ProviderReconnectPresentation: Sendable, Equatable {
    let title: String
    let defaultReason: String
    let instruction: String

    init(provider: ProviderFilter) {
        title = L("Reconnect \(provider.rawValue)")
        switch provider {
        case .claude:
            defaultReason = L("Claude Code credentials need to be refreshed.")
            instruction = L("Open Claude Code in your terminal and type `/login`, then click Reconnect.")
        case .codex:
            defaultReason = L("Codex credentials need to be refreshed.")
            instruction = L("Run `codex login` in your terminal, then click Reconnect.")
        case .kimiCode:
            defaultReason = L("Kimi Code credentials need to be refreshed.")
            instruction = L("Run the Kimi CLI once to refresh your login, then click Reconnect.")
        case .gemini:
            defaultReason = L("Gemini credentials need to be refreshed.")
            instruction = L("Run the Gemini CLI once to refresh your login, then click Reconnect.")
        case .copilot:
            defaultReason = L("Copilot credentials need to be refreshed.")
            instruction = L("Sign in with the Copilot CLI, an editor plugin, or `gh auth login`, then click Reconnect.")
        case .antigravity:
            defaultReason = L("The local Antigravity service is unavailable.")
            instruction = L("Start the Antigravity app, then click Reconnect.")
        default:
            defaultReason = L("\(provider.rawValue) credentials need to be refreshed.")
            instruction = L("Sign in to \(provider.rawValue) again, then retry.")
        }
    }
}
