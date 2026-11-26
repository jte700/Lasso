// What The Loop shows, as the server's GET /api/loop describes it, and the
// orders directories and their files can be listed in. Everything here is a
// plain value; sorting returns new arrays.

import Cocoa

enum Loop {
    /// The window's name, in the menu bar panel, the File menu and its title bar.
    static let title = "The Loop"
    /// ⇧⌘L, which Lasso holds in every app while it runs; menus show it.
    static let key = "l"
    static let modifiers: NSEvent.ModifierFlags = [.command, .shift]
}

struct LoopCounts: Decodable, Equatable {
    let tabs: Int
    let opens: Int
    let visits: Int
    let shares: Int
    let references: Int

    static let none = LoopCounts(tabs: 0, opens: 0, visits: 0, shares: 0, references: 0)

    /// Every time the file was used, whichever way.
    var total: Int { tabs + opens + visits + shares + references }

    /// "Tabbed 3 times · Shared once", leaving out what never happened.
    var summary: String {
        let parts: [(Int, String)] = [(tabs, "Tabbed"), (opens, "Opened from a suggestion"), (visits, "Viewed"),
                                      (shares, "Shared"), (references, "Linked")]
        let said = parts.filter { $0.0 > 0 }.map { count, verb in
            "\(verb) \(count == 1 ? "once" : count == 2 ? "twice" : "\(count) times")"
        }
        return said.isEmpty ? "Not used yet" : said.joined(separator: " \u{00B7} ")
    }
}

struct LoopDirectory: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let rootPath: String
    /// "folder" for a work directory, "app" for a connected app's items.
    let kind: String
    let symbol: String?
    /// The connected app's provider, such as "google-drive"; nil for a folder.
    let provider: String?
    /// A cloud drive, such as Google Drive, rather than mail, calendars or pages.
    let cloud: Bool?
    let active: Bool
    let available: Bool
    let offline: Bool
    let snapshotId: String?
    let fileCount: Int
    let listedCount: Int
    let issue: String?
    let createdAt: Date?
    let addedAt: Date?
    let lastEditedAt: Date?
    let lastUsedAt: Date?
    let activity: Double

    var isApp: Bool { kind == "app" }
}

struct LoopSource: Decodable, Identifiable, Equatable {
    let id: String
    let directoryId: String
    let path: String
    let name: String
    let kind: String
    let size: Int
    let contentHash: String?
    let modifiedAt: Date?
    let createdAt: Date?
    let lastUsedAt: Date?
    let counts: LoopCounts
    /// Share links to it that still work.
    let activeShares: Int
    let activity: Double
    /// How Lasso read it: "code", "presentation", "pdf" and so on.
    var fileType: String? = nil
    /// False for code, which is sent as a copy of the file, never as a share link.
    var shareable: Bool? = nil

    var canShareLink: Bool { shareable ?? true }
    /// Programming files, shown with their line numbers so they can be cited by line.
    var isCode: Bool { fileType == "code" || fileType == "yaml" }

    /// The folders inside its directory, "" at the top.
    var folder: String { (path as NSString).deletingLastPathComponent }
    var fileExtension: String { (name as NSString).pathExtension.lowercased() }
}

struct LoopHistoryEntry: Decodable, Identifiable, Equatable {
    let id: String
    let directoryId: String
    let at: Date?
    /// added, edited, removed, renamed, moved, many (a capture of many files), or directory-added.
    let change: String
    let path: String?
    let previousPath: String?
    let fileId: String?
    let fileCount: Int?
    /// The values an edit changed, when it changed any the index reads.
    var valueChanges: LoopValueChanges? = nil
    /// How Lasso came to record it: WATCHER for a save it saw, AGENT_EDIT, IMPORT, ...
    var source: String? = nil
    /// Who history says made it.
    var actor: LoopActor? = nil
    /// The lines (or Markdown paragraphs) an edit to a text file added and removed.
    var textChanges: LoopTextChanges? = nil

