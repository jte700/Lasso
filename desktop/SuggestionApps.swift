// The apps Lasso suggests in. Every app gets suggestions until the user
// switches it off in Settings. The list Settings shows fills itself with the
// apps the user types in, so there is a switch ready for each of them; apps
// can also be added by hand. Only bundle identifiers are kept, on this Mac.

import Foundation

final class SuggestionApps {
    static let shared = SuggestionApps(defaults: .standard,
                                       ownBundleID: Bundle.main.bundleIdentifier ?? "com.jte700.lasso")

    private static let listedKey = "SuggestionAppsListed"
    private static let offKey = "SuggestionAppsOff"
    /// Enough for every app someone writes in, without growing forever.
    static let defaultLimit = 40

    private let defaults: UserDefaults
    private let ownBundleID: String
    private let limit: Int

    init(defaults: UserDefaults, ownBundleID: String, limit: Int = SuggestionApps.defaultLimit) {
        self.defaults = defaults
        self.ownBundleID = ownBundleID
        self.limit = limit
    }

    /// Apps with a switch in Settings, in the order they were first seen.
    var listed: [String] { defaults.stringArray(forKey: Self.listedKey) ?? [] }

    private var off: Set<String> { Set(defaults.stringArray(forKey: Self.offKey) ?? []) }

    /// Whether Lasso may suggest in the app. Apps never switched off may.
    func allows(_ bundleID: String) -> Bool { !off.contains(bundleID) }

    /// Lists an app the user is typing in. Called for each read, so it only
    /// writes when the app is new to the list.
    func noteTyping(in bundleID: String) {
        guard isListable(bundleID), !listed.contains(bundleID) else { return }
        defaults.set(trimmed(listed + [bundleID]), forKey: Self.listedKey)
    }

    func setAllowed(_ allowed: Bool, for bundleID: String) {
        guard isListable(bundleID) else { return }
        let current = off
        let updated = allowed ? current.subtracting([bundleID]) : current.union([bundleID])
        defaults.set(updated.sorted(), forKey: Self.offKey)
        if !listed.contains(bundleID) {
            defaults.set(trimmed(listed + [bundleID]), forKey: Self.listedKey)
        }
    }

    private func isListable(_ bundleID: String) -> Bool { !bundleID.isEmpty && bundleID != ownBundleID }

    /// Drops the oldest apps past the limit, but never one that is switched
    /// off: forgetting it would quietly turn its suggestions back on.
    private func trimmed(_ apps: [String]) -> [String] {
        let switchedOff = off
        var kept = apps
        while kept.count > limit, let oldest = kept.firstIndex(where: { !switchedOff.contains($0) }) {
            kept = Array(kept[..<oldest] + kept[(oldest + 1)...])
        }
        return kept
    }
}

/// How Settings > Apps folds its list, so a long one never stretches the pane.
enum SuggestionAppsFold {
    /// Up to this many apps the list starts open.
    static let shownOpen = 6
    /// Past this many apps switched off, the header counts them instead of naming them.
    private static let namedOff = 2

    static func startsOpen(count: Int) -> Bool { count <= shownOpen }

    /// What the header says beside its title: how many apps, and which are switched off.
    static func summary(count: Int, off: [String]) -> String {
        let apps = "\(count) app\(count == 1 ? "" : "s")"
        if off.isEmpty { return apps }
        if off.count <= namedOff { return "\(apps), off in \(off.joined(separator: " and "))" }
        return "\(apps), \(off.count) off"
    }
}
