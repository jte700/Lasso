// Ghost text: the rest of the highlighted suggestion, written dim right after
// the caret in the field's own font, as the Ghost Suggestion component offers
// its words (designbookmark.com/motion#db-ghost-suggestion). The letters fade
// in from left to right and a Tab key pops in beside them; Tab turns each
// letter bright with a small hop, left to right, as the key goes. The springs
// and timing are the component's own, from its ghost.js, stepped as its
// motion.js steps them. Pure state and layout, so the overlay draws it and the
// checks run it; GhostTextOverlay.swift puts it over the field.

import CoreGraphics
import Foundation

enum GhostMotion {
    /// A letter fading in: ghost.js `S(0, 300, 30)`.
    static let letter = (stiffness: 300.0, damping: 30.0)
    /// A letter's hop when Tab takes it: ghost.js `S(0, 520, 16)`.
    static let hop = (stiffness: 520.0, damping: 16.0)
    /// The Tab key popping in and dropping away: ghost.js `S(0, 520, 24)`.
    static let tabKey = (stiffness: 520.0, damping: 24.0)
    /// Seconds between one letter fading in and the next.
    static let offerStagger = 0.008
    /// Seconds between one letter brightening and the next.
    static let acceptStagger = 0.016
    /// Each letter's hop starts upward at this speed, in points a second.
    static let hopVelocity = -70.0
    /// The Tab key's push downward as it goes.
    static let keyDropVelocity = -9.0
    /// Seconds a letter takes to turn bright, on the CSS `ease` curve.
    static let brighten = 0.18
    /// Each frame's step is cut into this many slices, as motion.js does.
    static let substeps = 4
    /// The longest step one frame takes, so a late frame does not jump ahead.
    static let longestFrame = 1.0 / 30
    /// How close a spring must be to rest, and still, before it counts as resting.
    static let rest = 0.001
}

enum GhostLayout {
    /// What Tab would add after the caret: the planned text past the typed
    /// letters it keeps. Nil when Tab would rewrite what was typed into
    /// something else, which writing after the caret cannot show, or would add nothing.
    static func remainder(of plan: CompletionPlan) -> String? {
        let insert = Array(plan.insertText.utf16)
        let kept = Array(plan.expectedPrefix.utf16)
        guard kept.count == plan.range.count, insert.count > kept.count else { return nil }
        let start = String(decoding: insert[..<kept.count], as: UTF16.self)
        guard start.caseInsensitiveCompare(plan.expectedPrefix) == .orderedSame else { return nil }
        return String(decoding: insert[kept.count...], as: UTF16.self)
    }

    /// The ghost as it fits in `width`: up to the end of its line, and cut
    /// after the last whole word that fits, with an ellipsis. Nil when not
    /// one word fits.
    static func fit(_ text: String, width: CGFloat, measure: (String) -> CGFloat) -> String? {
        let line = String(text.prefix { !$0.isNewline })
        guard line.contains(where: { !$0.isWhitespace }) else { return nil }
        if line.count == text.count, measure(line) <= width { return line }
        var shown = ""
        for word in ReferenceChipLayout.words(line) {
            let next = (shown + word).trimmingTrailingSpaces
            if next.contains(where: { !$0.isWhitespace }), measure(next + "\u{2026}") > width { break }
            shown += word
        }
        let ending = shown.trimmingTrailingSpaces
        guard ending.contains(where: { !$0.isWhitespace }) else { return nil }
        return ending + "\u{2026}"
    }
}

private extension String {
    var trimmingTrailingSpaces: String {
        var text = self
        while text.last == " " { text.removeLast() }
        return text
    }
}

/// The ghost's letters and Tab key from the moment they are offered.
struct GhostLetters {
    /// The Tab key's look, as ghost.js renders it.
    struct KeyFace: Equatable {
        let opacity: Double
        let scale: Double
    }

    private struct Letter {
        var shown: IslandSpring
        var hop: IslandSpring
        var offered = false
        var acceptedAt: Double?
    }

    let text: String
    private var letters: [Letter]
    private var key: IslandSpring
    private var clock = 0.0
    private var acceptedAt: Double?

