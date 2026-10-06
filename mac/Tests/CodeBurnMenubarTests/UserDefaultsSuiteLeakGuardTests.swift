import Foundation
import Testing

/// Guards the fix for the test-only `UserDefaults(suiteName:` leak: every
/// scratch suite must go through `TestDefaults.make`/`open`, whose only
/// direct call sites live in `TestDefaults.swift`, so its plist actually gets
/// cleaned up via `TestDefaults.forget`.
@Suite("UserDefaults suite leak guard")
struct UserDefaultsSuiteLeakGuardTests {
    private static var testsDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // CodeBurnMenubarTests
            .deletingLastPathComponent()  // Tests
    }

    @Test("the guard can actually see the files it is meant to check")
    func testsAreReachable() throws {
        let files = try swiftFiles(in: Self.testsDirectory)
        #expect(
            files.count > 10,
            "found \(files.count) Swift files under \(Self.testsDirectory.path); if the tree moved, this guard checks nothing"
        )
    }

    @Test("no test file creates a UserDefaults suite outside TestDefaults.swift")
    func noDirectSuiteCreation() throws {
        let needle = "UserDefaults(" + "suiteName"
        let exempt: Set<String> = ["TestDefaults.swift", "UserDefaultsSuiteLeakGuardTests.swift"]
        var offenders: [String] = []
        for file in try swiftFiles(in: Self.testsDirectory) where !exempt.contains(file.lastPathComponent) {
            let contents = try String(contentsOf: file, encoding: .utf8)
            for (index, line) in contents.components(separatedBy: "\n").enumerated() where line.contains(needle) {
                offenders.append("\(file.lastPathComponent):\(index + 1)")
            }
        }
        #expect(
            offenders.isEmpty,
            """
            \(offenders.count) test call site(s) create a UserDefaults suite directly, \
            bypassing TestDefaults.forget and leaking its plist: \(offenders). \
            Use TestDefaults.make(_:) or TestDefaults.open(_:) instead.
            """
        )
    }

    @Test("no two TestDefaults.make/open call sites use the same static suite name")
    func noDuplicateSuiteNames() throws {
        let pattern = try NSRegularExpression(pattern: #"TestDefaults\.(?:make|open)\(\s*"([^"]*)""#)
        var locations: [String: [String]] = [:]
        for file in try swiftFiles(in: Self.testsDirectory) where file.lastPathComponent != "TestDefaults.swift" {
            let contents = try String(contentsOf: file, encoding: .utf8)
            for (index, line) in contents.components(separatedBy: "\n").enumerated() {
                let range = NSRange(line.startIndex..., in: line)
                guard let match = pattern.firstMatch(in: line, range: range),
                      let nameRange = Range(match.range(at: 1), in: line) else { continue }
                let name = String(line[nameRange])
                // A name built from the caller's own `#function` is unique per call
                // site by construction (a different function, a different name);
                // only a name with no such per-caller piece can silently collide.
                guard !name.contains("#function") else { continue }
                locations[name, default: []].append("\(file.lastPathComponent):\(index + 1)")
            }
        }
        let duplicates = locations.filter { $0.value.count > 1 }
        #expect(
            duplicates.isEmpty,
            """
            \(duplicates.count) suite name(s) are reused across call sites, so two tests \
            can write and forget the same plist concurrently: \
            \(duplicates.map { "\"\($0.key)\" at \($0.value)" }.joined(separator: "; ")). \
            Fold something distinguishing into the name -- the caller's #function, a loop \
            index, a parameterized test's argument.
            """
        )
    }

    private func swiftFiles(in directory: URL) throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: directory, includingPropertiesForKeys: nil
        ) else { return [] }
        return enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }
}
