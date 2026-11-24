// The file a Word window shows, when Word does not say through Accessibility:
// found by the window's title among Word documents with that name, the one
// used last first, through Spotlight. A wrong guess costs nothing, since a
// part is drawn only where its words are found in the window's own text.

import CoreServices
import Foundation

enum AIDocumentLocator {
    /// Apps whose windows are looked up by title.
    static let apps: Set<String> = ["com.microsoft.Word"]

    private static var known: [String: (path: String?, at: Date)] = [:]
    private static let lock = NSLock()
    /// A title's answer is kept this long; a document saved under a new name is found after it.
    private static let life: TimeInterval = 20

    /// The names a window titled `title` may show: Word adds words like "[Compatibility Mode]" after the name.
    static func names(forTitle title: String) -> [String] {
        var base = title.trimmingCharacters(in: .whitespacesAndNewlines)
        for marker in [" [", " \u{2014} ", " - "] {
            if let range = base.range(of: marker) { base = String(base[..<range.lowerBound]) }
        }
        guard !base.isEmpty, base.count <= 255, !base.contains("/") else { return [] }
        return base.lowercased().hasSuffix(".docx") ? [base] : ["\(base).docx"]
    }

    /// The document a window titled `title` most likely shows, or nil.
    static func path(forTitle title: String) -> String? {
        let names = names(forTitle: title)
        guard let key = names.first else { return nil }
        lock.lock()
        if let hit = known[key], Date().timeIntervalSince(hit.at) < life { lock.unlock(); return hit.path }
        lock.unlock()
        let found = search(names)
        lock.lock()
        known[key] = (found, Date())
        if known.count > 64, let oldest = known.min(by: { $0.value.at < $1.value.at })?.key { known.removeValue(forKey: oldest) }
        lock.unlock()
        return found
    }

    private static func search(_ names: [String]) -> String? {
        let quoted = names.map { name in
            "kMDItemFSName == \"\(name.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\"c"
        }
        guard let query = MDQueryCreate(kCFAllocatorDefault, quoted.joined(separator: " || ") as CFString, nil, nil) else { return nil }
        MDQuerySetMaxCount(query, 25)
        guard MDQueryExecute(query, CFOptionFlags(kMDQuerySynchronous.rawValue)) else { return nil }
        var best: (path: String, used: Date)?
        for index in 0..<MDQueryGetResultCount(query) {
            guard let raw = MDQueryGetResultAtIndex(query, index) else { continue }
            let item = Unmanaged<MDItem>.fromOpaque(raw).takeUnretainedValue()
            guard let path = MDItemCopyAttribute(item, kMDItemPath) as? String, FileManager.default.fileExists(atPath: path) else { continue }
            let used = MDItemCopyAttribute(item, kMDItemLastUsedDate) as? Date
                ?? MDItemCopyAttribute(item, kMDItemContentModificationDate) as? Date ?? .distantPast
            if best.map({ used > $0.used }) ?? true { best = (path, used) }
        }
        return best?.path
    }
}
