// What The Ranch's review card reads from the server: a folder's changes
// since it was last approved, each changed file drawn for its kind (lines,
// a sheet's grid, or passages and values), and the threads of comments and
// suggested changes pinned beside them. The words the card says are here
// too, so they can be checked without a window.

import Foundation

struct RanchReviewActor: Decodable, Equatable, Hashable {
    let id: String
    let name: String?
    /// HUMAN_SELF, HUMAN_COLLABORATOR, AI_AGENT or SYSTEM.
    let type: String?
    /// For an AI's save: the person who asked it.
    var askedBy: Asker? = nil

    struct Asker: Decodable, Equatable, Hashable {
        let id: String
        let name: String?
    }

    /// The person at this Mac, as the Mac app names them to the server.
    static let meID = "human:desktop"
    var isMe: Bool { id == Self.meID }
    var isAI: Bool { type == "AI_AGENT" }
    /// The name the card shows: this Mac's person by their own name.
    var shownName: String { isMe ? RanchReviewWords.myName : (name?.isEmpty == false ? name! : "Someone") }
}

struct RanchReviewFolder: Decodable, Identifiable, Equatable {
    let directoryId: String
    let name: String
    /// open, approved or empty.
    let state: String
    let files: Int
    let openThreads: Int
    let pendingComments: Int
    let people: [RanchReviewActor]
    var id: String { directoryId }
}

/// A folder's review: what changed since it was last approved, and who changed it.
struct RanchReview: Decodable, Equatable {
    struct Mark: Decodable, Equatable {
        let version: Int
        let at: Date?
        var approvedBy: RanchReviewActor? = nil
    }
    struct Approval: Decodable, Equatable {
        let id: String
        let at: Date?
        let by: RanchReviewActor?
        let comments: Int
    }
    struct File: Decodable, Equatable, Identifiable {
        let path: String
        let previousPath: String?
        let fileId: String?
        let fileType: String?
        /// edited, or unchanged for a file only asked to change.
        let change: String
        /// lines, sheet, values or file.
        let kind: String
        let viewed: Bool
        let comments: Int
        let openThreads: Int
        let editors: [RanchReviewActor]
        var id: String { path }
        var name: String { (path as NSString).lastPathComponent }
    }

    let directoryId: String
    let name: String
    /// open, approved or empty.
    let state: String
    let base: Mark
    let current: Mark
    let saves: Int
    let people: [RanchReviewActor]
    let pendingComments: Int
    /// Files listed because someone asked for a change and no one has edited them.
    var requests: Int? = nil
    let approval: Approval?
    let files: [File]
    let moreFiles: Int

    var viewedCount: Int { files.filter(\.viewed).count }
    /// Files someone edited, as against those only asked to change.
    var editedCount: Int { max(0, files.count + moreFiles - (requests ?? 0)) }

    private struct Envelope: Decodable { let review: RanchReview }
    static func decode(_ data: Data) throws -> RanchReview {
        try RanchOverview.decoder().decode(Envelope.self, from: data).review
    }
}

struct RanchReviewComment: Decodable, Equatable, Identifiable {
    let id: String
    let author: RanchReviewActor
    /// The person who asked, when an AI wrote it.
    let initiatedBy: RanchReviewActor?
    let body: String
    let at: Date?
    /// Not yet sent by an approval.
    let pending: Bool
    var suggestion: RanchReviewThread.Suggestion? = nil
    /// What a backslash prompt asked an AI to do.
    var prompt: String? = nil
    /// The AI's edit, when it made one.
    var executionId: String? = nil
}

struct RanchReviewThread: Decodable, Equatable, Identifiable {
    struct Anchor: Decodable, Equatable {
        /// line, cell, value or file.
        let kind: String
        var line: Int? = nil
        var text: String? = nil
        var sheet: String? = nil
        var row: Int? = nil
        var column: Int? = nil
        var value: String? = nil
        var place: String? = nil
        var label: String? = nil
    }
    struct Position: Decodable, Equatable {
        var line: Int? = nil
        var sheet: String? = nil
        var row: Int? = nil
        var column: Int? = nil
        var place: String? = nil
        var label: String? = nil
    }
    struct Mark: Decodable, Equatable {
        let at: Date?
        let by: RanchReviewActor?
        /// Found in a save rather than applied here.
        var saved: Bool? = nil
    }
    struct Suggestion: Decodable, Equatable {
        let before: String?
        let after: String
    }

