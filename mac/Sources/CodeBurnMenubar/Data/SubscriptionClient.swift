import Foundation

private let sessionRelativePath = ".augment/session.json"
private let requestTimeout: TimeInterval = 30
private let maxSessionBytes = 64 * 1024

private let disableSubscriptionFetchKey = "CodeBurnDisableSubscriptionFetch"

enum SubscriptionError: Error, LocalizedError {
    case noSession
    case sessionInvalid
    case sessionExpired(Int)
    case fetchFailed(Int, String?)
    case decodeFailed(Error)

    var errorDescription: String? {
        switch self {
        case .noSession: "No Augment session found"
        case .sessionInvalid: "Augment session.json malformed"
        case let .sessionExpired(code): "Session expired (\(code))"
        case let .fetchFailed(code, body): "Credit info fetch failed (\(code))\(body.map { ": \($0)" } ?? "")"
        case let .decodeFailed(err): "Decode failed: \(err.localizedDescription)"
        }
    }
}

struct SubscriptionClient {
    static func fetch() async throws -> SubscriptionUsage {
        if UserDefaults.standard.bool(forKey: disableSubscriptionFetchKey) {
            throw SubscriptionError.noSession
        }
        let session = try loadSession()
        let response = try await fetchCreditInfo(session: session)
        return mapResponse(response)
    }

    private static func loadSession() throws -> AugmentSession {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(sessionRelativePath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw SubscriptionError.noSession
        }
        let data: Data
        do {
            data = try SafeFile.read(from: url.path, maxBytes: maxSessionBytes)
        } catch {
            throw SubscriptionError.noSession
        }
        do {
            let session = try JSONDecoder().decode(AugmentSession.self, from: data)
            let token = session.accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
            let tenant = session.tenantURL.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !token.isEmpty, !tenant.isEmpty else {
                throw SubscriptionError.sessionInvalid
            }
            return AugmentSession(accessToken: token, tenantURL: tenant)
        } catch let err as SubscriptionError {
            throw err
        } catch {
            throw SubscriptionError.sessionInvalid
        }
    }

    private static func fetchCreditInfo(session: AugmentSession) async throws -> GetCreditInfoResponse {
        guard let url = URL(string: session.tenantURL)?.appendingPathComponent("get-credit-info") else {
            throw SubscriptionError.sessionInvalid
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = requestTimeout
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = "{}".data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw SubscriptionError.fetchFailed(-1, nil)
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw SubscriptionError.sessionExpired(http.statusCode)
        }
        guard http.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8)
            throw SubscriptionError.fetchFailed(http.statusCode, body)
        }
        do {
            return try JSONDecoder().decode(GetCreditInfoResponse.self, from: data)
        } catch {
            throw SubscriptionError.decodeFailed(error)
        }
    }

    private static func mapResponse(_ r: GetCreditInfoResponse) -> SubscriptionUsage {
        let planName = r.displayInfo?.planDisplayName
        let displayName = (planName?.isEmpty ?? true) ? "Auggie Plan" : planName!
        let usedUnits = r.usageUnitsTotal - r.usageUnitsRemaining
        let resetsAt = parseDate(r.currentBillingCycleEndDateIso)
        let unitLabel = r.displayInfo?.usageUnitDisplayName ?? "credits"

        return SubscriptionUsage(
            planDisplayName: displayName,
            usedUnits: usedUnits,
            totalUnits: r.usageUnitsTotal,
            resetsAt: resetsAt,
            isLow: r.isCreditBalanceLow,
            unitLabel: unitLabel,
            fetchedAt: Date()
        )
    }

    private static func parseDate(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

private struct AugmentSession: Decodable {
    let accessToken: String
    let tenantURL: String
}

private struct GetCreditInfoResponse: Decodable {
    let usageUnitsTotal: Double
    let usageUnitsRemaining: Double
    let isCreditBalanceLow: Bool
    let currentBillingCycleEndDateIso: String?
    let displayInfo: DisplayInfo?

    enum CodingKeys: String, CodingKey {
        case usageUnitsTotal = "usage_units_total"
        case usageUnitsRemaining = "usage_units_remaining"
        case isCreditBalanceLow = "is_credit_balance_low"
        case currentBillingCycleEndDateIso = "current_billing_cycle_end_date_iso"
        case displayInfo = "display_info"
    }
}

private struct DisplayInfo: Decodable {
    let planDisplayName: String?
    let usageUnitDisplayName: String?

    enum CodingKeys: String, CodingKey {
        case planDisplayName = "plan_display_name"
        case usageUnitDisplayName = "usage_unit_display_name"
    }
}
