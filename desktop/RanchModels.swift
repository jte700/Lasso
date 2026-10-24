// What The Ranch shows, as the server's GET /api/ranch describes it, and the
// orders directories and their files can be listed in. Everything here is a
// plain value; sorting returns new arrays.

import Cocoa

enum Ranch {
    /// The window's name, in the menu bar panel, the File menu and its title bar.
    static let title = "The Ranch"
}

struct RanchCounts: Decodable, Equatable {
    let tabs: Int
    let opens: Int
    let visits: Int
    let shares: Int
    let references: Int

    static let none = RanchCounts(tabs: 0, opens: 0, visits: 0, shares: 0, references: 0)

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

struct RanchDirectory: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let rootPath: String
    /// "folder" for a work directory, "app" for a connected app's items.
    let kind: String
    let symbol: String?
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

struct RanchSource: Decodable, Identifiable, Equatable {
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
    let counts: RanchCounts
    /// Share links to it that still work.
    let activeShares: Int
    let activity: Double

    /// The folders inside its directory, "" at the top.
    var folder: String { (path as NSString).deletingLastPathComponent }
    var fileExtension: String { (name as NSString).pathExtension.lowercased() }
}

struct RanchHistoryEntry: Decodable, Identifiable, Equatable {
    let id: String
    let directoryId: String
    let at: Date?
    /// added, edited, removed, renamed, moved, many (a capture of many files), or directory-added.
    let change: String
    let path: String?
    let previousPath: String?
    let fileId: String?
    let fileCount: Int?
}

struct RanchOutgoingLink: Decodable, Identifiable, Equatable {
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

struct RanchReceivedLink: Decodable, Identifiable, Equatable {
    let id: String
    let url: String
    let token: String
    let directoryId: String
    let path: String
    let fileId: String?
    let receivedAt: Date?
}

struct RanchLinks: Decodable, Equatable {
    let outgoing: [RanchOutgoingLink]
    let received: [RanchReceivedLink]
}

struct RanchReviewItem: Decodable, Identifiable, Equatable {
    let id: String
    /// changed, missing, unverified, unreadable, directory or drifted.
    let kind: String
    let title: String
    let directoryId: String
    let path: String?
    let fileId: String?
    let documents: [String]
    let detail: String
}

struct RanchEdge: Decodable, Equatable {
    let from: String
    let to: String
    /// link, used-in, mention or same-name.
    let kind: String
    let weight: Double
}

struct RanchNetworkData: Decodable, Equatable {
    let edges: [RanchEdge]
}

struct RanchOverview: Decodable, Equatable {
    let generatedAt: Date?
    let truncated: Bool
    let directories: [RanchDirectory]
    let sources: [RanchSource]
    let history: [RanchHistoryEntry]
    /// True when two weeks held more changes than are listed.
    let historyTruncated: Bool
    let links: RanchLinks
    let review: [RanchReviewItem]
    let network: RanchNetworkData

    static let empty = RanchOverview(generatedAt: nil, truncated: false, directories: [], sources: [], history: [],
                                     historyTruncated: false, links: RanchLinks(outgoing: [], received: []), review: [],
                                     network: RanchNetworkData(edges: []))

    /// The server writes ISO 8601 with milliseconds; a field it leaves null stays nil.
    static func decode(_ data: Data) throws -> RanchOverview {
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
        return try decoder.decode(RanchOverview.self, from: data)
    }
}

/// The four ways to order directories, and, chosen separately, the files in one.
enum RanchOrder: String, CaseIterable, Identifiable {
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

    func sorted(_ directories: [RanchDirectory]) -> [RanchDirectory] {
        ordered(directories, date: { directory in
            switch self {
            case .lastEdited: return directory.lastEditedAt
            case .recentlyUsed: return directory.lastUsedAt
            case .oldest, .newest: return directory.createdAt ?? directory.addedAt
            }
        }, name: \.name)
    }

    func sorted(_ sources: [RanchSource]) -> [RanchSource] {
        ordered(sources, date: { source in
            switch self {
            case .lastEdited: return source.modifiedAt
            case .recentlyUsed: return source.lastUsedAt
            case .oldest, .newest: return source.createdAt ?? source.modifiedAt
            }
        }, name: \.path)
    }

    /// Kept apart: ordering directories never changes the order inside one.
    static let directoryKey = "RanchDirectoryOrder"
    static let itemKey = "RanchItemOrder"

    static func saved(_ key: String, defaults: UserDefaults = .standard) -> RanchOrder {
        defaults.string(forKey: key).flatMap(RanchOrder.init(rawValue:)) ?? .lastEdited
    }
}

/// Grey for a file nobody has used, through to green for the most used.
enum RanchActivityColor {
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

enum RanchViewerKind: Equatable {
    case quickLook
    /// STEP models, drawn from the edges and faces Lasso's reader recorded.
    case wireframe
    /// Meshes SceneKit reads itself: STL, OBJ, PLY, USD and Collada.
    case mesh
    /// DXF and IFC plans.
    case plan

    private static let meshExtensions: Set<String> = ["stl", "obj", "ply", "usdz", "usd", "usda", "usdc", "abc", "dae", "scn"]

    static func choose(for fileExtension: String) -> RanchViewerKind {
        switch fileExtension.lowercased() {
        case "step", "stp": return .wireframe
        case "dxf", "ifc": return .plan
        case let other where meshExtensions.contains(other): return .mesh
        default: return .quickLook
        }
    }

    var hint: String? {
        switch self {
        case .wireframe, .mesh: return "Drag to rotate \u{00B7} Pinch or scroll to zoom \u{00B7} Option-drag to pan"
        case .plan: return "Pinch or scroll to zoom \u{00B7} Drag to pan"
        case .quickLook: return nil
        }
    }
}

/// Which kinds of file a list shows, chosen from the filter menu above it.
enum RanchKindFilter: String, CaseIterable, Identifiable {
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

    func includes(_ source: RanchSource) -> Bool { kind.map { $0 == source.kind } ?? true }

    static let key = "RanchKindFilter"
}
