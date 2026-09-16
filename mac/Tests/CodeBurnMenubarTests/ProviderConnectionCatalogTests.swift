import Testing
@testable import CodeBurnMenubar

@Suite("Provider connection catalog")
struct ProviderConnectionCatalogTests {
    @Test("pins the complete provider inventory")
    func pinnedReferenceInventory() {
        #expect(ProviderConnectionCatalog.inventoryRevision == "5b09e44d0f9e60107d3fbed232e5f6e17d486df3")
        #expect(ProviderConnectionCatalog.providers.count == 71)
        #expect(ProviderConnectionCatalog.providers.map(\.id) == [
            "codex", "openai", "azureopenai", "claude", "clinepass", "cursor", "opencode",
            "opencodego", "alibaba", "alibabatokenplan", "qwencloud", "factory", "fireworks",
            "gemini", "antigravity", "copilot", "devin", "zai", "zcode", "minimax", "manus",
            "kimi", "kilo", "kiro", "vertexai", "augment", "jetbrains", "moonshot", "amp",
            "t3chat", "ollama", "synthetic", "openrouter", "elevenlabs", "warp", "windsurf",
            "zed", "perplexity", "mimo", "doubao", "sakana", "abacus", "mistral", "deepseek",
            "deepinfra", "codebuff", "crof", "venice", "commandcode", "qoder", "stepfun",
            "bedrock", "grok", "grokbot", "groq", "llmproxy", "litellm", "deepgram", "poe", "chutes",
            "neuralwatt", "clawrouter", "longcat", "sub2api", "wayfinder", "zenmux", "aiand",
            "zoommate", "xai", "notion", "ibmbob",
        ])
    }

    @Test("provider IDs are unique and every provider declares a connection path")
    func uniqueAndConnectable() {
        let providers = ProviderConnectionCatalog.providers
        #expect(Set(providers.map(\.id)).count == providers.count)
        #expect(providers.allSatisfy { !$0.sourceModes.isEmpty })
        #expect(providers.allSatisfy { !$0.authMethods.isEmpty })
        #expect(providers.allSatisfy { ProviderConnectionCatalog.entry(id: $0.id) == Optional($0) })
    }

    @Test("pins source-mode coverage")
    func pinnedSourceModeCoverage() {
        let providers = ProviderConnectionCatalog.providers
        #expect(providers.count(with: .automatic) == 71)
        #expect(providers.count(with: .web) == 30)
        #expect(providers.count(with: .cli) == 16)
        #expect(providers.count(with: .oauth) == 5)
        #expect(providers.count(with: .api) == 44)
    }

    @Test("pins every live CodeBurn quota adapter")
    func currentLiveAdapters() {
        let live = ProviderConnectionCatalog.providers
            .filter(\.hasLiveCodeBurnQuotaAdapter)
            .map(\.id)
            .sorted()
        #expect(live == ["antigravity", "claude", "clinepass", "codex", "copilot", "cursor", "gemini", "grok", "grokbot", "kimi", "zai", "zcode"])
    }

}

private extension Array where Element == ProviderConnectionCatalogEntry {
    func count(with sourceMode: ProviderReferenceSourceMode) -> Int {
        count { $0.sourceModes.contains(sourceMode) }
    }
}
