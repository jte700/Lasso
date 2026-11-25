// What a sources page counts and measures before it draws: the overview's
// figures for the whole library or one directory, where the kinds' circles
// sit, which of the table's columns fit, and which files a choice keeps.
// Plain values throughout, so all of it is checked without a window.

import Cocoa

/// What the overview's cards say about the whole library or one directory.
struct LoopLibrarySummary {
    /// The busiest files, or the newest while nothing has been used.
    var top: [LoopSource] = []
    var total = 0
    var usedCount = 0
    var totalUses = 0
    var sharedCount = 0
    /// Kinds of file, most numerous first.
    var kinds: [(kind: String, count: Int)] = []
    var changedThisWeek = 0
    var changedFiles: [LoopSource] = []
    var activeLinks = 0
    var allLinks = 0
    var driftedLinks = 0
    var expiringLinks = 0

    var anyUsed: Bool { usedCount > 0 }
    /// How many files the overview shows as bubbles.
    static let bubbles = 7
    /// How many changed files it shows as icons.
    static let changedShown = 4

    init(sources: [LoopSource], history: [LoopHistoryEntry], links: [LoopOutgoingLink], directoryId: String?,
         now: Date = Date()) {
        var counts: [String: Int] = [:]
        var busiest: [LoopSource] = []
        var newest: [LoopSource] = []
        var byID: [String: LoopSource] = [:]
        for source in sources where directoryId == nil || source.directoryId == directoryId {
            total += 1
            byID[source.id] = source
            counts[source.kind, default: 0] += 1
            let uses = source.counts.total
            if uses > 0 {
                usedCount += 1
                totalUses += uses
                Self.keep(source, in: &busiest) { $0.counts.total > $1.counts.total }
            }
            if source.activeShares > 0 { sharedCount += 1 }
            Self.keep(source, in: &newest) { ($0.modifiedAt ?? .distantPast) > ($1.modifiedAt ?? .distantPast) }
        }
        top = busiest.isEmpty ? newest : busiest
        kinds = counts.map { (kind: $0.key, count: $0.value) }.sorted { ($0.count, $1.kind) > ($1.count, $0.kind) }

        let week = now.addingTimeInterval(-7 * 24 * 3600)
        var changed: [String] = []
        for entry in history where directoryId == nil || entry.directoryId == directoryId {
            // A directory being added is not a change to its files.
            guard let at = entry.at, at >= week, entry.change != "directory-added" else { continue }
            if let id = entry.fileId {
                if !changed.contains(id) { changed.append(id) }
            } else {
                changedThisWeek += entry.fileCount ?? 0
            }
        }
        changedThisWeek += changed.count
        changedFiles = Array(changed.compactMap { byID[$0] }.prefix(Self.changedShown))

        let soon = now.addingTimeInterval(7 * 24 * 3600)
        for link in links where directoryId == nil || link.directoryId == directoryId {
            allLinks += 1
            guard link.status == "active" else { continue }
            activeLinks += 1
            if link.drifted { driftedLinks += 1 }
            if let expires = link.expiresAt, expires <= soon { expiringLinks += 1 }
        }
    }

    /// Keeps the few that come first by `before`, in order, without sorting the whole library.
    private static func keep(_ source: LoopSource, in best: inout [LoopSource], before: (LoopSource, LoopSource) -> Bool) {
        let place = best.firstIndex { before(source, $0) } ?? best.count
        guard place < bubbles else { return }
        best.insert(source, at: place)
        if best.count > bubbles { best.removeLast() }
    }

    /// 2,140 as "2.1k", for a count that has a small circle to fit in.
    static func short(_ value: Int) -> String {
        guard value >= 1000 else { return "\(value)" }
        let thousands = Double(value) / 1000
        return thousands >= 10 ? "\(Int(thousands.rounded()))k" : String(format: "%.1fk", thousands)
    }
}

