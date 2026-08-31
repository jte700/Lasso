//  Canonical identity for a source-backed suggestion.
//
//  A completion can carry both an owning file path and a human-readable
//  breadcrumb (for example, "Accounting · Supplies · Current Period"). The
//  breadcrumb belongs in the UI; dependency identity must use the owning file
//  so rows, columns, cells, figures, and findings from one document stay one
//  color.

import Foundation

enum AssistSourceIdentity {
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
