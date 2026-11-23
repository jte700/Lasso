// What joins two files on The Ranch's Network, in words: the value one links
// from the other, the name one mentions, the name both share, or the writing
// one was suggested in, and whether that happens within one directory or
// across two. The view shows these on a hovered line or file; the short tags
// sit on the lines themselves.

import Foundation

/// One file a node connects to, and why.
struct RanchNetworkConnection: Equatable {
    /// The other node's index in the layout.
    let other: Int
    let crossesDirectories: Bool
    /// One sentence per reason, strongest kind first.
    let sentences: [String]
    /// A word or two for the line itself: "names", "\u{201C}18,400\u{201D}", "same name".
    let tag: String
}

extension RanchNetworkLayout {
    /// The lines between two nodes, of every kind but a file's tie to its directory.
    func lines(between a: Int, _ b: Int) -> [RanchNetworkLine] {
        lines.filter { $0.kind != "member" && (($0.from == a && $0.to == b) || ($0.from == b && $0.to == a)) }
    }

    /// What joins two nodes, or nil when nothing does.
    func connection(between node: Int, and other: Int) -> RanchNetworkConnection? {
        let joining = lines(between: node, other).sorted { $0.weight > $1.weight }
        guard let first = joining.first else { return nil }
        return RanchNetworkConnection(
            other: other, crossesDirectories: first.crossesDirectories,
            sentences: joining.flatMap { RanchConnectionWords.sentences(for: $0, nodes: nodes) },
            tag: joining.map(RanchConnectionWords.tag(for:)).joined(separator: " \u{00B7} "))
    }

    /// Every file a node connects to, the strongest first; none for a hub.
    func connections(of node: Int) -> [RanchNetworkConnection] {
        guard nodes.indices.contains(node), nodes[node].role == .file else { return [] }
        var strength: [Int: Double] = [:]
        for line in lines where line.kind != "member" {
            if line.from == node { strength[line.to, default: 0] += line.weight }
            if line.to == node { strength[line.from, default: 0] += line.weight }
        }
        let order = strength.keys.sorted { left, right in
            strength[left] != strength[right] ? strength[left]! > strength[right]!
                : nodes[left].label.localizedStandardCompare(nodes[right].label) == .orderedAscending
        }
        return order.compactMap { connection(between: node, and: $0) }
    }

    /// The name of the directory a node sits in, as its hub is labelled.
    func directoryName(of node: Int) -> String? {
        guard nodes.indices.contains(node) else { return nil }
        let directory = nodes[node].directoryId
        return nodes.first { $0.role == .hub && $0.directoryId == directory }?.label
    }

    /// "Across Finance and Models" or "Within Finance".
    func whereConnected(_ a: Int, _ b: Int) -> String {
        let first = directoryName(of: a), second = directoryName(of: b)
        guard let first else { return "" }
        guard let second, nodes[a].directoryId != nodes[b].directoryId else { return "Within \(first)" }
        return "Across \(first) and \(second)"
    }
}

enum RanchConnectionWords {
    private static let tagLength = 18

    /// One sentence per reason the server gave, or one for the kind alone when it gave none.
    static func sentences(for line: RanchNetworkLine, nodes: [RanchNetworkNode]) -> [String] {
        let one = nodes[line.from], two = nodes[line.to]
        guard !line.reasons.isEmpty else { return [unexplained(line.kind)] }
        return line.reasons.map { reason in
            // The file the reason starts from, and the other one.
            let starts = reason.from == one.id ? one : reason.from == two.id ? two : nil
            let other = starts == one ? two : one
            return sentence(kind: line.kind, starts: starts?.label, other: other.label, text: reason.text)
        }
    }

    private static func sentence(kind: String, starts: String?, other: String, text: String?) -> String {
        let quoted = text.map { "\u{201C}\($0)\u{201D}" }
        switch kind {
        case "link":
            guard let starts else { return quoted.map { "Linked by \($0)" } ?? unexplained(kind) }
            return "\(starts) links \(quoted ?? "a value") from \(other)"
        case "used-in":
            guard let starts else { return unexplained(kind) }
            return "\(starts) was suggested while writing \(other)"
        case "mention":
            guard let starts else { return unexplained(kind) }
            // The server keeps the name as typed, lower-cased; the file's own name reads better.
            let named = text.map { $0.caseInsensitiveCompare(other) == .orderedSame ? other : $0 } ?? other
            return "\(starts) names \(named)"
        case "same-name":
            return quoted.map { "Both are named \($0), likely one thing in two forms" } ?? unexplained(kind)
        default:
            return unexplained(kind)
        }
    }

    /// Said when the server sent no reasons, as one older than this app does.
    private static func unexplained(_ kind: String) -> String {
        switch kind {
        case "link": return "One links a value from the other"
        case "used-in": return "One was suggested while writing the other"
        case "mention": return "One names the other"
        case "same-name": return "They share a name"
        default: return "They are connected"
        }
    }

    /// A word or two drawn on the line.
    static func tag(for line: RanchNetworkLine) -> String {
        switch line.kind {
        case "link":
            guard let text = line.reasons.first?.text, !text.isEmpty else { return "linked" }
            let short = text.count > tagLength ? String(text.prefix(tagLength - 1)) + "\u{2026}" : text
            return "\u{201C}\(short)\u{201D}"
        case "used-in": return "suggested"
        case "mention": return "names"
        case "same-name": return "same name"
        default: return "connected"
        }
    }
}