/// Where circles of different sizes sit in a box without touching.
enum LoopCirclePacking {
    /// Circles sized by the square root of their counts, set out from four
    /// places in the box and nudged apart until none overlap. Where they
    /// cannot all fit at full size, all of them shrink together until they do.
    static func pack(_ counts: [Int], in box: CGSize) -> [(x: CGFloat, y: CGFloat, d: CGFloat)] {
        guard let most = counts.max(), most > 0, box.width > 20, box.height > 20 else {
            return counts.map { _ in (box.width / 2, box.height / 2, 0) }
        }
        let largest = min(box.height * 0.82, box.width * 0.47)
        let smallest = min(52, largest)
        let sizes = counts.map { smallest + (largest - smallest) * CGFloat((Double($0) / Double(most)).squareRoot()) }
        // Circles never fill much more than half of a box they are loose in.
        let area = sizes.reduce(0) { $0 + $1 * $1 * .pi / 4 }
        var scale = min(1, (0.5 * box.width * box.height / area).squareRoot())
        var circles = settle(sizes.map { $0 * scale }, in: box)
        for _ in 0..<12 where touching(circles) {
            scale *= 0.93
            circles = settle(sizes.map { $0 * scale }, in: box)
        }
        return circles
    }

    private static let gap: CGFloat = 5

    private static func settle(_ sizes: [CGFloat], in box: CGSize) -> [(x: CGFloat, y: CGFloat, d: CGFloat)] {
        let starts: [(CGFloat, CGFloat)] = [(0.27, 0.48), (0.7, 0.24), (0.8, 0.68), (0.5, 0.9)]
        var circles = sizes.enumerated().map { index, d -> (x: CGFloat, y: CGFloat, d: CGFloat) in
            let start = starts[index % starts.count]
            return (box.width * start.0, box.height * start.1, d)
        }
        for _ in 0..<120 {
            for first in circles.indices {
                for second in circles.indices where second > first {
                    let dx = circles[second].x - circles[first].x
                    let dy = circles[second].y - circles[first].y
                    let distance = max(0.01, (dx * dx + dy * dy).squareRoot())
                    let wanted = (circles[first].d + circles[second].d) / 2 + gap
                    guard distance < wanted else { continue }
                    // The larger circle gives way less.
                    let push = wanted - distance
                    let share = circles[first].d / (circles[first].d + circles[second].d)
                    circles[first].x -= dx / distance * push * (1 - share)
                    circles[first].y -= dy / distance * push * (1 - share)
                    circles[second].x += dx / distance * push * share
                    circles[second].y += dy / distance * push * share
                }
            }
            for index in circles.indices {
                let r = circles[index].d / 2
                circles[index].x = min(max(r, circles[index].x), max(r, box.width - r))
                circles[index].y = min(max(r, circles[index].y), max(r, box.height - r))
            }
        }
        return circles
    }

    private static func touching(_ circles: [(x: CGFloat, y: CGFloat, d: CGFloat)]) -> Bool {
        for first in circles.indices {
            for second in circles.indices where second > first {
                let dx = circles[second].x - circles[first].x
                let dy = circles[second].y - circles[first].y
                if (dx * dx + dy * dy).squareRoot() < (circles[first].d + circles[second].d) / 2 + gap * 0.4 { return true }
            }
        }
        return false
    }
}

/// Which of the table's columns fit the page. The file, its status and its date always show.
struct LoopTableColumns: Equatable {
    static let kindWidth: CGFloat = 108
    static let directoryWidth: CGFloat = 156
    static let statusWidth: CGFloat = 126
    static let usageWidth: CGFloat = 150
    static let whenWidth: CGFloat = 108

    let kind: Bool
    let directory: Bool
    let usage: Bool

    init(width: CGFloat, showsDirectory: Bool) {
        usage = width >= 640
        kind = width >= 540
        directory = showsDirectory && width >= 880
    }
}

/// Which of the listed files a sources page keeps.
enum LoopUseFilter: String, CaseIterable, Identifiable {
    case all, used, shared

    var id: String { rawValue }

    func keeps(_ source: LoopSource) -> Bool {
        switch self {
        case .all: return true
        case .used: return source.counts.total > 0
        case .shared: return source.activeShares > 0
        }
    }
}

/// Pausing or resuming one directory, as the opening's ticks ask.
struct LoopDirectoryChange: Equatable {
    let id: String
    let active: Bool
}

/// Which directories are ticked in the opening's directories step. Each
/// starts ticked if Lasso reads it now; untouched, nothing changes. Connected
/// apps stay ticked: they are switched on and off where they were connected.
struct LoopDirectoryTicks: Equatable {
    private(set) var ticked: Set<String> = []
    private(set) var seen: Set<String> = []

    /// Takes in directories not met before, such as one just added, ticked as they are now.
    mutating func meet(_ directories: [LoopDirectory]) {
        for directory in directories where !seen.contains(directory.id) {
            seen.insert(directory.id)
            if directory.active || directory.isApp { ticked.insert(directory.id) }
        }
    }