    /// The caption of an edit that changed values: "Q3 Total 18,400 → 19,250"
    /// for one, "4 values changed · Finance" for several; nil otherwise. Only
    /// the values typed into count: the formula cells that recalculated from
    /// them are listed in the change's detail.
    func valueCaption(directory: String) -> String? {
        guard change == "edited", let changes = valueChanges, changes.count > 0 else { return nil }
        let recalculated = min(changes.recalculated ?? 0, changes.count)
        let typed = changes.count - recalculated
        // A short value is quoted; a passage, which a row has no room for, is counted.
        let quotable = { (value: String) in value.count <= 40 && !value.contains(where: \.isNewline) }
        if typed == 1 || changes.count == 1, let first = changes.first, let before = first.beforeDisplay ?? first.before,
           let after = first.afterDisplay ?? first.after, quotable(before), quotable(after) {
            let label = first.label.map { "\($0) " } ?? ""
            return "\(label)\(before) \u{2192} \(after)"
        }
        if typed == 0 {
            return "\(recalculated == 1 ? "1 value" : "\(recalculated.formatted()) values") recalculated \u{00B7} \(directory)"
        }
        return "\(typed == 1 ? "1 value" : "\(typed.formatted()) values") changed \u{00B7} \(directory)"
    }
}

/// How many lines (or Markdown paragraphs) an edit to a text file added and removed.
struct LoopTextChanges: Decodable, Equatable {
    let added: Int
    let removed: Int
    /// line, or paragraph for Markdown.
    let unit: String
}

/// How many values one edit changed, and the first of them.
struct LoopValueChanges: Decodable, Equatable {
    struct Change: Decodable, Equatable {
        let label: String?
        let before: String?
        let after: String?
        /// As a worksheet shows them ("18,400"), when that differs from the stored values.
        var beforeDisplay: String? = nil
        var afterDisplay: String? = nil
    }
    let count: Int
    /// A value typed into when the edit has one, else a recalculated one.
    let first: Change?
    /// How many of `count` are formula cells that changed because their inputs did.
    var recalculated: Int? = nil
}

struct LoopOutgoingLink: Decodable, Identifiable, Equatable {
    let id: String
    /// OBJECT for a link to a source, DEPENDENCY for one made in the browser editor.
    let kind: String
    let token: String
    let url: String
    let directoryId: String
    let path: String?
    let fileId: String?
    let name: String?
    let locator: String?
    let scope: String
    /// active, expired or revoked.
    let status: String
    let drifted: Bool
    let createdAt: Date?
    let expiresAt: Date?
    let revokedAt: Date?
}

struct LoopReceivedLink: Decodable, Identifiable, Equatable {
    let id: String
    let url: String
    let token: String
    let directoryId: String
    let path: String
    let fileId: String?
    let receivedAt: Date?
}

struct LoopLinks: Decodable, Equatable {
    let outgoing: [LoopOutgoingLink]
    let received: [LoopReceivedLink]
}

struct LoopReviewItem: Decodable, Identifiable, Equatable {
    let id: String
    /// changed, missing, unverified, unreadable, directory or drifted.
    let kind: String
    let title: String
    let directoryId: String
    let path: String?
    let fileId: String?
    let documents: [String]
    let detail: String
    /// The links behind a changed, missing or unverified source, one per document passage.
    var links: [LoopReviewLink] = []
    /// For a changed link or a drifted share: the value then and now, and the claim it backs.
    var before: String? = nil
    var after: String? = nil
    var claim: String? = nil
    /// The values as a worksheet shows them, when that differs from the stored ones.
    var beforeDisplay: String? = nil
    var afterDisplay: String? = nil

    private enum Keys: String, CodingKey {
        case id, kind, title, directoryId, path, fileId, documents, detail, links, before, after, claim, beforeDisplay, afterDisplay
    }

