import SwiftUI

@main
struct CodeBurnProApp: App {
    @StateObject private var store = SessionStore()

    var body: some Scene {
        MenuBarExtra {
            MenuBarPopover(store: store)
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "flame.fill")
                if !store.needsOnboarding {
                    Text(store.todayCost.asMenuBarCurrency())
                        .monospacedDigit()
                }
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(store: store)
        }
    }
}

extension Double {
    func asMenuBarCurrency() -> String {
        if self <= 0 { return "$0" }
        if self >= 1000 { return String(format: "$%.0fK", self / 1000) }
        if self >= 100 { return String(format: "$%.0f", self) }
        if self >= 10 { return String(format: "$%.1f", self) }
        return String(format: "$%.2f", self)
    }
}
