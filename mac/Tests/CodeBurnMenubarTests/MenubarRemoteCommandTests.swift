import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Menubar remote command")
struct MenubarRemoteCommandTests {
    @Test("unknown strings and the empty string do not parse")
    func rejectsUnknownStrings() {
        #expect(MenubarRemoteCommand(rawValue: "") == nil)
        #expect(MenubarRemoteCommand(rawValue: "nonsense") == nil)
    }

    @Test("quit terminates without touching the login item")
    func quitTerminatesOnly() {
        let command = MenubarRemoteCommand(rawValue: "quit")
        #expect(command?.terminates == true)
        #expect(command?.unregistersLoginItem == false)
    }

    @Test("uninstall terminates and unregisters the login item")
    func uninstallTerminatesAndUnregisters() {
        let command = MenubarRemoteCommand(rawValue: "uninstall")
        #expect(command?.terminates == true)
        #expect(command?.unregistersLoginItem == true)
    }

    /// The language switch is applied in-process now, so there is no command
    /// for it: an older desktop that still writes one is simply ignored.
    @Test("relaunch is not a command any more")
    func relaunchNoLongerParses() {
        #expect(MenubarRemoteCommand(rawValue: "relaunch") == nil)
    }

    @Test("settings neither terminates nor unregisters the login item")
    func settingsNeitherTerminatesNorUnregisters() {
        let command = MenubarRemoteCommand(rawValue: "settings")
        #expect(command?.terminates == false)
        #expect(command?.unregistersLoginItem == false)
    }
}
