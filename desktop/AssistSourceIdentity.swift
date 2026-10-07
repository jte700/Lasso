//  Canonical identity for a source-backed suggestion.
//
//  A completion can carry both an owning file path and a human-readable
//  breadcrumb (for example, "Accounting · Supplies · Current Period"). The
//  breadcrumb belongs in the UI; dependency identity must use the owning file
//  so rows, columns, cells, figures, and findings from one document stay one
//  color.

import Foundation

enum AssistSourceIdentity {
    enum OpenResult { case unavailable, failed, opened }

    static func canonicalPath(candidatePath: String?, provenanceLabel: String?) -> String {
        let candidate = candidatePath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !candidate.isEmpty { return candidate }
        return provenanceLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    static func key(path: String, objectId: String) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "object:\(objectId)" }
        var components: [String] = []
        for component in trimmed.replacingOccurrences(of: "\\", with: "/").split(separator: "/") {
            let part = String(component)
            if part == "." { continue }
            if part == "..", let last = components.last, last != ".." {
                components.removeLast()
            } else {
                components.append(part)
            }
        }
        let normalized = components.joined(separator: "/")
            .precomposedStringWithCanonicalMapping
            .lowercased()
        return "file:\(normalized)"
    }

    /// Resolves an indexed file to a local URL without allowing a candidate
    /// path (or a symlink inside the project) to escape the indexed root.
    static func localFileURL(
        projectRoot: String, sourcePath: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> URL? {
        guard (projectRoot as NSString).isAbsolutePath else { return nil }
        let root = URL(fileURLWithPath: projectRoot, isDirectory: true)
            .standardizedFileURL.resolvingSymlinksInPath()
        let rawSource = sourcePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawSource.isEmpty else { return nil }

        let normalizedSource = rawSource.replacingOccurrences(of: "\\", with: "/")
        let sourceURL: URL
        if (normalizedSource as NSString).isAbsolutePath {
            sourceURL = URL(fileURLWithPath: normalizedSource)
        } else {
            sourceURL = root.appendingPathComponent(normalizedSource)
        }

        let resolved = sourceURL.standardizedFileURL.resolvingSymlinksInPath()
        let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard resolved.path.hasPrefix(rootPrefix), fileExists(resolved.path) else { return nil }
        return resolved
    }

    /// Only a completed, deliberate open may influence recommendations. The
    /// injected operations keep failed opens and rejected source paths testable.
    static func openLocalFile(
        projectRoot: String, sourcePath: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        open: (URL) -> Bool, onOpened: () -> Void
    ) -> OpenResult {
        guard let url = localFileURL(projectRoot: projectRoot, sourcePath: sourcePath,
                                     fileExists: fileExists) else { return .unavailable }
        guard open(url) else { return .failed }
        onOpened()
        return .opened
    }

    /// Keeps one palette slot per owning source, repairs old collisions, and
    /// preserves the first usable persisted preference for each source.
    static func colorAssignments(
        _ sources: [(key: String, preferred: Int?)], paletteCount: Int,
        fallback: (String) -> Int
    ) -> [String: Int] {
        guard paletteCount > 0 else { return [:] }
        var assignments: [String: Int] = [:]
        var occupied = Set<Int>()
        func normalized(_ slot: Int) -> Int {
            (slot % paletteCount + paletteCount) % paletteCount
        }
        for source in sources where assignments[source.key] == nil {
            let preferred = source.preferred.map(normalized)
            let slot: Int
            if let preferred, !occupied.contains(preferred) {
                slot = preferred
            } else if let available = (0..<paletteCount).first(where: { !occupied.contains($0) }) {
                slot = available
            } else {
                slot = normalized(fallback(source.key))
            }
            assignments[source.key] = slot
            occupied.insert(slot)
        }
        return assignments
    }
}

/// Chooses what accepting a source candidate should type. A candidate can
/// carry both a semantic name and a child value; the claim type decides which
/// one the writer is asking for.
enum AssistSuggestionSemantics {
    static func insertionText(claimType: String?, label: String, value: String?) -> String {
        let labelFirst = Set(["ENTITY", "DATASET_REFERENCE", "FIGURE", "TABLE_REFERENCE", "METHOD"])
        if let claimType, labelFirst.contains(claimType), !label.isEmpty { return label }
        return value ?? label
    }
}
