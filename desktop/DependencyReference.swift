//  Local dependency references.
//
//  A reference records that a span of text in some other application came from
//  an indexed source. It is local augmentation: the host document is never
//  modified, and no share token exists unless the user explicitly asks for one.
//
//  The anchor is deliberately not a bare offset. Surrounding text changes as the
//  user writes, so a reference stores the phrase plus the text either side of it
//  and relocates itself. When it cannot do so confidently it becomes
//  unresolved rather than attaching to the wrong identical phrase.

import Foundation

// MARK: - Anchoring

struct TextAnchor: Codable, Equatable {
    /// The linked phrase exactly as inserted.
    let text: String
    /// Text immediately before and after it, used to disambiguate repeats.
    let prefixContext: String
    let suffixContext: String
    /// Where it was when created; only a tie-breaker, never the sole evidence.
    let approximateOffset: Int

    static let contextLength = 48

    /// Builds an anchor from a document and the range the phrase occupies.
    static func make(in document: [UInt16], range: Range<Int>, documentOffset: Int = 0) -> TextAnchor? {
        guard range.lowerBound >= 0, range.upperBound <= document.count,
              range.lowerBound < range.upperBound, documentOffset >= 0 else { return nil }
        let prefixStart = max(0, range.lowerBound - contextLength)
        let suffixEnd = min(document.count, range.upperBound + contextLength)
        return TextAnchor(
            text: String(decoding: document[range], as: UTF16.self),
            prefixContext: String(decoding: document[prefixStart..<range.lowerBound], as: UTF16.self),
            suffixContext: String(decoding: document[range.upperBound..<suffixEnd], as: UTF16.self),
            approximateOffset: documentOffset + range.lowerBound)
    }
}

enum AnchorResolution: Equatable {
    case resolved(Range<Int>)
    /// The phrase is gone, or several candidates are equally plausible.
    case unresolved(AnchorFailure)
}

enum AnchorFailure: String, Equatable {
    case textMissing        // the phrase is no longer present
    case ambiguous          // repeats that context cannot separate
}

enum TextAnchorResolver {
    /// Minimum matching context characters before a repeated phrase is trusted.
    static let minimumEvidence = 3
    /// Position may only decide when the remembered offset is still plausible…
    static let maximumDrift = 200
    /// …and one candidate is clearly nearer than the next.
    static let proximityMargin = 8

    static func resolve(_ anchor: TextAnchor, in document: String) -> AnchorResolution {
        resolve(anchor, in: Array(document.utf16))
    }

    static func resolve(_ anchor: TextAnchor, in document: [UInt16]) -> AnchorResolution {
        let needle = Array(anchor.text.utf16)
        guard !needle.isEmpty else { return .unresolved(.textMissing) }

        let occurrences = indices(of: needle, in: document)
        guard !occurrences.isEmpty else { return .unresolved(.textMissing) }
        // A single occurrence needs no disambiguation.
        if occurrences.count == 1 {
            return .resolved(occurrences[0]..<(occurrences[0] + needle.count))
        }

        let prefix = Array(anchor.prefixContext.utf16)
        let suffix = Array(anchor.suffixContext.utf16)
        let scored = occurrences.map { start -> (start: Int, score: Int) in
            let before = commonSuffixLength(prefix, document, endingAt: start)
            let after = commonPrefixLength(suffix, document, startingAt: start + needle.count)
            return (start, before + after)
        }

        let best = scored.max(by: { $0.score < $1.score })!
        let rivals = scored.filter { $0.score == best.score }

        if rivals.count == 1 && best.score >= minimumEvidence {
            return .resolved(best.start..<(best.start + needle.count))
        }

        // Context could not separate them. Position may still decide, but only
        // when the remembered offset is still plausible and one candidate is
        // clearly nearer than the next — repeats can sit a few words apart.
        let byDistance = rivals
            .map { (start: $0.start, distance: abs($0.start - anchor.approximateOffset)) }
            .sorted { $0.distance < $1.distance }
        if let closest = byDistance.first, closest.distance <= maximumDrift {
            let runnerUp = byDistance.dropFirst().first?.distance ?? Int.max
            if runnerUp - closest.distance >= proximityMargin {
                return .resolved(closest.start..<(closest.start + needle.count))
            }
        }
        return .unresolved(.ambiguous)
    }