    /// "18,400 → 19,250 · “Payroll came to 18,400”", or nil when the item names no change of value.
    var valueChangeLine: String? {
        guard let before, let after, before != after else { return nil }
        let change = "\(beforeDisplay ?? before) \u{2192} \(afterDisplay ?? after)"
        guard let claim = claim?.trimmingCharacters(in: .whitespacesAndNewlines), !claim.isEmpty else { return change }
        return "\(change) \u{00B7} \u{201C}\(claim)\u{201D}"
    }

    init(id: String, kind: String, title: String, directoryId: String, path: String?, fileId: String?,
         documents: [String], detail: String, links: [LoopReviewLink] = []) {
        self.id = id
        self.kind = kind
        self.title = title
        self.directoryId = directoryId
        self.path = path
        self.fileId = fileId
        self.documents = documents
        self.detail = detail
        self.links = links
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(String.self, forKey: .kind)
        title = try container.decode(String.self, forKey: .title)
        directoryId = try container.decode(String.self, forKey: .directoryId)
        path = try container.decodeIfPresent(String.self, forKey: .path)
        fileId = try container.decodeIfPresent(String.self, forKey: .fileId)
        documents = try container.decode([String].self, forKey: .documents)
        detail = try container.decode(String.self, forKey: .detail)
        // Older servers send none; links that don't read leave the item as it was.
        links = (try? container.decode([LoopReviewLink].self, forKey: .links)) ?? []
        before = try? container.decodeIfPresent(String.self, forKey: .before)
        after = try? container.decodeIfPresent(String.self, forKey: .after)
        claim = try? container.decodeIfPresent(String.self, forKey: .claim)
        beforeDisplay = try? container.decodeIfPresent(String.self, forKey: .beforeDisplay)
        afterDisplay = try? container.decodeIfPresent(String.self, forKey: .afterDisplay)
    }
}

/// One link a review item is about: the words in a document, and the value
/// in the source they cite, as Lasso recorded them.
struct LoopReviewLink: Decodable, Identifiable, Equatable {
    let id: String
    /// STALE, BROKEN or NEEDS_REVIEW.
    let status: String
    let documentDirectoryId: String
    let documentPath: String
    let documentFileId: String?
    /// The linked words, as the document has them.
    let text: String
    let label: String?
    let linkedValue: String?
    /// What the source holds now, when Lasso found it changed.
    let currentValue: String?
    let anchor: LoopAnchor?
    /// What Lasso couldn't confirm, in its own words.
    let issue: String?

    var documentName: String { (documentPath as NSString).lastPathComponent }
}

/// Where in its source a link points: a sheet's cell, a page, a line or a model
/// element. Anchors come in many shapes, so a field of another type is left out
/// rather than failing the whole library.
struct LoopAnchor: Decodable, Equatable {
    var kind: String? = nil
    var sheet: String? = nil
    var rowIndex: Int? = nil
    var columnIndex: Int? = nil
    var rowKey: String? = nil
    var pageNumber: Int? = nil
    var line: Int? = nil
    var elementId: String? = nil
    var slideNumber: Int? = nil

    private enum Keys: String, CodingKey {
        case kind, sheet, rowIndex, columnIndex, rowKey, pageNumber, page, line, lineStart, elementId, slideNumber
    }