    let id: String
    let path: String
    /// open, resolved, applied or outdated.
    let state: String
    let anchor: Anchor
    let by: RanchReviewActor?
    let at: Date?
    let resolved: Mark?
    let applied: Mark?
    let position: Position?
    /// "Line 9", "Accounting!B18", "Page 2".
    let place: String?
    let suggestion: Suggestion?
    let pending: Bool
    let comments: [RanchReviewComment]

    var isClosed: Bool { state == "resolved" || state == "applied" }
    /// The AI made the change this thread asked for.
    var editedByAI: Bool { applied?.by?.isAI == true }
    var people: [RanchReviewActor] {
        var seen = Set<String>()
        return comments.map(\.author).filter { seen.insert($0.id).inserted }
    }
}

/// One file of a review, drawn for its kind, with its threads.
struct RanchReviewFileView: Decodable, Equatable {
    struct Line: Decodable, Equatable {
        /// same, add or remove.
        let kind: String
        let text: String
        let before: Int?
        let after: Int?
    }
    struct Hunk: Decodable, Equatable { let lines: [Line] }
    struct Lines: Decodable, Equatable {
        let added: Int
        let removed: Int
        let hunks: [Hunk]
        let truncated: Bool
    }
    struct Column: Decodable, Equatable {
        let index: Int
        let letter: String
    }
    struct Cell: Decodable, Equatable {
        let value: String
        var before: String? = nil
        var changed: Bool? = nil
        var recalculated: Bool? = nil
    }
    struct Row: Decodable, Equatable {
        let number: Int
        /// same, modified, added or removed.
        let kind: String
        let cells: [Cell]
    }
    struct Heading: Decodable, Equatable {
        let number: Int
        let cells: [String]
    }
    struct SheetHunk: Decodable, Equatable {
        var heading: Heading? = nil
        let columns: [Column]
        let rows: [Row]
    }
    struct Sheet: Decodable, Equatable {
        let name: String
        let hunks: [SheetHunk]
    }
    struct Counts: Decodable, Equatable {
        let cells: Int
        let recalculated: Int
        let rowsAdded: Int
        let rowsRemoved: Int
    }
    struct Grid: Decodable, Equatable {
        let sheets: [Sheet]
        let counts: Counts
        let truncated: Bool
        let csv: Bool
    }
    struct Value: Decodable, Equatable {
        let kind: String
        let label: String?
        let place: String?
        let before: String?
        let after: String?
        var recalculated: Bool? = nil
    }
    struct Size: Decodable, Equatable {
        let before: Int?
        let after: Int?
    }

    let path: String
    let previousPath: String?
    let fileId: String?
    let fileType: String?
    let change: String
    let kind: String
    /// Written in code, so shown in a code face.
    let code: Bool
    /// Lasso writes this kind of file itself when a suggestion is applied.
    let writable: Bool
    let viewed: Bool
    let size: Size
    let lines: Lines?
    let sheet: Grid?
    let values: [Value]?
    let valueCount: Int
    let threads: [RanchReviewThread]

    private struct Envelope: Decodable { let file: RanchReviewFileView }
    static func decode(_ data: Data) throws -> RanchReviewFileView {
        try RanchOverview.decoder().decode(Envelope.self, from: data).file
    }
}

/// The card's words.
enum RanchReviewWords {
    /// This Mac's person, by the name macOS knows them by.
    static var myName: String {
        let name = NSFullUserName()
        return name.isEmpty ? "You" : name
    }

    /// A backslash at the start hands the rest to the AI writer.
    static func isPrompt(_ text: String) -> Bool {
        text.drop(while: \.isWhitespace).first == "\\"
    }

    /// "Dana", "Dana and ChatGPT", "Dana, Sam and 2 others".
    static func names(_ people: [RanchReviewActor]) -> String {
        // "You" leads a sentence and is "you" after a name.
        let shown = people.enumerated().map { index, person in person.isMe ? (index == 0 ? "You" : "you") : person.shownName }
        switch shown.count {
        case 0: return "No one"
        case 1: return shown[0]
        case 2: return "\(shown[0]) and \(shown[1])"
        case 3: return "\(shown[0]), \(shown[1]) and \(shown[2])"
        default: return "\(shown[0]), \(shown[1]) and \(shown.count - 2) others"
        }
    }