    func isTicked(_ directory: LoopDirectory) -> Bool { directory.isApp || ticked.contains(directory.id) }

    mutating func toggle(_ directory: LoopDirectory) {
        guard !directory.isApp else { return }
        if ticked.contains(directory.id) { ticked.remove(directory.id) } else { ticked.insert(directory.id) }
    }

    /// The directories to pause or resume so Lasso reads just the ticked ones.
    func changes(_ directories: [LoopDirectory]) -> [LoopDirectoryChange] {
        directories.filter { !$0.isApp && seen.contains($0.id) && ticked.contains($0.id) != $0.active }
            .map { LoopDirectoryChange(id: $0.id, active: ticked.contains($0.id)) }
    }

    func count(_ directories: [LoopDirectory]) -> Int { directories.filter(isTicked).count }
}

/// A moment in one of the tour's demos, which loop: everything a demo draws
/// is worked out from this, so a demo is the same at the same moment.
struct LoopDemoTime {
    enum Curve { case linear, smooth, out, back }

    /// Seconds into the loop.
    let t: Double
    let loop: Double

    /// How far through the span from `start` to `end` the moment is, 0 to 1, eased.
    func ramp(_ start: Double, _ end: Double, curve: Curve = .smooth) -> Double {
        guard end > start else { return t >= end ? 1 : 0 }
        let x = min(1, max(0, (t - start) / (end - start)))
        // Exactly 0 before and 1 after, whatever the curve's arithmetic leaves.
        if x == 0 || x == 1 { return x }
        switch curve {
        case .linear: return x
        case .smooth: return x * x * (3 - 2 * x)
        case .out: return 1 - pow(1 - x, 3)
        case .back:
            // Overshoots a little before settling, as a thing popping into place does.
            let lift = 1.70158
            return 1 + (lift + 1) * pow(x - 1, 3) + lift * pow(x - 1, 2)
        }
    }

    /// Something shown from `start` until `end`, faded in and out over `edge` seconds.
    func span(_ start: Double, _ end: Double, edge: Double = 0.2) -> Double {
        min(ramp(start, start + edge), 1 - ramp(end - edge, end))
    }

    /// A key or button held down for a moment at `at`: 1 while down, 0 otherwise.
    func press(_ at: Double, length: Double = 0.16) -> Double { span(at, at + length, edge: 0.05) }

    /// The whole demo fades in as its loop starts and out before it starts again.
    var fade: Double { min(ramp(0, 0.3), 1 - ramp(loop - 0.5, loop)) }
}

/// Where something moved by a demo is: still at each key, gliding between them.
struct LoopDemoPath {
    let keys: [(at: Double, point: CGPoint)]

    func point(_ time: LoopDemoTime) -> CGPoint {
        guard let first = keys.first, let last = keys.last else { return .zero }
        if time.t <= first.at { return first.point }
        if time.t >= last.at { return last.point }
        for (from, to) in zip(keys, keys.dropFirst()) where time.t <= to.at {
            let x = CGFloat(time.ramp(from.at, to.at))
            return CGPoint(x: from.point.x + (to.point.x - from.point.x) * x, y: from.point.y + (to.point.y - from.point.y) * x)
        }
        return last.point
    }
}

/// A spring as the motion studies write them, stiffness and damping, stepped
/// by hand each frame (their shared motion.js).
struct LoopSpring {
    var x: Double
    var v: Double = 0
    var t: Double
    var k: Double
    var c: Double

    init(_ x: Double, _ k: Double, _ c: Double) {
        self.x = x
        t = x
        self.k = k
        self.c = c
    }

    /// With Reduce Motion the spring is critically damped, so it never overshoots.
    mutating func tune(_ spring: (k: Double, c: Double), reduce: Bool = false) {
        k = spring.k
        c = reduce ? 2 * spring.k.squareRoot() : spring.c
    }

    mutating func step(_ dt: Double) {
        let a = -k * (x - t) - c * v
        v += a * dt
        x += v * dt
    }

    var settled: Bool { abs(x - t) < 0.02 && abs(v) < 0.02 }
}

