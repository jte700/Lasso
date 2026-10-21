// Lasso's keyboard shortcuts, as Settings lists them.
//
// The list is public/shortcuts.json, which the Windows workspace's Settings
// shows too, so both platforms describe the same actions. Each entry names
// its Mac keys and its Windows keys; the Mac shows only entries with Mac keys.

import Foundation

struct ShortcutCatalog: Decodable, Equatable {
    struct Entry: Decodable, Equatable {
        let action: String
        let macos: String?
        let windows: String?
    }

    struct Section: Decodable, Equatable {
        let title: String
        let note: String?
        let shortcuts: [Entry]
    }

    /// A shortcut as the Mac shows it.
    struct Row: Equatable {
        let action: String
        let keys: String
    }

    /// A section with only the shortcuts that exist on the Mac.
    struct MacSection: Equatable {
        let title: String
        let note: String?
        let rows: [Row]
    }

    let sections: [Section]

    /// Sections in their listed order, leaving out any with nothing for the Mac.
    var macSections: [MacSection] {
        sections.compactMap { section in
            let rows = section.shortcuts.compactMap { entry -> Row? in
                guard let keys = entry.macos, !keys.isEmpty, !entry.action.isEmpty else { return nil }
                return Row(action: entry.action, keys: keys)
            }
            guard !rows.isEmpty else { return nil }
            let note = section.note.flatMap { $0.isEmpty ? nil : $0 }
            return MacSection(title: section.title, note: note, rows: rows)
        }
    }

    private static let spokenSymbols: [Character: String] = [
        "⌃": "Control", "⌥": "Option", "⇧": "Shift", "⌘": "Command", "⇥": "Tab", "↩": "Return",
        "←": "Left Arrow", "→": "Right Arrow", "↑": "Up Arrow", "↓": "Down Arrow", "…": "to",
    ]

    /// Keys written with symbols, such as "⇧⌘↩", as VoiceOver should read them.
    static func spokenKeys(_ keys: String) -> String {
        var words: [String] = []
        var plain = ""
        for character in keys {
            guard let name = spokenSymbols[character] else { plain.append(character); continue }
            words.append(plain)
            words.append(name)
            plain = ""
        }
        words.append(plain)
        return words.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    static func decode(_ data: Data) throws -> ShortcutCatalog {
        try JSONDecoder().decode(ShortcutCatalog.self, from: data)
    }

    /// The copy bundled with the server's files in Lasso.app.
    static func loadBundled() throws -> ShortcutCatalog {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("app/public/shortcuts.json") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try decode(Data(contentsOf: url))
    }
}
