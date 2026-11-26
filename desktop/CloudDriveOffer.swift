//  The cloud drives the menu bar panel offers to connect, as the server lists
//  them in the workspace's `cloudDrives`, and the words for files a cloud drive
//  keeps online alone. Choosing a drive signs in straight away in the browser,
//  opens the Connect window at its sign-in setup when no app registration is
//  saved yet, or, for iCloud Drive, connects its folder on this Mac in one step.

import Foundation

struct CloudDriveOffer: Equatable {
    /// How the drive signs in, as the server says: "browser", "setup" or "none".
    enum SignIn: String {
        case browser, setup, none
    }

    /// What choosing the drive does.
    enum Step: Equatable {
        /// iCloud Drive: its folder is connected, with no sign-in.
        case addFolder
        /// The provider's sign-in page opens in the browser.
        case signIn
        /// The Connect window opens at the provider's sign-in setup.
        case setUp
    }

    let provider: String
    let name: String
    let connected: Bool
    let available: Bool
    let signIn: SignIn

    init(provider: String, name: String, connected: Bool, available: Bool, signIn: SignIn) {
        self.provider = provider
        self.name = name
        self.connected = connected
        self.available = available
        self.signIn = signIn
    }

    init?(_ object: [String: Any]) {
        guard let provider = object["provider"] as? String, !provider.isEmpty else { return nil }
        self.init(provider: provider, name: object["name"] as? String ?? provider,
                  connected: object["connected"] as? Bool ?? false,
                  available: object["available"] as? Bool ?? true,
                  signIn: SignIn(rawValue: object["signIn"] as? String ?? "") ?? .setup)
    }

    /// The offers in the workspace's state, in the server's order.
    static func listed(_ state: [String: Any]) -> [CloudDriveOffer] {
        (state["cloudDrives"] as? [[String: Any]] ?? []).compactMap(CloudDriveOffer.init)
    }

    /// The drives a Connect row is shown for: not connected yet, and possible on this Mac.
    static func unconnected(_ offers: [CloudDriveOffer]) -> [CloudDriveOffer] {
        offers.filter { !$0.connected && $0.available }
    }

    var step: Step {
        switch signIn {
        case .none: return .addFolder
        case .browser: return .signIn
        case .setup: return .setUp
        }
    }

    var title: String { "Connect \(name)\u{2026}" }

    var help: String {
        switch step {
        case .addFolder: return "Lasso reads your iCloud Drive where it is on this Mac. Nothing is copied or uploaded."
        case .signIn: return "Sign in to \(name) in your browser. Lasso only reads your files."
        case .setUp: return "Opens the Connect window to set up \(name) sign-in, then sign in. Lasso only reads your files."
        }
    }
}

/// Files a cloud drive keeps online alone, which Lasso leaves unread until they are downloaded.
enum CloudOnlyFiles {
    private static func files(_ count: Int) -> String { count == 1 ? "1 file" : "\(count) files" }

    /// The line for a row's tooltip; `place` is where the files are, "iCloud" or "the cloud".
    static func note(_ count: Int, in place: String) -> String? {
        guard count > 0 else { return nil }
        return "\(files(count)) \(count == 1 ? "is" : "are") only in \(place), not on this Mac, so Lasso has not read \(count == 1 ? "it" : "them")."
    }

    /// The row's menu command that downloads them.
    static func action(_ count: Int) -> String { "Download \(count == 1 ? "1 File" : "\(count) Files") to This Mac" }

    static let actionHelp = "macOS downloads them, then Lasso reads them. They take space on this Mac."
}