/// Pull to refresh's numbers, from the motion studies' tokens.css.
enum LoopPullPhysics {
    /// --pull-threshold: points of pull that start a refresh.
    static let threshold = 88.0
    /// Where the page waits while the spinner runs.
    static let hold = 64.0
    /// --pull-hold-ms: how long the spinner runs.
    static let holdSeconds = 1.3
    /// The drop at rest: its centre just under the handle, a quarter of its size.
    static let restY = 5.0
    static let restScale = 0.25
    /// --spring-follow: held by the pointer, no overshoot, no lag.
    static let follow = (k: 900.0, c: 50.0)
    /// --pull-return: the page springing back.
    static let back = (k: 260.0, c: 18.0)
    static let drop = (k: 380.0, c: 20.0)
    static let dropScale = (k: 420.0, c: 18.0)
    static let spinner = (k: 400.0, c: 26.0)

    /// Half speed at first so the threshold is easy to reach, then real resistance.
    static func rubber(_ pulled: Double) -> Double {
        let d = max(0, pulled)
        return d <= 180 ? d * 0.55 : 99 + 60 * (1 - 1 / ((d - 180) * 0.55 / 60 + 1))
    }
}

/// The ways a whole file is shared from The Loop.
enum LoopShareWay: CaseIterable, Identifiable {
    case whole, redacted, marked

    var id: Self { self }

    var scope: ShareAccessScope {
        switch self {
        case .whole: return .document
        case .redacted: return .redacted
        case .marked: return .marked
        }
    }

    var title: String {
        switch self {
        case .whole: return "Whole file"
        case .redacted: return "Redacted"
        case .marked: return "Marked up"
        }
    }

    var detail: String {
        switch self {
        case .whole: return "They see all of it, as it is now."
        case .redacted: return "Cover what they shouldn\u{2019}t see first."
        case .marked: return "Draw and highlight on its pages first."
        }
    }

    /// What the recipient gets, in the send step.
    var promise: String {
        switch self {
        case .whole: return "They get a link to the whole file, with where it came from. Nothing else in your folders is shared."
        case .redacted: return "They get a link to the file with the parts you covered hidden, and nothing else from your folders."
        case .marked: return "They get a link to a copy of its pages with your markings drawn on, and nothing else from your folders."
        }
    }

    /// Why a file cannot be shared this way, or nil when it can.
    func unavailable(for filename: String) -> String? {
        let offered = ShareAccessScope.offered(for: ShareSourceKind(filename: filename), hasCitedPart: false,
                                               markable: ShareSourceKind.isMarkable(filename))
        guard !offered.contains(scope) else { return nil }
        switch self {
        case .whole: return "This file can\u{2019}t be shared as a link."
        case .redacted: return "There is nothing in this file to cover."
        case .marked: return "Only PDFs, Word files and slides."
        }
    }
}

/// Email addresses typed into the share dialog.
enum LoopShareAddress {
    /// Whether what was typed looks enough like an address to become a token.
    static func valid(_ text: String) -> Bool {
        text.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil
    }
}

/// The Spring Dropdown's rows without the dropdown (designbookmark.com
/// motion studies): rows that fall in one after another, a highlight that
/// stretches from row to row, its leading edge stiff and its trailing edge
/// soft, a check that draws itself on the chosen row, and a small press as a
/// row is chosen. Its springs are the component's own.
struct LoopSpringRows {
    static let enter = (k: 300.0, c: 24.0)
    static let tick = (k: 260.0, c: 26.0)
    static let lead = (k: 620.0, c: 36.0)
    static let trail = (k: 200.0, c: 20.0)
    static let fade = (k: 400.0, c: 32.0)
    static let press = (k: 500.0, c: 18.0)
    /// Rows fall in this far apart, after a short wait.
    static let stagger = 0.045
    static let firstDelay = 0.05

    let count: Int
    let row: Double
    let pad: Double
    let reduce: Bool
    private(set) var top: LoopSpring
    private(set) var bottom: LoopSpring
    private(set) var glow = LoopSpring(0, fade.k, fade.c)
    private(set) var shown: [LoopSpring]
    private(set) var ticks: [LoopSpring]
    private(set) var presses: [LoopSpring]
    private(set) var hovered: Int?

    init(count: Int, row: Double, pad: Double, reduce: Bool = false) {
        self.count = count
        self.row = row
        self.pad = pad
        self.reduce = reduce
        top = LoopSpring(pad, Self.lead.k, Self.lead.c)
        bottom = LoopSpring(pad + row, Self.lead.k, Self.lead.c)
        shown = (0..<count).map { _ in LoopSpring(0, Self.enter.k, reduce ? 2 * Self.enter.k.squareRoot() : Self.enter.c) }
        ticks = (0..<count).map { _ in LoopSpring(0, Self.tick.k, reduce ? 2 * Self.tick.k.squareRoot() : Self.tick.c) }
        presses = (0..<count).map { _ in LoopSpring(1, Self.press.k, reduce ? 2 * Self.press.k.squareRoot() : Self.press.c) }
    }