    init(kind: String? = nil, sheet: String? = nil, rowIndex: Int? = nil, columnIndex: Int? = nil, rowKey: String? = nil,
         pageNumber: Int? = nil, line: Int? = nil, elementId: String? = nil) {
        self.kind = kind
        self.sheet = sheet
        self.rowIndex = rowIndex
        self.columnIndex = columnIndex
        self.rowKey = rowKey
        self.pageNumber = pageNumber
        self.line = line
        self.elementId = elementId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        kind = try? container.decode(String.self, forKey: .kind)
        sheet = try? container.decode(String.self, forKey: .sheet)
        rowIndex = try? container.decode(Int.self, forKey: .rowIndex)
        columnIndex = try? container.decode(Int.self, forKey: .columnIndex)
        rowKey = try? container.decode(String.self, forKey: .rowKey)
        pageNumber = (try? container.decode(Int.self, forKey: .pageNumber)) ?? (try? container.decode(Int.self, forKey: .page))
        line = (try? container.decode(Int.self, forKey: .line)) ?? (try? container.decode(Int.self, forKey: .lineStart))
        elementId = try? container.decode(String.self, forKey: .elementId)
        slideNumber = try? container.decode(Int.self, forKey: .slideNumber)
    }
}

/// A workbook's sheets as Lasso reads them, for the sheet view.
struct LoopWorkbook: Decodable, Equatable {
    let sheets: [LoopSheet]
    /// Sheets too large or damaged to read; the file then shows in Quick Look.
    let skipped: [String]
    /// The version shown, and the file's versions newest first, for the version menu.
    var version: String? = nil
    var versions: [LoopFileVersion]? = nil
    /// The cells the shown version changed, each with what it was.
    var changes: [LoopCellChange]? = nil

    /// The shown version's changes on one sheet, by the row and column the grid shows them at.
    func changedCells(onSheet index: Int) -> [LoopCellKey: LoopCellChange] {
        guard sheets.indices.contains(index) else { return [:] }
        let sheet = sheets[index]
        var cells: [LoopCellKey: LoopCellChange] = [:]
        for change in changes ?? [] where change.sheet == sheet.name || (change.sheet == nil && index == 0) {
            guard let row = sheet.rowNumbers.firstIndex(of: change.row) else { continue }
            cells[LoopCellKey(row: row, column: change.column)] = change
        }
        return cells
    }

    /// The sheet, row and column a link cites. The row is found again by its
    /// label when rows were added above it since the link was made.
    func place(of anchor: LoopAnchor) -> LoopCellPlace? {
        guard anchor.rowIndex != nil || anchor.rowKey != nil else { return nil }
        // A sheet the link names and the workbook no longer has is not guessed at.
        let named = anchor.sheet.map { name in sheets.firstIndex { $0.name == name } }
        guard let sheetIndex = named ?? sheets.indices.first else { return nil }
        let sheet = sheets[sheetIndex]
        let key = anchor.rowKey?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let holdsKey = { (row: Int) -> Bool in
            guard let key, !key.isEmpty else { return true }
            return sheet.rows[row].contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == key }
        }
        let recorded = anchor.rowIndex.flatMap { sheet.rows.indices.contains($0) ? $0 : nil }
        guard let row = recorded.flatMap({ holdsKey($0) ? $0 : nil })
                ?? (key == nil ? nil : sheet.rows.indices.first(where: holdsKey)) ?? recorded else { return nil }
        let column = anchor.columnIndex.flatMap { (0..<sheet.columns).contains($0) ? $0 : nil }
        return LoopCellPlace(sheet: sheetIndex, sheetName: sheet.name, row: row, column: column,
                              name: column.map { LoopSheetColumns.letter($0) + "\(sheet.rowNumbers[safe: row] ?? row + 1)" })
    }
}

struct LoopSheet: Decodable, Equatable {
    let name: String
    let columns: Int
    let rows: [[String]]
    /// The number the app shows beside each row.
    let rowNumbers: [Int]
    /// More rows or columns than the view shows.
    let truncated: Bool
}

/// One version of a file: the snapshot its save made, and when.
struct LoopFileVersion: Decodable, Equatable, Identifiable {
    let snapshotId: String
    let at: String?
    /// False when Lasso no longer keeps this version's bytes, so it cannot be shown.
    var available: Bool? = nil
    var id: String { snapshotId }
}

