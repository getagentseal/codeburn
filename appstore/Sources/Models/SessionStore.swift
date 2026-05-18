import Foundation
import SwiftUI

@MainActor
final class SessionStore: ObservableObject {
    @Published var providers: [ProviderData] = []
    @Published var selectedProvider: String = "all"
    @Published var selectedPeriod: Period = .today
    @Published var isLoading = false
    @Published var grantedFolders: [URL] = []
    @Published var needsOnboarding: Bool = true

    var todayCost: Double {
        providers.reduce(0) { $0 + $1.totalCost }
    }

    private var bookmarks: [Data] = []
    private var refreshTimer: Timer?

    enum Period: String, CaseIterable, Identifiable {
        case today, week, month, threeMonths, sixMonths
        var id: String { rawValue }
        var label: String {
            switch self {
            case .today: "Today"
            case .week: "7 Days"
            case .month: "30 Days"
            case .threeMonths: "3 Months"
            case .sixMonths: "6 Months"
            }
        }
    }

    init() {
        loadBookmarks()
        needsOnboarding = grantedFolders.isEmpty
        if !needsOnboarding {
            Task { await refresh() }
            startAutoRefresh()
        }
    }

    nonisolated func stopTimer() {
        MainActor.assumeIsolated {
            refreshTimer?.invalidate()
        }
    }

    func grantFolderAccess() {
        let panel = NSOpenPanel()
        panel.message = "Select your home folder so CodeBurn Pro can read session logs from coding tools."
        panel.prompt = "Grant Access"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser

        guard panel.runModal() == .OK, let url = panel.url else { return }

        guard url.startAccessingSecurityScopedResource() else { return }
        defer { url.stopAccessingSecurityScopedResource() }

        if let bookmark = try? url.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        ) {
            bookmarks.append(bookmark)
            grantedFolders.append(url)
            saveBookmarks()
            needsOnboarding = false
            Task { await refresh() }
            startAutoRefresh()
        }
    }

    func refresh() async {
        isLoading = true

        let resolvedURLs = resolveBookmarks()
        let period = selectedPeriod.dateRange
        let fileCutoff = selectedPeriod.fileCutoff
        NSLog("CodeBurnPro: refresh — %d bookmarks, period %@..%@", resolvedURLs.count, "\(period.lowerBound)", "\(period.upperBound)")

        let result: [ProviderData] = await Task.detached(priority: .userInitiated) {
            var allData: [ProviderData] = []

            for url in resolvedURLs {
                guard url.startAccessingSecurityScopedResource() else {
                    NSLog("CodeBurnPro: failed to access: %@", url.path)
                    continue
                }
                defer { url.stopAccessingSecurityScopedResource() }

                let discovered = SessionDiscovery.discoverAll(under: url, modifiedAfter: fileCutoff)

                for (providerName, paths) in discovered {
                    NSLog("CodeBurnPro: %@ — %d files", providerName, paths.count)
                    let parser = ParserFactory.parser(for: providerName)
                    let sessions = parser.parseSessions(at: paths, in: period)
                    NSLog("CodeBurnPro: %@ — %d sessions, $%.2f", providerName, sessions.count, sessions.reduce(0) { $0 + $1.cost })

                    if let idx = allData.firstIndex(where: { $0.name == providerName }) {
                        allData[idx].sessions.append(contentsOf: sessions)
                    } else {
                        allData.append(ProviderData(name: providerName, sessions: sessions))
                    }
                }
            }
            return allData
        }.value

        providers = result
        isLoading = false
    }

    private func startAutoRefresh() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.refresh()
            }
        }
    }

    // MARK: - Bookmark persistence

    private static var bookmarkURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CodeBurnPro", isDirectory: true)
            .appendingPathComponent("bookmarks.plist")
    }

    private func saveBookmarks() {
        let dir = Self.bookmarkURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? PropertyListEncoder().encode(bookmarks).write(to: Self.bookmarkURL)
    }

    private func loadBookmarks() {
        guard let data = try? Data(contentsOf: Self.bookmarkURL),
              let decoded = try? PropertyListDecoder().decode([Data].self, from: data)
        else { return }
        bookmarks = decoded
        grantedFolders = resolveBookmarks()
        needsOnboarding = grantedFolders.isEmpty
    }

    private func resolveBookmarks() -> [URL] {
        bookmarks.compactMap { data in
            var isStale = false
            guard let url = try? URL(
                resolvingBookmarkData: data,
                options: .withSecurityScope,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            ) else { return nil }
            return url
        }
    }
}
