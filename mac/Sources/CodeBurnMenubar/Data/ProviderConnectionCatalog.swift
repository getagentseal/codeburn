import Foundation

/// Fetch-source vocabulary used by Capacity Dock's provider catalog.
enum ProviderReferenceSourceMode: String, Codable, CaseIterable, Hashable, Sendable {
    case automatic = "auto"
    case web
    case cli
    case oauth
    case api
}

/// User-facing connection semantics behind a provider's fetch sources.
///
/// These are broader than raw fetch modes. Gemini's local OAuth probe is stored
/// as an `api` source, while the credential the user experiences is still a
/// local CLI OAuth session.
enum ProviderAuthMethod: String, Codable, CaseIterable, Hashable, Sendable {
    case localAppOrCLI
    case oauth
    case apiTokenOrCloudCredentials
    case cookieOrWebSession
    case localhost
    case none

    var title: String {
        switch self {
        case .localAppOrCLI: L("Installed app or CLI")
        case .oauth: L("OAuth")
        case .apiTokenOrCloudCredentials: L("API or cloud credentials")
        case .cookieOrWebSession: L("Browser session")
        case .localhost: L("Localhost service")
        case .none: L("No sign-in required")
        }
    }
}

struct ProviderConnectionCatalogEntry: Equatable, Sendable {
    let id: String
    let displayName: String
    let sourceModes: Set<ProviderReferenceSourceMode>
    let authMethods: Set<ProviderAuthMethod>
    let hasLiveCodeBurnQuotaAdapter: Bool
}

/// Declarative connection inventory owned by CodeBurn. The live flag identifies
/// every provider with a native CodeBurn quota adapter.
enum ProviderConnectionCatalog {
    static let inventoryRevision = "714bff00815f0d98ae206e781d563595129ba185"