/// A cell the shown version changed: its sheet row number and column, and the value before and after.
struct LoopCellChange: Decodable, Equatable {
    let sheet: String?
    let row: Int
    let column: Int
    let before: String?
    let after: String?
    let changedAt: String?
    /// The earlier value as the sheet shows it ("18,400"), when that differs from the stored one.
    var beforeDisplay: String? = nil

    /// "was 18,400 · Nov 10, 3:04 PM", shown on hover; `date` writes the time of the change.
    func hoverText(date: (String?) -> String) -> String {
        let when = date(changedAt)
        return "was \(beforeDisplay ?? before ?? "empty")" + (when.isEmpty ? "" : " \u{00B7} \(when)")
    }
}

/// Where a cell sits in the grid: its row as shown, and its column from 0.
struct LoopCellKey: Hashable {
    let row: Int
    let column: Int
}

/// A cell in a workbook, or a whole row when the link names no column.
struct LoopCellPlace: Equatable {
    let sheet: Int
    let sheetName: String
    let row: Int
    let column: Int?
    /// "B19", as the app names the cell.
    let name: String?
}

enum LoopSheetColumns {
    /// A, B … Z, AA, AB, as spreadsheets name columns, from 0.
    static func letter(_ index: Int) -> String {
        var number = index + 1
        var name = ""
        while number > 0 {
            let remainder = (number - 1) % 26
            name = String(UnicodeScalar(UInt8(65 + remainder))) + name
            number = (number - 1) / 26
        }
        return name
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

struct LoopEdge: Decodable, Equatable {
    let from: String
    let to: String
    /// link, used-in, mention or same-name.
    let kind: String
    let weight: Double
    /// Why the two files connect; missing from a server older than this app.
    let reasons: [LoopEdgeReason]?
}

/// One reason two files connect: the value linked, the name mentioned or
/// shared, with the file it starts from (nil when it runs both ways).
struct LoopEdgeReason: Decodable, Equatable {
    let from: String?
    let text: String?
}

struct LoopNetworkData: Decodable, Equatable {
    let edges: [LoopEdge]
}

struct LoopOverview: Decodable, Equatable {
    let generatedAt: Date?
    let truncated: Bool
    let directories: [LoopDirectory]
    let sources: [LoopSource]
    let history: [LoopHistoryEntry]
    /// True when two weeks held more changes than are listed.
    let historyTruncated: Bool
    let links: LoopLinks
    let review: [LoopReviewItem]
    let network: LoopNetworkData

    static let empty = LoopOverview(generatedAt: nil, truncated: false, directories: [], sources: [], history: [],
                                     historyTruncated: false, links: LoopLinks(outgoing: [], received: []), review: [],
                                     network: LoopNetworkData(edges: []))

    /// The server writes ISO 8601 with milliseconds; a field it leaves null stays nil.
    static func decode(_ data: Data) throws -> LoopOverview {
        try decoder().decode(LoopOverview.self, from: data)
    }

    /// A decoder for what The Loop's routes send, its dates in ISO 8601 with or without milliseconds.
    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = precise.date(from: text) ?? plain.date(from: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath,
                                                        debugDescription: "Not an ISO 8601 date: \(text)"))
            }
            return date
        }
        return decoder
    }
}

/// A directory's files as the folders they sit in, for the sidebar's outline.
struct LoopTree: Equatable {
    struct Folder: Equatable {
        /// Inside the directory, "" for the directory itself.
        let path: String
        let name: String
        let folders: [Folder]
        let files: [LoopSource]
    }

    /// One line of the outline. Depth 1 is directly inside the directory.
    enum Row: Equatable, Identifiable {
        case folder(path: String, name: String, depth: Int)
        case file(LoopSource, depth: Int)

        var id: String {
            switch self {
            case .folder(let path, _, _): return "folder:" + path
            case .file(let source, _): return "file:" + source.id
            }
        }
    }

    let root: Folder

    var isEmpty: Bool { root.folders.isEmpty && root.files.isEmpty }