    // MARK: Helpers

    static func indices(of needle: [UInt16], in haystack: [UInt16]) -> [Int] {
        guard !needle.isEmpty, haystack.count >= needle.count else { return [] }
        var found: [Int] = []
        for start in 0...(haystack.count - needle.count) {
            var matched = true
            for offset in 0..<needle.count where haystack[start + offset] != needle[offset] {
                matched = false
                break
            }
            if matched { found.append(start) }
        }
        return found
    }

    /// How many trailing characters of `context` match the document before `end`.
    static func commonSuffixLength(_ context: [UInt16], _ document: [UInt16], endingAt end: Int) -> Int {
        var count = 0
        while count < context.count, end - count - 1 >= 0,
              context[context.count - 1 - count] == document[end - count - 1] {
            count += 1
        }
        return count
    }

    /// How many leading characters of `context` match the document from `start`.
    static func commonPrefixLength(_ context: [UInt16], _ document: [UInt16], startingAt start: Int) -> Int {
        var count = 0
        while count < context.count, start + count < document.count,
              context[count] == document[start + count] {
            count += 1
        }
        return count
    }
}

// MARK: - The reference itself

/// How a dependency should be drawn, driven by its relationship to the source
/// rather than by the call site.
enum DependencyVisualState: String, Codable {
    case healthy        // linked and matching
    case changed        // the source value moved on
    case stale          // the source version is behind
    case missing        // the source can no longer be resolved
    case unresolved     // the phrase could not be located in the host

    var isDrawn: Bool { self != .unresolved && self != .missing }
}

struct DependencyReference: Codable, Equatable {
    let id: String
    /// The indexed object this phrase came from.
    let objectId: String
    let versionId: String?
    /// Where it was inserted.
    let hostBundleIdentifier: String
    let hostApplication: String
    /// Identity of the document/compose surface, so references never appear
    /// over an unrelated window.
    let documentContext: String
    var anchor: TextAnchor
    var state: DependencyVisualState
    /// Shown in the inspector without another round trip.
    var label: String
    var valueText: String?
    var sourcePath: String
    var sourceLocation: String
    /// Stable palette slot shared by every dependency from the same source file.
    var sourceColorSlot: Int? = nil
    let createdAt: Date
    var updatedAt: Date

    static func == (left: DependencyReference, right: DependencyReference) -> Bool { left.id == right.id }
}

/// Persistence for local references. Kept separate from resolution so the store
/// can be exercised without any host application present.
final class DependencyReferenceStore {
    private(set) var references: [DependencyReference] = []
    private let url: URL

    init(url: URL) {
        self.url = url
        load()
    }

    func add(_ reference: DependencyReference) {
        references.removeAll { $0.id == reference.id }
        references.append(reference)
        save()
    }

    func remove(id: String) {
        references.removeAll { $0.id == id }
        save()
    }

    func update(id: String, transform: (inout DependencyReference) -> Void) {
        guard let index = references.firstIndex(where: { $0.id == id }) else { return }
        transform(&references[index])
        references[index].updatedAt = Date()
        save()
    }

    /// References belonging to one host document, never any other.
    func references(forContext context: String, bundleIdentifier: String) -> [DependencyReference] {
        references.filter { $0.documentContext == context && $0.hostBundleIdentifier == bundleIdentifier }
    }

    func reference(id: String) -> DependencyReference? {
        references.first { $0.id == id }
    }

    private func load() {
        guard let data = try? Data(contentsOf: url) else { return }
        references = (try? JSONDecoder().decode([DependencyReference].self, from: data)) ?? []
    }

    private func save() {
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(references) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