    static let providers: [ProviderConnectionCatalogEntry] = [
        entry("codex", "Codex", [.automatic, .web, .cli, .oauth, .api],
              [.localAppOrCLI, .oauth, .apiTokenOrCloudCredentials, .cookieOrWebSession], live: true),
        entry("openai", "OpenAI", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("azureopenai", "Azure OpenAI", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("claude", "Claude", [.automatic, .api, .web, .cli, .oauth],
              [.localAppOrCLI, .oauth, .apiTokenOrCloudCredentials, .cookieOrWebSession], live: true),
        entry("clinepass", "ClinePass", [.automatic, .api], [.apiTokenOrCloudCredentials], live: true),
        entry("cursor", "Cursor", [.automatic, .cli, .web], [.localAppOrCLI, .cookieOrWebSession], live: true),
        entry("opencode", "OpenCode", [.automatic, .web], [.cookieOrWebSession]),
        entry("opencodego", "OpenCode Go", [.automatic, .api, .web],
              [.localAppOrCLI, .apiTokenOrCloudCredentials, .cookieOrWebSession, .none]),
        entry("alibaba", "Alibaba Coding Plan", [.automatic, .web, .api],
              [.cookieOrWebSession, .apiTokenOrCloudCredentials]),
        entry("alibabatokenplan", "Alibaba Token Plan", [.automatic, .cli, .web],
              [.localAppOrCLI, .cookieOrWebSession]),
        entry("qwencloud", "Qwen Cloud", [.automatic, .web], [.cookieOrWebSession]),
        entry("factory", "Droid", [.automatic, .api, .web, .cli],
              [.localAppOrCLI, .apiTokenOrCloudCredentials, .cookieOrWebSession]),
        entry("fireworks", "Fireworks", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("gemini", "Gemini", [.automatic, .api], [.localAppOrCLI, .oauth], live: true),
        entry("antigravity", "Antigravity", [.automatic, .cli, .oauth],
              [.localAppOrCLI, .oauth, .localhost, .none], live: true),
        entry("copilot", "Copilot", [.automatic, .api],
              [.oauth, .apiTokenOrCloudCredentials, .cookieOrWebSession], live: true),
        entry("devin", "Devin", [.automatic, .web], [.cookieOrWebSession]),
        entry("zai", "Z.ai", [.automatic, .api],
              [.localAppOrCLI, .apiTokenOrCloudCredentials], live: true),
        entry("minimax", "MiniMax", [.automatic, .web, .api],
              [.cookieOrWebSession, .apiTokenOrCloudCredentials]),
        entry("manus", "Manus", [.automatic, .web], [.cookieOrWebSession]),
        entry("kimi", "Kimi Code", [.automatic, .api, .web],
              [.apiTokenOrCloudCredentials, .cookieOrWebSession], live: true),
        entry("kilo", "Kilo", [.automatic, .api, .cli],
              [.apiTokenOrCloudCredentials, .localAppOrCLI]),
        entry("kiro", "Kiro", [.automatic, .cli], [.localAppOrCLI]),
        entry("vertexai", "Vertex AI", [.automatic, .oauth], [.oauth]),
        entry("augment", "Augment", [.automatic, .cli], [.localAppOrCLI, .cookieOrWebSession]),
        entry("jetbrains", "JetBrains AI", [.automatic, .cli], [.localAppOrCLI]),
        entry("moonshot", "Moonshot", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("amp", "Amp", [.automatic, .api, .web, .cli],
              [.localAppOrCLI, .apiTokenOrCloudCredentials, .cookieOrWebSession]),
        entry("t3chat", "T3 Chat", [.automatic, .web], [.cookieOrWebSession]),
        entry("ollama", "Ollama", [.automatic, .web, .api],
              [.cookieOrWebSession, .apiTokenOrCloudCredentials, .localhost]),
        entry("synthetic", "Synthetic", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("openrouter", "OpenRouter", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("elevenlabs", "ElevenLabs", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("warp", "Warp", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("windsurf", "Windsurf", [.automatic, .web, .cli],
              [.cookieOrWebSession, .localAppOrCLI]),
        entry("zed", "Zed", [.automatic, .api], [.localAppOrCLI, .none]),
        entry("perplexity", "Perplexity", [.automatic, .web], [.cookieOrWebSession]),
        entry("mimo", "Xiaomi MiMo", [.automatic, .web], [.localAppOrCLI, .cookieOrWebSession]),
        entry("doubao", "Doubao", [.automatic, .cli, .api],
              [.localAppOrCLI, .apiTokenOrCloudCredentials]),
        entry("sakana", "Sakana AI", [.automatic, .web], [.cookieOrWebSession]),
        entry("abacus", "Abacus AI", [.automatic, .web], [.cookieOrWebSession]),
        entry("mistral", "Mistral", [.automatic, .web], [.cookieOrWebSession]),
        entry("deepseek", "DeepSeek", [.automatic, .api, .web],
              [.apiTokenOrCloudCredentials, .cookieOrWebSession]),
        entry("deepinfra", "DeepInfra", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("codebuff", "Codebuff", [.automatic, .api],
              [.localAppOrCLI, .apiTokenOrCloudCredentials]),
        entry("crof", "Crof", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("venice", "Venice", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("commandcode", "Command Code", [.automatic, .web], [.cookieOrWebSession]),
        entry("qoder", "Qoder", [.automatic, .web], [.cookieOrWebSession]),
        entry("stepfun", "StepFun", [.automatic, .web], [.cookieOrWebSession]),
        entry("bedrock", "AWS Bedrock", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("grok", "Grok", [.automatic, .cli, .oauth],
              [.localAppOrCLI, .oauth], live: true),
        entry("groq", "Groq", [.automatic, .web, .api],
              [.cookieOrWebSession, .apiTokenOrCloudCredentials]),
        entry("llmproxy", "LLM Proxy", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("litellm", "LiteLLM", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("deepgram", "Deepgram", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("poe", "Poe", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("chutes", "Chutes", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("neuralwatt", "Neuralwatt", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("clawrouter", "ClawRouter", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("longcat", "LongCat", [.automatic, .web], [.cookieOrWebSession]),
        entry("sub2api", "sub2api", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("wayfinder", "Wayfinder", [.automatic, .api], [.localhost, .none]),
        entry("zenmux", "ZenMux", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("aiand", "ai&", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("zoommate", "ZoomMate", [.automatic, .web], [.cookieOrWebSession]),
        entry("xai", "xAI", [.automatic, .api], [.apiTokenOrCloudCredentials]),
        entry("notion", "Notion AI", [.automatic, .web], [.cookieOrWebSession]),
        entry("ibmbob", "IBM Bob", [.automatic, .api], [.apiTokenOrCloudCredentials]),
    ]

    private static func entry(
        _ id: String,
        _ displayName: String,
        _ sourceModes: Set<ProviderReferenceSourceMode>,
        _ authMethods: Set<ProviderAuthMethod>,
        live: Bool = false
    ) -> ProviderConnectionCatalogEntry {
        ProviderConnectionCatalogEntry(
            id: id,
            displayName: displayName,
            sourceModes: sourceModes,
            authMethods: authMethods,
            hasLiveCodeBurnQuotaAdapter: live
        )
    }

    static func entry(id: String) -> ProviderConnectionCatalogEntry? {
        providers.first { $0.id == id }
    }
}

enum ProviderConnectionGuidance {
    static func instruction(for provider: CapacityDockProvider) -> String {
        let methods = provider.catalogEntry.authMethods
        if methods == [.apiTokenOrCloudCredentials] {
            return L("Enter an API key or token below, then press Save & Connect.")
        }
        if methods == [.cookieOrWebSession] {
            return L("Sign in to \(provider.displayName) in a supported browser, then click Retry.")
        }
        if methods.contains(.localAppOrCLI) {
            return L("Sign in with the \(provider.displayName) app or CLI, then click Retry.")
        }
        if methods.contains(.oauth) {
            return L("Complete \(provider.displayName) OAuth, then click Retry.")
        }
        if methods.contains(.localhost) {
            return L("Start the local \(provider.displayName) service, then click Retry.")
        }
        if methods.contains(.apiTokenOrCloudCredentials) {
            return L("Enter the required API or cloud credentials below, then press Save & Connect.")
        }
        if methods.contains(.cookieOrWebSession) {
            return L("Sign in to \(provider.displayName) in a supported browser, then click Retry.")
        }
        return L("No sign-in is required. Click Retry to refresh quota.")
    }

    static func dockInstruction(for provider: CapacityDockProvider) -> String {
        let methods = provider.catalogEntry.authMethods
        if methods == [.apiTokenOrCloudCredentials] {
            return L("Add an API key or token in Provider Settings.")
        }
        if methods.contains(.apiTokenOrCloudCredentials),
           !methods.contains(.localAppOrCLI),
           !methods.contains(.cookieOrWebSession),
           !methods.contains(.oauth) {
            return L("Add the required API or cloud credentials in Provider Settings.")
        }
        return instruction(for: provider)
    }
}

enum ProviderConnectionSubmissionPolicy {
    enum Action: Equatable {
        case connect
        case saveAndConnect
        case requiresCredential
    }

    static func resolve(
        credential: CapacityDockProviderCredential,
        savedCredential: CapacityDockProviderCredential,
        requiresExplicitCredential: Bool
    ) -> Action {
        if requiresExplicitCredential,
           credential.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .requiresCredential
        }
        if credential != savedCredential { return .saveAndConnect }
        return .connect
    }
}