    /// Folders in name order, each before the files beside it; files keep the order given.
    static func make(_ sources: [LoopSource]) -> LoopTree {
        var files: [String: [LoopSource]] = [:]
        var children: [String: Set<String>] = [:]
        for source in sources {
            files[source.folder, default: []].append(source)
            var path = source.folder
            while !path.isEmpty {
                let parent = (path as NSString).deletingLastPathComponent
                children[parent, default: []].insert(path)
                path = parent
            }
        }
        func name(_ path: String) -> String { (path as NSString).lastPathComponent }
        func folder(_ path: String) -> Folder {
            let inside = (children[path] ?? []).sorted { name($0).localizedStandardCompare(name($1)) == .orderedAscending }
            return Folder(path: path, name: name(path), folders: inside.map(folder), files: files[path] ?? [])
        }
        return LoopTree(root: folder(""))
    }

    /// What the outline shows, top to bottom, with the folders `isOpen` names opened.
    func rows(isOpen: (String) -> Bool) -> [Row] {
        var rows: [Row] = []
        func add(_ folder: Folder, depth: Int) {
            for child in folder.folders {
                rows.append(.folder(path: child.path, name: child.name, depth: depth))
                if isOpen(child.path) { add(child, depth: depth + 1) }
            }
            rows += folder.files.map { .file($0, depth: depth) }
        }
        add(root, depth: 1)
        return rows
    }

    /// How the outline remembers an open directory ("" inside it) or folder.
    static func key(directory: String, folder: String = "") -> String {
        folder.isEmpty ? directory : directory + "/" + folder
    }
}

/// The four ways to order directories, and, chosen separately, the files in one.
enum LoopOrder: String, CaseIterable, Identifiable {
    case lastEdited, recentlyUsed, oldest, newest

    var id: String { rawValue }

    var title: String {
        switch self {
        case .lastEdited: return "Last Edited"
        case .recentlyUsed: return "Recently Used"
        case .oldest: return "Oldest"
        case .newest: return "Newest"
        }
    }

    /// Never-used and undated items go last, then by name, in every order.
    private func ordered<Item>(_ items: [Item], date: (Item) -> Date?, name: (Item) -> String) -> [Item] {
        let ascending = self == .oldest
        return items.sorted { left, right in
            switch (date(left), date(right)) {
            case let (l?, r?) where l != r: return ascending ? l < r : l > r
            case (_?, nil): return true
            case (nil, _?): return false
            default: return name(left).localizedStandardCompare(name(right)) == .orderedAscending
            }
        }
    }

    func sorted(_ directories: [LoopDirectory]) -> [LoopDirectory] {
        ordered(directories, date: { directory in
            switch self {
            case .lastEdited: return directory.lastEditedAt
            case .recentlyUsed: return directory.lastUsedAt
            case .oldest, .newest: return directory.createdAt ?? directory.addedAt
            }
        }, name: \.name)
    }

    func sorted(_ sources: [LoopSource]) -> [LoopSource] {
        ordered(sources, date: { source in
            switch self {
            case .lastEdited: return source.modifiedAt
            case .recentlyUsed: return source.lastUsedAt
            case .oldest, .newest: return source.createdAt ?? source.modifiedAt
            }
        }, name: \.path)
    }

    /// Kept apart: ordering directories never changes the order inside one.
    static let directoryKey = "LoopDirectoryOrder"
    static let itemKey = "LoopItemOrder"

    static func saved(_ key: String, defaults: UserDefaults = .standard) -> LoopOrder {
        defaults.string(forKey: key).flatMap(LoopOrder.init(rawValue:)) ?? .lastEdited
    }
}

/// Directories pinned from their right-click menu sit at the top of their
/// section, in the chosen directory order among themselves.
enum LoopPins {
    static let key = "LoopPinnedDirectories"