    /// The line under the folder's name: who edited how much since when, and the changes asked for.
    static func headline(_ review: RanchReview, now: Date = Date()) -> String {
        let edited = review.editedCount
        let requests = review.requests ?? 0
        let since: String
        if let approver = review.base.approvedBy {
            since = "since \(approver.isMe ? "you" : approver.shownName) approved \(day(review.base.at, now: now))"
        } else {
            since = "since Lasso first read it \(day(review.base.at, now: now))"
        }
        let asked = requests == 1 ? "1 change requested" : "\(requests.formatted()) changes requested"
        guard edited > 0 else { return requests > 0 ? asked : "Nothing edited \(since)" }
        let lead = "\(names(review.people)) edited \(edited == 1 ? "1 file" : "\(edited.formatted()) files") \(since)"
        return requests > 0 ? "\(lead) \u{00B7} \(asked)" : lead
    }

    /// "today", "yesterday", "Nov 12".
    static func day(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "" }
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return "today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "yesterday" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// "Just now", "38 min ago", "3 hr ago", "Nov 12".
    static func ago(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "" }
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "Just now" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) hr ago" }
        return day(date, now: now)
    }

    static func viewed(_ review: RanchReview) -> String {
        "\(review.viewedCount)/\(review.files.count) viewed"
    }

    /// "You approved these changes with 1 comment".
    static func approved(_ approval: RanchReview.Approval) -> (lead: String, rest: String) {
        let who = approval.by.map { $0.isMe ? "You" : $0.shownName } ?? "Someone"
        let rest = approval.comments == 0 ? "" : approval.comments == 1 ? "with 1 comment" : "with \(approval.comments.formatted()) comments"
        return ("\(who) approved these changes", rest)
    }

    static func change(_ change: String) -> String {
        switch change {
        case "added": return "New"
        case "removed": return "Removed"
        case "renamed": return "Renamed"
        case "moved": return "Moved"
        case "unchanged": return "Change requested"
        default: return "Edited"
        }
    }

    /// What a sheet's changes add up to: "2 cells · 1 recalculated · 1 row added".
    static func sheetCounts(_ counts: RanchReviewFileView.Counts) -> String {
        var parts: [String] = []
        let typed = counts.cells - counts.recalculated
        if typed > 0 { parts.append(typed == 1 ? "1 cell" : "\(typed.formatted()) cells") }
        if counts.recalculated > 0 { parts.append("\(counts.recalculated.formatted()) recalculated") }
        if counts.rowsAdded > 0 { parts.append(counts.rowsAdded == 1 ? "1 row added" : "\(counts.rowsAdded.formatted()) rows added") }
        if counts.rowsRemoved > 0 { parts.append(counts.rowsRemoved == 1 ? "1 row removed" : "\(counts.rowsRemoved.formatted()) rows removed") }
        return parts.isEmpty ? "No cells changed" : parts.joined(separator: " \u{00B7} ")
    }

    /// A closed thread's line: ("Suggestion applied", "Line 9 · Marcus Johnson").
    static func summary(_ thread: RanchReviewThread) -> (lead: String, rest: String) {
        let place = thread.place.map { [$0] } ?? []
        let author = thread.by.map { [$0.shownName] } ?? []
        if thread.state == "applied" {
            if let editor = thread.applied?.by, editor.isAI {
                let asker = thread.comments.last { $0.author.isAI }?.initiatedBy
                return ("\(editor.shownName) edited", (place + (asker.map { ["asked by \($0.shownName)"] } ?? [])).joined(separator: " \u{00B7} "))
            }
            if thread.applied?.saved == true { return ("Suggestion saved", (place + author).joined(separator: " \u{00B7} ")) }
            return ("Suggestion applied", (place + author).joined(separator: " \u{00B7} "))
        }
        if thread.state == "outdated" { return ("Outdated", (place + author).joined(separator: " \u{00B7} ")) }
        return ("Resolved", (place + author).joined(separator: " \u{00B7} "))
    }
}
