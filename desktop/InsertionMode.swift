import Foundation

/// What `Tab` does. Sharing is never implicit: the default inserts plain text
/// and creates no public token.
enum InsertionMode: String, CaseIterable {
    case plain, ask, share

    static var current: InsertionMode {
        InsertionMode(rawValue: UserDefaults.standard.string(forKey: "AssistInsertionMode") ?? "") ?? .plain
    }
    static func set(_ mode: InsertionMode) {
        UserDefaults.standard.set(mode.rawValue, forKey: "AssistInsertionMode")
    }
    var title: String {
        switch self {
        case .plain: return "Plain Text"
        case .ask: return "Ask Each Time"
        case .share: return "Share Link"
        }
    }

    var explanation: String {
        switch self {
        case .plain: return "Tab inserts the source's text. ⇧⌘↩ still offers a share link."
        case .ask: return "Tab asks whether to insert plain text or a share link."
        case .share: return "Tab opens the sharing options, then inserts a share link."
        }
    }
}
