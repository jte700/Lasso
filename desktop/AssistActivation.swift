import Foundation

/// Keeps the user's preference separate from the permissions needed to run it.
struct AssistActivation {
    private(set) var requested: Bool
    private var lastAttempt: Permissions?

    private struct Permissions: Equatable {
        let accessibility: Bool
        let inputMonitoring: Bool
    }

    init(requested: Bool) { self.requested = requested }

    mutating func setRequested(_ value: Bool) {
        requested = value
        lastAttempt = nil
    }

    mutating func shouldAttempt(serverReady: Bool, accessibility: Bool,
                                inputMonitoring: Bool, running: Bool,
                                userInitiated: Bool = false) -> Bool {
        guard requested, serverReady else {
            lastAttempt = nil
            return false
        }
        guard accessibility || userInitiated else {
            lastAttempt = nil
            return false
        }
        guard !running else { return false }
        let permissions = Permissions(accessibility: accessibility,
                                      inputMonitoring: inputMonitoring)
        guard userInitiated || permissions != lastAttempt else { return false }
        lastAttempt = permissions
        return true
    }
}