    /// `keyPops` when the ghost appears from nothing; another suggestion's
    /// ghost takes the place of one already shown beside a Tab key already there.
    init(text: String, keyPops: Bool, reduceMotion: Bool = false) {
        func spring(_ value: Double, _ motion: (stiffness: Double, damping: Double)) -> IslandSpring {
            var spring = IslandSpring(value, stiffness: motion.stiffness, damping: motion.damping)
            spring.tune(stiffness: motion.stiffness, damping: motion.damping, reduceMotion: reduceMotion)
            return spring
        }
        self.text = text
        letters = text.map { _ in Letter(shown: spring(0, GhostMotion.letter), hop: spring(0, GhostMotion.hop)) }
        key = spring(keyPops ? 0 : 1, GhostMotion.tabKey)
        key.t = 1
    }

    var count: Int { letters.count }
    var isAccepted: Bool { acceptedAt != nil }

    /// Tab took the suggestion: the letters brighten and hop, and the key goes.
    mutating func accept() {
        guard acceptedAt == nil else { return }
        acceptedAt = clock
        key.v = GhostMotion.keyDropVelocity
        key.t = 0
    }

    /// One frame. Each letter starts a stagger after the one before it.
    mutating func advance(by frame: Double) {
        let dt = min(max(frame, 0), GhostMotion.longestFrame)
        clock += dt
        for index in letters.indices {
            if acceptedAt == nil, !letters[index].offered, clock >= Double(index) * GhostMotion.offerStagger {
                letters[index].offered = true
                letters[index].shown.t = 1
            }
            if let acceptedAt, letters[index].acceptedAt == nil,
               clock >= acceptedAt + Double(index) * GhostMotion.acceptStagger {
                letters[index].acceptedAt = clock
                letters[index].hop.v = GhostMotion.hopVelocity
                letters[index].shown.t = 1
            }
        }
        let slice = dt / Double(GhostMotion.substeps)
        for _ in 0..<GhostMotion.substeps {
            for index in letters.indices {
                letters[index].shown.step(slice)
                letters[index].hop.step(slice)
            }
            key.step(slice)
        }
        // A spring at rest sits exactly where it was going, so nothing is drawn a hair off.
        for index in letters.indices {
            if letters[index].shown.isSettled(within: GhostMotion.rest) { letters[index].shown.snap() }
            if letters[index].hop.isSettled(within: GhostMotion.rest) { letters[index].hop.snap() }
        }
        if key.isSettled(within: GhostMotion.rest) { key.snap() }
    }

    /// How much of a letter shows, from 0 to 1.
    func opacity(at index: Int) -> Double {
        guard letters.indices.contains(index) else { return 0 }
        return min(max(letters[index].shown.x, 0), 1)
    }

    /// How far a letter has hopped above its line, in points.
    func lift(at index: Int) -> Double {
        guard letters.indices.contains(index) else { return 0 }
        return -letters[index].hop.x
    }

    /// How far a letter has turned from the ghost's colour to the field's, from 0 to 1.
    func brightness(at index: Int) -> Double {
        guard letters.indices.contains(index), let at = letters[index].acceptedAt else { return 0 }
        let progress = (clock - at) / GhostMotion.brighten
        return progress >= 1 ? 1 : IslandCurve.ease(progress)
    }

    var keyFace: KeyFace {
        let t = min(max(key.x, -0.2), 1.2)
        return KeyFace(opacity: min(max(t, 0), 1), scale: 0.6 + 0.4 * min(max(t, 0), 1.2))
    }

    var isMoving: Bool {
        if !key.isSettled(within: GhostMotion.rest) { return true }
        return letters.indices.contains { index in
            let letter = letters[index]
            if acceptedAt == nil, !letter.offered { return true }
            if acceptedAt != nil, letter.acceptedAt == nil { return true }
            if letter.acceptedAt != nil, brightness(at: index) < 1 { return true }
            return !letter.shown.isSettled(within: GhostMotion.rest) || !letter.hop.isSettled(within: GhostMotion.rest)
        }
    }

    /// Tab's motion is over: the field's own letters can show.
    var hasLanded: Bool { acceptedAt != nil && !isMoving }
}