    /// When each row starts to fall in.
    static func delay(_ index: Int) -> Double { firstDelay + Double(index) * stagger }

    mutating func show(_ index: Int) { shown[index].t = 1 }

    /// Moves the highlight to a row: at once the first time, and otherwise
    /// with the edge it moves toward leading and the other trailing, so it stretches.
    mutating func hover(_ index: Int) {
        guard index != hovered, index >= 0, index < count else { return }
        let from = pad + Double(index) * row
        if hovered == nil || glow.x < 0.05 {
            top.x = from; top.t = from; top.v = 0
            bottom.x = from + row; bottom.t = from + row; bottom.v = 0
        } else {
            let down = index > (hovered ?? index)
            if down { bottom.tune(Self.lead, reduce: reduce); top.tune(Self.trail, reduce: reduce) }
            else { top.tune(Self.lead, reduce: reduce); bottom.tune(Self.trail, reduce: reduce) }
            top.t = from
            bottom.t = from + row
        }
        hovered = index
        glow.t = 1
    }

    /// Chooses a row: its check draws, the others' fade, and it gives a little under the press.
    mutating func choose(_ index: Int) {
        for i in 0..<count { ticks[i].t = i == index ? 1 : 0 }
        presses[index].x = 0.955
    }

    /// Chosen before the rows have shown, as the choice a page opens with: drawn already.
    mutating func settle(on index: Int) {
        for i in 0..<count {
            ticks[i].x = i == index ? 1 : 0
            ticks[i].t = ticks[i].x
        }
    }

    mutating func step(_ dt: Double) {
        top.step(dt); bottom.step(dt); glow.step(dt)
        for i in 0..<count { shown[i].step(dt); ticks[i].step(dt); presses[i].step(dt) }
    }

    var settled: Bool {
        top.settled && bottom.settled && glow.settled && shown.allSatisfy(\.settled) && ticks.allSatisfy(\.settled)
            && presses.allSatisfy(\.settled)
    }

    /// The highlight's top and height, kept at least a little tall and inside the panel.
    var highlight: (top: Double, height: Double) {
        let lowest = pad + Double(count) * row
        let upper = min(max(min(top.x, bottom.x - 16), pad), lowest - 16)
        let lower = min(max(bottom.x, upper + 16), lowest)
        return (upper, lower - upper)
    }
}

/// The Sources page's search, after BeUI's Chip Search: what its panel lists,
/// and how the filters in its bar (chips) are added, marked and kept.
enum LoopChipSearch {
    struct Row: Identifiable, Equatable {
        enum Kind: Equatable { case query, recent, suggestion }
        let id: String
        let label: String
        let kind: Kind
    }

    static let maxChips = 4
    static let maxRecents = 5
    static let maxSuggestions = 6

