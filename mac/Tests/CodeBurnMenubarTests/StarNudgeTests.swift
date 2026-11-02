import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Star nudge")
struct StarNudgeTests {
    @Test("shows from the third popover open until a button sets the done flag")
    func showsFromThirdOpenUntilDone() {
        let (defaults, name) = TestDefaults.make("CodeBurnMenubarTests.StarNudge.\(#function)")
        defer { TestDefaults.forget(name) }

        var shown: [Bool] = []
        for _ in 1...4 {
            StarNudge.countOpen(in: defaults)
            shown.append(StarNudge.shows(opens: defaults.integer(forKey: StarNudge.opensKey), done: defaults.bool(forKey: StarNudge.doneKey)))
        }
        #expect(shown == [false, false, true, true])

        defaults.set(true, forKey: StarNudge.doneKey)
        StarNudge.countOpen(in: defaults)
        #expect(!StarNudge.shows(opens: defaults.integer(forKey: StarNudge.opensKey), done: defaults.bool(forKey: StarNudge.doneKey)))
    }
}