    static func saved(defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.stringArray(forKey: key) ?? [])
    }

    static func save(_ pinned: Set<String>, defaults: UserDefaults = .standard) {
        defaults.set(pinned.sorted(), forKey: key)
    }

    static func ordered(_ directories: [LoopDirectory], pinned: Set<String>) -> [LoopDirectory] {
        directories.filter { pinned.contains($0.id) } + directories.filter { !pinned.contains($0.id) }
    }
}

/// The directories the network showed before each click into another, so
/// Back retraces them; nil is every directory.
struct LoopNetworkTrail: Equatable {
    private static let limit = 50
    private(set) var visited: [String?] = []

    var canGoBack: Bool { !visited.isEmpty }

    mutating func leave(_ shown: String?, for next: String?) {
        guard shown != next else { return }
        visited.append(shown)
        if visited.count > Self.limit { visited.removeFirst() }
    }

    /// The view before the current one: the last one left, or every directory.
    mutating func back() -> String? {
        visited.popLast() ?? nil
    }

    mutating func clear() { visited.removeAll() }
}

/// Grey for a file nobody has used, through to green for the most used.
enum LoopActivityColor {
    private static let hue: CGFloat = 0.37
    private static let maxSaturation: CGFloat = 0.78
    private static let greyBrightness: CGFloat = 0.62
    private static let greenBrightness: CGFloat = 0.80

    static func color(for activity: Double) -> NSColor {
        let amount = CGFloat(min(1, max(0, activity.isFinite ? activity : 0)))
        return NSColor(calibratedHue: hue, saturation: maxSaturation * amount,
                       brightness: greyBrightness + (greenBrightness - greyBrightness) * amount, alpha: 1)
    }
}

enum LoopViewerKind: Equatable {
    case quickLook
    /// Programming files, numbered line by line.
    case code
    /// Plain text and Markdown, numbered line by line like code, with the passages
    /// the latest version changed tinted.
    case text
    /// STEP models, drawn from the edges and faces Lasso's reader recorded.
    case wireframe
    /// Meshes SceneKit reads itself: STL, OBJ, PLY, USD and Collada.
    case mesh
    /// DXF and IFC plans.
    case plan
    /// Workbooks, as cells Lasso reads, with Quick Look's layout a click away.
    case sheet
    /// PowerPoint decks, as the pictures Lasso draws of each slide, under a slide menu.
    case slides

    private static let sheetExtensions: Set<String> = ["xlsx", "xlsm", "xls"]
    private static let textExtensions: Set<String> = ["txt", "text", "md", "markdown", "mdx", "qmd", "rmd"]
    private static let meshExtensions: Set<String> = ["stl", "obj", "ply", "usdz", "usd", "usda", "usdc", "abc", "dae", "scn"]

    /// Code larger than this scrolls in Quick Look instead.
    static let maximumCodeBytes = 5_000_000

    static func choose(for source: LoopSource) -> LoopViewerKind {
        guard source.size <= maximumCodeBytes else { return choose(for: source.fileExtension) }
        if source.isCode { return .code }
        return textExtensions.contains(source.fileExtension) ? .text : choose(for: source.fileExtension)
    }

    static func choose(for fileExtension: String) -> LoopViewerKind {
        switch fileExtension.lowercased() {
        case "step", "stp": return .wireframe
        case "dxf", "ifc": return .plan
        case let other where meshExtensions.contains(other): return .mesh
        case let other where sheetExtensions.contains(other): return .sheet
        case "pptx": return .slides
        default: return .quickLook
        }
    }

    var hint: String? {
        switch self {
        case .wireframe, .mesh: return "Drag to rotate \u{00B7} Pinch or scroll to zoom \u{00B7} Option-drag to pan"
        case .plan: return "Pinch or scroll to zoom \u{00B7} Drag to pan"
        case .quickLook, .code, .text, .sheet, .slides: return nil
        }
    }
}

