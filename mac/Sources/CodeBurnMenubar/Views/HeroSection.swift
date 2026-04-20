import SwiftUI

struct HeroSection: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionCaption(text: caption)

            HStack(alignment: .firstTextBaseline) {
                Text(heroValue)
                    .font(.system(size: 32, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .tracking(-1)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Theme.brandAccent, Theme.brandEmberDeep],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                // Unit indicator for credits mode
                if store.payload.billingMode == .credits {
                    Text("credits")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                }

                Spacer()

                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(store.payload.current.calls.asThousandsSeparated()) calls")
                        .font(.system(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    Text("\(store.payload.current.sessions) sessions")
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 12)
    }

    /// Returns the hero metric formatted according to billing mode:
    /// - credits mode: credits (no $)
    /// - token_plus mode: billed USD amount
    /// - legacy mode: cost as USD (backwards compat)
    private var heroValue: String {
        let current = store.payload.current
        switch store.payload.billingMode {
        case .credits:
            // Show credits, no $ sign
            return current.creditsAugment.asCredits(fallback: "0")
        case .tokenPlus:
            // Show billed USD amount
            return current.billedAmountUsd.asCurrency(fallback: current.cost.asCurrency(fallback: "$0.00"))
        case .legacy:
            // Legacy mode: show cost as USD for backwards compat
            return current.cost.asCurrency(fallback: "$0.00")
        }
    }

    private var caption: String {
        let label = store.payload.current.label.isEmpty ? store.selectedPeriod.rawValue : store.payload.current.label
        if store.selectedPeriod == .today {
            return "\(label) · \(todayDate)"
        }
        return label
    }

    private var todayDate: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE MMM d"
        return formatter.string(from: Date())
    }
}