    static func same(_ a: String, _ b: String) -> Bool {
        a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == b.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func contains(_ term: String, _ query: String) -> Bool { term.lowercased().contains(query.lowercased()) }

    /// The terms offered while typing, each kept with its lower-case bytes, made
    /// once per library read: a library of tens of thousands of files is then
    /// searched in under a millisecond a keystroke, not tens of milliseconds.
    struct Terms {
        let labels: [String]
        fileprivate let keys: [[UInt8]]

        init(_ labels: [String]) {
            self.labels = labels
            keys = labels.map { Array($0.lowercased().utf8) }
        }

        static let none = Terms([])
    }

    /// Whether `needle`'s bytes sit somewhere in `haystack`'s.
    static func holds(_ haystack: [UInt8], _ needle: [UInt8]) -> Bool {
        guard let first = needle.first else { return true }
        guard haystack.count >= needle.count else { return false }
        let last = haystack.count - needle.count
        return haystack.withUnsafeBufferPointer { bytes in
            needle.withUnsafeBufferPointer { wanted in
                var at = 0
                while at <= last {
                    if bytes[at] == first {
                        var matched = 1
                        while matched < wanted.count && bytes[at + matched] == wanted[matched] { matched += 1 }
                        if matched == wanted.count { return true }
                    }
                    at += 1
                }
                return false
            }
        }
    }

    static func rows(query: String, chips: [String], recents: [String], suggestions: [String],
                     limit: Int = maxSuggestions) -> [Row] {
        rows(query: query, chips: chips, recents: recents, terms: Terms(suggestions), limit: limit)
    }

    /// With nothing typed, the recent searches. Otherwise what was typed comes
    /// first, then the recents and suggestions holding it, none twice and none
    /// that is already a chip, at most six of them.
    static func rows(query: String, chips: [String], recents: [String], terms: Terms,
                     limit: Int = maxSuggestions) -> [Row] {
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return recents.map { Row(id: "recent:" + $0, label: $0, kind: .recent) } }
        var seen = Set([typed.lowercased()] + chips.map { $0.lowercased() })
        var matches: [Row] = []
        for term in recents {
            guard matches.count < limit else { break }
            let key = term.lowercased()
            guard !seen.contains(key), contains(term, typed) else { continue }
            seen.insert(key)
            matches.append(Row(id: "recent:" + term, label: term, kind: .recent))
        }
        let needle = Array(typed.lowercased().utf8)
        for (index, key) in terms.keys.enumerated() {
            guard matches.count < limit else { break }
            guard holds(key, needle) else { continue }
            let term = terms.labels[index]
            guard seen.insert(term.lowercased()).inserted else { continue }
            matches.append(Row(id: "suggestion:" + term, label: term, kind: .suggestion))
        }
        return [Row(id: "query:" + typed, label: typed, kind: .query)] + matches
    }

    /// Where the typed words sit in a row's label, drawn heavier there.
    static func highlight(_ text: String, query: String) -> Range<String.Index>? {
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return nil }
        return text.range(of: typed, options: .caseInsensitive)
    }

    struct Added: Equatable {
        enum Outcome: Equatable { case added, existing, full, empty }
        var chips: [String]
        var recents: [String]
        let outcome: Outcome
    }

    /// A term chosen from the panel or typed and entered becomes a chip, unless
    /// it is one already or the bar holds four; it also goes to the top of the
    /// recent searches. A full bar changes nothing, so the typing stays.
    static func add(_ term: String, chips: [String], recents: [String]) -> Added {
        let value = term.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return Added(chips: chips, recents: recents, outcome: .empty) }
        let exists = chips.contains { same($0, value) }
        if !exists && chips.count >= maxChips { return Added(chips: chips, recents: recents, outcome: .full) }
        let kept = Array(([value] + recents.filter { !same($0, value) }).prefix(maxRecents))
        return Added(chips: exists ? chips : chips + [value], recents: kept, outcome: exists ? .existing : .added)
    }

    /// The chip marked for removal after ← (-1) or → (1): ← from the field
    /// marks the last chip, and → past the last one leaves the chips.
    static func step(_ marked: String?, by direction: Int, in chips: [String]) -> String? {
        guard !chips.isEmpty else { return nil }
        let at = marked.flatMap { chips.firstIndex(of: $0) } ?? chips.count
        let next = at + direction
        return next >= chips.count ? nil : chips[max(next, 0)]
    }

    /// Whether every chip is found in the file's name or folders, its directory's name or its kind.
    static func keeps(_ source: LoopSource, chips: [String], directoryName: String) -> Bool {
        chips.allSatisfy { chip in
            let needle = chip.trimmingCharacters(in: .whitespacesAndNewlines)
            return needle.isEmpty || source.path.localizedCaseInsensitiveContains(needle)
                || directoryName.localizedCaseInsensitiveContains(needle)
                || LoopKindFilter.label(for: source.kind).localizedCaseInsensitiveContains(needle)
        }
    }

    /// The terms offered while typing: the directories' names, the kinds of
    /// file there are (the most common first), then the files' names, the
    /// latest edited first. None twice, whatever its case.
    static func suggestions(sources: [LoopSource], directories: [LoopDirectory]) -> [String] {
        var kinds: [String: Int] = [:]
        for source in sources { kinds[LoopKindFilter.label(for: source.kind), default: 0] += 1 }
        let kindTerms = kinds.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map(\.key)
        let files = sources.sorted { ($0.modifiedAt ?? .distantPast) > ($1.modifiedAt ?? .distantPast) }.map(\.name)
        var seen = Set<String>()
        return (directories.map(\.name) + kindTerms + files).filter { term in
            seen.insert(term.lowercased()).inserted
        }
    }
}
