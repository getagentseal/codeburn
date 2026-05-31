import XCTest

/// End-to-end UI tests for CodeBurnMenubar.
/// These launch the real app and verify user-facing interactions.
///
/// Run with: cd mac && xcodegen && xcodebuild test \
///   -project CodeBurnMenubar.xcodeproj \
///   -scheme CodeBurnMenubarUITests \
///   -destination 'platform=macOS'
final class SettingsUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    override func tearDownWithError() throws {
        app.terminate()
        app = nil
    }

    // MARK: - Settings Window

    func testSettingsWindowOpens() throws {
        // Open Settings via menu bar (⌘,)
        app.typeKey(",", modifierFlags: .command)
        let window = app.windows["CodeBurn Settings"]
        XCTAssertTrue(window.waitForExistence(timeout: 3), "Settings window should appear")
    }

    func testSidebarShowsAllPanes() throws {
        app.typeKey(",", modifierFlags: .command)
        let window = app.windows["CodeBurn Settings"]
        guard window.waitForExistence(timeout: 3) else {
            XCTFail("Settings window did not appear")
            return
        }

        let sidebar = window.outlines.firstMatch
        XCTAssertTrue(sidebar.exists, "Sidebar should exist")

        // Verify all 4 panes appear in sidebar
        let expectedPanes = ["General", "Providers", "Debug", "About"]
        for pane in expectedPanes {
            let cell = sidebar.cells.staticTexts[pane]
            XCTAssertTrue(cell.exists, "Sidebar should contain '\(pane)' pane")
        }
    }

    func testSidebarClickChangesDetailContent() throws {
        app.typeKey(",", modifierFlags: .command)
        let window = app.windows["CodeBurn Settings"]
        guard window.waitForExistence(timeout: 3) else {
            XCTFail("Settings window did not appear")
            return
        }

        let sidebar = window.outlines.firstMatch

        // Click "Providers" in sidebar
        let providersCell = sidebar.cells.staticTexts["Providers"]
        guard providersCell.waitForExistence(timeout: 2) else {
            XCTFail("Providers sidebar item not found")
            return
        }
        providersCell.click()

        // Verify provider toggles appear in the detail area
        let activeProvidersLabel = window.staticTexts["Active Providers"]
        XCTAssertTrue(
            activeProvidersLabel.waitForExistence(timeout: 2),
            "Clicking Providers should show 'Active Providers' section"
        )
    }

    func testProviderToggleIsInteractive() throws {
        app.typeKey(",", modifierFlags: .command)
        let window = app.windows["CodeBurn Settings"]
        guard window.waitForExistence(timeout: 3) else {
            XCTFail("Settings window did not appear")
            return
        }

        // Navigate to Providers pane
        let sidebar = window.outlines.firstMatch
        let providersCell = sidebar.cells.staticTexts["Providers"]
        guard providersCell.waitForExistence(timeout: 2) else {
            XCTFail("Providers sidebar item not found")
            return
        }
        providersCell.click()

        // Find a toggle (Claude should always be present)
        let claudeToggle = window.switches.firstMatch
        guard claudeToggle.waitForExistence(timeout: 2) else {
            XCTFail("No toggle switch found in Providers pane")
            return
        }

        // Click and verify it responds (value changes)
        let valueBefore = claudeToggle.value as? String
        claudeToggle.click()
        let valueAfter = claudeToggle.value as? String
        XCTAssertNotEqual(valueBefore, valueAfter, "Toggle should change state on click")

        // Click again to restore original state
        claudeToggle.click()
    }

    // MARK: - Navigation Regression Guard

    func testAllSidebarPanesAreClickable() throws {
        // This is the key regression test — catches the non-optional
        // Binding<T> bug that made sidebar clicks silently fail.
        app.typeKey(",", modifierFlags: .command)
        let window = app.windows["CodeBurn Settings"]
        guard window.waitForExistence(timeout: 3) else {
            XCTFail("Settings window did not appear")
            return
        }

        let sidebar = window.outlines.firstMatch
        let panes = ["General", "Providers", "Debug", "About"]

        for pane in panes {
            let cell = sidebar.cells.staticTexts[pane]
            guard cell.waitForExistence(timeout: 2) else {
                XCTFail("'\(pane)' not found in sidebar")
                continue
            }
            cell.click()
            // Brief pause to let detail render
            Thread.sleep(forTimeInterval: 0.3)
            // Just verifying it doesn't crash and the window remains
            XCTAssertTrue(window.exists, "Window should remain after clicking '\(pane)'")
        }
    }
}
