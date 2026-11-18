// One row of Recent Changes opened like an audit log entry, as the server's
// GET /api/ranch/change describes it: who and what recorded the change, the
// directory versions it went between, the file's size on each side, and what
// changed inside it (lines with a little around them, a table's cells, or the
// values Lasso reads from a workbook, PDF or deck). Plain values and the words
// the detail says, so all of it is checked without a window.

import Cocoa

/// Who history says made a change.
struct RanchActor: Decodable, Equatable {
    let name: String
    /// HUMAN_SELF, HUMAN_COLLABORATOR, AI_AGENT or SYSTEM.
    let type: String
}

struct RanchChangeDetail: Decodable, Equatable {
    struct Version: Decodable, Equatable {
        let before: Int?
        let after: Int?
    }

    struct FileSide: Decodable, Equatable {
        let size: Int?
        let hash: String
    }

    struct File: Decodable, Equatable {
        /// Lasso's file type: code, text, markdown, table, spreadsheet, pdf, ...
        let type: String?
        let before: FileSide?
        let after: FileSide?
    }

    struct Line: Decodable, Equatable {
        /// same, add or remove.
        let kind: String
        let text: String
        /// The line's number in the version before, and in the version after.
        let before: Int?
        let after: Int?
    }

    struct Hunk: Decodable, Equatable {
        let lines: [Line]
    }

    struct Lines: Decodable, Equatable {
        let added: Int
        let removed: Int
        let hunks: [Hunk]
        let truncated: Bool
    }

    struct Cell: Decodable, Equatable {
        let row: String
        let column: String
        let before: String?
        let after: String?
    }

    struct TableCounts: Decodable, Equatable {
        let rowsAdded: Int
        let rowsRemoved: Int
        let cellsChanged: Int
    }

    struct Table: Decodable, Equatable {
        let rowsAdded: [String]
        let rowsRemoved: [String]
        let cells: [Cell]
        let counts: TableCounts
    }

    struct Field: Decodable, Equatable {
        let path: String
        /// added, removed or changed.
        let kind: String
        let before: String?
        let after: String?
    }

    struct Value: Decodable, Equatable {
        /// added, removed or modified.
        let kind: String
        let label: String?
        /// Where it sits, in the file's own words: "Budget!B2", "Page 3".
        let place: String?
        let before: String?
        let after: String?
        var beforeDisplay: String? = nil
        var afterDisplay: String? = nil
        /// A formula cell whose value changed because its inputs did.
        var recalculated: Bool? = nil

        var isRecalculated: Bool { recalculated == true }

        /// As the file shows them ("18,400"), else as stored.
        var shownBefore: String? { beforeDisplay ?? before }
        var shownAfter: String? { afterDisplay ?? after }
    }

    struct ListedFile: Decodable, Equatable {
        let change: String
        let path: String
        let previousPath: String?
    }

    let id: String
    let change: String
    let directoryId: String
    let at: Date?
    /// How Lasso came to record it: WATCHER, AGENT_EDIT, IMPORT, ...
    let source: String
    let actor: RanchActor
    let initiatedBy: RanchActor?
    /// What an agent was asked to do, for an agent's edit.
    let request: String?
    let version: Version
    let path: String?
    let previousPath: String?
    let fileId: String?
    let fileCount: Int
    /// The files a capture of many recorded, for a directory's first reading or a batch.
    let files: [ListedFile]
    let file: File?
    let lines: Lines?
    let table: Table?
    let fields: [Field]?
    let values: [Value]
    let valueCount: Int
    let movedCount: Int
    /// How many of `valueCount` are recalculated formula cells, listed after the values typed into.
    var recalculatedCount: Int? = nil
    /// Retention released this version's bytes, so its lines can't be shown.
    let bytesReleased: Bool

    private struct Envelope: Decodable { let change: RanchChangeDetail }

    static func decode(_ data: Data) throws -> RanchChangeDetail {
        try RanchOverview.decoder().decode(Envelope.self, from: data).change
    }

    /// Whether the detail lists anything that changed inside the file.
    var listsChanges: Bool {
        !(lines?.hunks.isEmpty ?? true) || !(table.map { $0.cells.isEmpty && $0.rowsAdded.isEmpty && $0.rowsRemoved.isEmpty } ?? true)
            || !(fields?.isEmpty ?? true) || !values.isEmpty || !files.isEmpty
    }

    /// The file is written in code, so its lines are shown in a code face.
    var isCode: Bool { ["code", "json", "yaml", "notebook"].contains(file?.type ?? "") }
}

/// The words Recent Changes says about a change.
enum RanchChangeWords {
    /// Who a row names: a person, an agent, a change seen on disk, or Lasso's own.
    enum Who: Equatable {
        case person(String)
        case agent(String)
        case disk
        case lasso