/// Which kinds of file a list shows, chosen from the filter menu above it.
enum LoopKindFilter: String, CaseIterable, Identifiable {
    case all, documents, spreadsheets, pdfs, presentations, models, drawings, images, text, code, other

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All Kinds"
        case .documents: return "Documents"
        case .spreadsheets: return "Spreadsheets"
        case .pdfs: return "PDFs"
        case .presentations: return "Presentations"
        case .models: return "3D Models"
        case .drawings: return "Drawings"
        case .images: return "Images"
        case .text: return "Notes and Text"
        case .code: return "Code and Data"
        case .other: return "Other Files"
        }
    }

    var symbol: String {
        switch self {
        case .all: return "square.stack"
        case .documents: return "doc.richtext"
        case .spreadsheets: return "tablecells"
        case .pdfs: return "doc.text"
        case .presentations: return "rectangle.on.rectangle"
        case .models: return "cube"
        case .drawings: return "pencil.and.ruler"
        case .images: return "photo"
        case .text: return "note.text"
        case .code: return "curlybraces"
        case .other: return "doc"
        }
    }

    /// The server's name for the kind this filter keeps.
    private var kind: String? {
        switch self {
        case .all: return nil
        case .documents: return "document"
        case .spreadsheets: return "spreadsheet"
        case .pdfs: return "pdf"
        case .presentations: return "presentation"
        case .models: return "model"
        case .drawings: return "drawing"
        case .images: return "image"
        case .text: return "text"
        case .code: return "code"
        case .other: return "other"
        }
    }

    func includes(_ source: LoopSource) -> Bool { kind.map { $0 == source.kind } ?? true }

    /// The filter that keeps one of the server's kinds.
    static func keeping(_ kind: String) -> LoopKindFilter? { allCases.first { $0.kind == kind } }

    /// One file of this kind, as a short label: "Spreadsheet", "PDF".
    static func label(for kind: String) -> String {
        switch kind {
        case "document": return "Document"
        case "spreadsheet": return "Spreadsheet"
        case "pdf": return "PDF"
        case "presentation": return "Slides"
        case "model": return "3D model"
        case "drawing": return "Drawing"
        case "image": return "Image"
        case "video": return "Video"
        case "text": return "Text"
        case "code": return "Code"
        default: return "File"
        }
    }

    static let key = "LoopKindFilter"
}

/// Which lines of a file a selection covers, numbered as editors and
/// Lasso's "line 42" number them.
enum LoopCodeLines {
    static func lines(in text: String, selection: NSRange) -> ClosedRange<Int>? {
        let units = Array(text.utf16)
        guard selection.location != NSNotFound, selection.length > 0, selection.location < units.count else { return nil }
        let newline = UInt16(UInt8(ascii: "\n"))
        let start = selection.location
        // A selection that ends just after a line break ends on that line.
        var end = min(units.count, selection.location + selection.length) - 1
        if end > start, units[end] == newline { end -= 1 }
        let first = units[..<start].filter { $0 == newline }.count + 1
        let last = first + units[start..<max(start, end)].filter { $0 == newline }.count
        return first...last
    }

    /// Line `line` of `text`, with its line break, as a range to select.
    static func range(ofLine line: Int, in text: String) -> NSRange {
        let text = text as NSString
        var start = 0
        var current = 1
        while current < line, start < text.length {
            let newline = text.range(of: "\n", options: [], range: NSRange(location: start, length: text.length - start))
            if newline.location == NSNotFound { break }
            start = newline.location + 1
            current += 1
        }
        return text.lineRange(for: NSRange(location: min(start, text.length), length: 0))
    }

    /// "Lines 10–20", what to write after the file's name to insert them.
    static func label(_ lines: ClosedRange<Int>) -> String {
        lines.count == 1 ? "Line \(lines.lowerBound)" : "Lines \(lines.lowerBound)\u{2013}\(lines.upperBound)"
    }
}