        var title: String {
            switch self {
            case .person(let name), .agent(let name): return name
            case .disk: return "On disk"
            case .lasso: return "Lasso"
            }
        }
    }

    /// A change Lasso saw on disk was made by someone or something on the Mac,
    /// never by Lasso, so a system actor there reads "On disk".
    static func who(_ actor: RanchActor?, source: String?) -> Who {
        guard let actor else { return .disk }
        switch actor.type {
        case "AI_AGENT": return .agent(actor.name)
        case "SYSTEM": return ["WATCHER", "OPEN_RECONCILE", "IMPORT"].contains(source ?? "") ? .disk : .lasso
        default: return .person(actor.name)
        }
    }

    /// How Lasso came to record a change.
    static func recorded(_ source: String?) -> String {
        switch source {
        case "WATCHER": return "Saved on this Mac"
        case "OPEN_RECONCILE": return "Found when the directory was opened"
        case "IMPORT": return "First reading of the directory"
        case "AGENT_EDIT": return "Agent edit, approved in Lasso"
        case "DOCUMENT_CHANGE": return "Edited through Lasso"
        case "EXPLICIT_CHECKPOINT": return "Checkpoint"
        case "REINDEX": return "Read again by Lasso"
        case nil: return "Recorded"
        case let other?:
            let words = other.replacingOccurrences(of: "_", with: " ").lowercased()
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// "12 KB → 13 KB", "13 KB, unchanged", "13 KB" for a new file, "12 KB when removed".
    static func size(before: Int?, after: Int?) -> String? {
        switch (before, after) {
        case let (old?, new?) where old != new: return "\(size(old)) \u{2192} \(size(new))"
        case let (_?, new?): return "\(size(new)), unchanged"
        case let (nil, new?): return size(new)
        case let (old?, nil): return "\(size(old)) when removed"
        default: return nil
        }
    }

    /// "Version 12 → 13" of the directory, or "Version 1" for its first reading.
    static func version(_ version: RanchChangeDetail.Version) -> String? {
        guard let after = version.after else { return nil }
        return version.before.map { "\($0) \u{2192} \(after)" } ?? "\(after)"
    }

    /// "Row 4" for a table whose rows have no names, else the row's name.
    static func row(_ key: String) -> String {
        key.hasPrefix("row:") ? "Row \(key.dropFirst(4))" : key
    }

    /// "2 lines added, 1 removed".
    static func lineSummary(_ lines: RanchChangeDetail.Lines) -> String {
        textSummary(added: lines.added, removed: lines.removed, unit: "line")
    }

    /// "1 line added", "2 paragraphs added, 1 removed", as a text file's row says what its save changed.
    static func textSummary(_ changes: RanchTextChanges) -> String {
        textSummary(added: changes.added, removed: changes.removed, unit: changes.unit)
    }

    private static func textSummary(added: Int, removed: Int, unit: String) -> String {
        let count = { (number: Int, word: String) in number == 1 ? "1 \(unit) \(word)" : "\(number.formatted()) \(unit)s \(word)" }
        switch (added, removed) {
        case (0, 0): return "No \(unit)s changed"
        case (let added, 0): return count(added, "added")
        case (0, let removed): return count(removed, "removed")
        case (let added, let removed): return "\(count(added, "added")), \(removed.formatted()) removed"
        }
    }

    /// What a file's changed values add up to, counting the values typed into
    /// apart from the formula cells that followed them: "1 value changed ·
    /// 9 recalculated", "4 values added", "3 values recalculated".
    static func valueSummary(_ detail: RanchChangeDetail) -> String {
        let recalculated = min(detail.recalculatedCount ?? 0, detail.valueCount)
        let typed = detail.valueCount - recalculated
        let count = { (number: Int, word: String) in number == 1 ? "1 value \(word)" : "\(number.formatted()) values \(word)" }
        if typed == 0 { return count(recalculated, "recalculated") }
        let listed = detail.values.filter { !$0.isRecalculated }
        let word = listed.allSatisfy { $0.kind == "added" } ? "added" : listed.allSatisfy { $0.kind == "removed" } ? "removed" : "changed"
        return recalculated > 0 ? "\(count(typed, word)) \u{00B7} \(recalculated.formatted()) recalculated" : count(typed, word)
    }

    /// The fold under the values typed into that holds the formula cells they recalculated.
    static func recalculatedFold(_ count: Int, typed: Int) -> String {
        "\(count == 1 ? "1 formula cell" : "\(count.formatted()) formula cells") recalculated from \(typed == 1 ? "it" : "them")"
    }

    /// What to say when the detail lists nothing that changed inside the file.
    static func nothingListed(_ detail: RanchChangeDetail) -> String {
        if detail.bytesReleased {
            return "Lasso no longer keeps the bytes of this version, so it can\u{2019}t show what changed inside it."
        }
        let sameBytes = detail.file?.before?.hash != nil && detail.file?.before?.hash == detail.file?.after?.hash
        switch detail.change {
        case "renamed": return sameBytes ? "Only the name changed. The contents are the same bytes."
            : "The contents changed as well, but nothing Lasso reads from them did."
        case "moved": return sameBytes ? "Only its folder changed. The contents are the same bytes."
            : "The contents changed as well, but nothing Lasso reads from them did."
        case "added": return "A new file. Lasso keeps this first version and compares each change after it."
        case "removed": return "Removed from the directory. Lasso keeps its last version."
        case "directory-added", "many": return "Lasso recorded no files in this change."
        default: return "The file\u{2019}s bytes changed, but nothing Lasso reads from it did."
        }
    }

    /// The words of a removed line that its replacement drops, and the words
    /// of an added line that are new, for each removed line followed by the
    /// line that replaces it; by the line's place in `lines`, as UTF-16 ranges.
    /// A line rewritten whole is left unmarked: its colour already says so.
    static func changedWords(in lines: [RanchChangeDetail.Line]) -> [Int: [NSRange]] {
        var marks: [Int: [NSRange]] = [:]
        var index = 0
        while index < lines.count {
            guard lines[index].kind == "remove" else { index += 1; continue }
            let removedStart = index
            while index < lines.count, lines[index].kind == "remove" { index += 1 }
            let addedStart = index
            while index < lines.count, lines[index].kind == "add" { index += 1 }
            for offset in 0..<min(addedStart - removedStart, index - addedStart) {
                let old = lines[removedStart + offset].text
                let new = lines[addedStart + offset].text
                let dropped = joined(PassageWordDiff.changes(from: new, to: old).map(\.range), in: old)
                let added = joined(PassageWordDiff.changes(from: old, to: new).map(\.range), in: new)
                if !covers(dropped, old) { marks[removedStart + offset] = dropped }
                if !covers(added, new) { marks[addedStart + offset] = added }
            }
        }
        return marks.filter { !$0.value.isEmpty }
    }

    /// Marked words with only spaces between them become one mark, read as one phrase.
    private static func joined(_ ranges: [NSRange], in text: String) -> [NSRange] {
        let string = text as NSString
        var runs: [NSRange] = []
        for range in ranges {
            if let last = runs.last, range.location >= NSMaxRange(last),
               string.substring(with: NSRange(location: NSMaxRange(last), length: range.location - NSMaxRange(last)))
                .allSatisfy({ $0 == " " }) {
                runs[runs.count - 1] = NSRange(location: last.location, length: NSMaxRange(range) - last.location)
            } else {
                runs.append(range)
            }
        }
        return runs
    }

    /// Whether the marks take in every word of the line, which then reads as rewritten whole.
    private static func covers(_ ranges: [NSRange], _ text: String) -> Bool {
        let string = text as NSString
        var rest = string as String
        for range in ranges.reversed() { rest = (rest as NSString).replacingCharacters(in: range, with: " ") }
        return rest.allSatisfy { !$0.isLetter && !$0.isNumber }
    }
}

/// Which changes Recent Changes lists and which wait behind its "new changes"
/// pill: the list holds still while it is read, and what arrives is taken in
/// when the pill is clicked or the list is pulled down.
struct RanchChangeFeed: Equatable {
    /// The changes already listed; nil until the library has first been read.
    private(set) var listed: Set<String>?

    /// Lists every change there is, the first time the library has been read.
    mutating func begin(with entries: [RanchHistoryEntry]) {
        if listed == nil { listed = Set(entries.map(\.id)) }
    }

    /// Lists every change there is now, the ones that were waiting among them.
    mutating func takeIn(_ entries: [RanchHistoryEntry]) {
        listed = Set(entries.map(\.id))
    }

    /// The changes the list shows, newest first as given. Before the first
    /// read everything shows; a change that has aged out leaves at once.
    func shown(_ entries: [RanchHistoryEntry]) -> [RanchHistoryEntry] {
        guard let listed else { return entries }
        return entries.filter { listed.contains($0.id) }
    }

    /// The changes that arrived since the list was last taken in.
    func waiting(_ entries: [RanchHistoryEntry]) -> [RanchHistoryEntry] {
        guard let listed else { return [] }
        return entries.filter { !listed.contains($0.id) }
    }

    /// "1 new change", "3 new changes".
    static func pillTitle(_ count: Int) -> String {
        count == 1 ? "1 new change" : "\(count.formatted()) new changes"
    }
}
