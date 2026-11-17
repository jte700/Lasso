// How the thinking line an AI writer's pill shows moves, and what it says. The motion is Kokonut UI's "AI Text Loading" (MIT licence,
// kokonutui.com/docs/ai/ai-text-loading), rebuilt for AppKit with its timing:
// a line's letters rise into place out of a blur one after another, a soft
// wave of dimming then runs through them left to right, and a line that is
// replaced drops out upward. Its demo words are replaced by what the writer
// is really doing. Everything here is a function of time, so it can be
// checked without drawing (WriterPill.swift draws it).

import CoreGraphics
import Foundation

/// A CSS cubic-bezier timing curve: progress in, eased progress out.
struct CubicBezier {
    let x1: Double, y1: Double, x2: Double, y2: Double

    init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
        self.x1 = x1; self.y1 = y1; self.x2 = x2; self.y2 = y2
    }

    func callAsFunction(_ x: Double) -> Double {
        if x <= 0 { return 0 }
        if x >= 1 { return 1 }
        // The curve's parameter at `x`: Newton's method, then halving if it stalls.
        var t = x
        for _ in 0..<8 {
            let error = Self.sample(x1, x2, t) - x
            if abs(error) < 1e-7 { return Self.sample(y1, y2, t) }
            let slope = Self.slope(x1, x2, t)
            if abs(slope) < 1e-6 { break }
            t -= error / slope
        }
        var low = 0.0, high = 1.0
        t = x
        for _ in 0..<40 {
            let value = Self.sample(x1, x2, t)
            if abs(value - x) < 1e-7 { break }
            if value < x { low = t } else { high = t }
            t = (low + high) / 2
        }
        return Self.sample(y1, y2, t)
    }

    private static func sample(_ a: Double, _ b: Double, _ t: Double) -> Double {
        let u = 1 - t
        return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
    }

    private static func slope(_ a: Double, _ b: Double, _ t: Double) -> Double {
        let u = 1 - t
        return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b)
    }
}

enum ThinkingMotion {
    /// Kokonut's ease-out, for letters rising in and a line leaving.
    static let easeOut = CubicBezier(0.23, 1, 0.32, 1)
    /// CSS ease-in-out, for the wave.
    static let easeInOut = CubicBezier(0.42, 0, 0.58, 1)
    static let letterRise: TimeInterval = 0.28
    static let letterStagger: TimeInterval = 0.018
    static let exitTime: TimeInterval = 0.15
    static let wavePeriod: TimeInterval = 1.6
    static let waveStep: TimeInterval = 0.07
    /// How dim a letter gets at the bottom of the wave.
    static let waveLow = 0.3
    /// The least time a line shows before another replaces it.
    static let interval: TimeInterval = 1.5
    /// Kokonut draws its words at 30 points; distances and blurs scale with the host's size from there.
    static let designSize: CGFloat = 30

    struct LetterState: Equatable {
        var opacity: Double
        var offset: CGFloat
        var blur: CGFloat
    }

    static func scale(forFontSize size: CGFloat) -> CGFloat { size / designSize }

    /// Letter `index` of a line that began `elapsed` seconds ago, rising in.
    /// With Reduce Motion it only fades in.
    static func entering(letter index: Int, elapsed: TimeInterval, scale: CGFloat, reduceMotion: Bool) -> LetterState {
        let progress = easeOut(min(1, max(0, (elapsed - Double(index) * letterStagger) / letterRise)))
        guard !reduceMotion else { return LetterState(opacity: progress, offset: 0, blur: 0) }
        let rest = CGFloat(1 - progress)
        return LetterState(opacity: progress, offset: 8 * scale * rest, blur: 4 * scale * rest)
    }

    /// A line replaced `elapsed` seconds ago, on its way out: upward, blurring, fading.
    static func leaving(elapsed: TimeInterval, scale: CGFloat, reduceMotion: Bool) -> LetterState {
        let progress = easeOut(min(1, max(0, elapsed / exitTime)))
        guard !reduceMotion else { return LetterState(opacity: 1 - progress, offset: 0, blur: 0) }
        return LetterState(opacity: 1 - progress, offset: -6 * scale * CGFloat(progress), blur: 3 * scale * CGFloat(progress))
    }

    /// How bright letter `index` is in the wave, `time` seconds after its line
    /// began: full, dimming to 0.3 halfway through each 1.6 second cycle, each
    /// letter 0.07 seconds behind the one before. Reduce Motion holds it still.
    static func wave(letter index: Int, time: TimeInterval, reduceMotion: Bool) -> Double {
        guard !reduceMotion else { return 1 }
        let local = time - Double(index) * waveStep
        guard local > 0 else { return 1 }
        let phase = local.truncatingRemainder(dividingBy: wavePeriod) / wavePeriod
        if phase < 0.5 { return 1 - (1 - waveLow) * easeInOut(phase * 2) }
        return waveLow + (1 - waveLow) * easeInOut((phase - 0.5) * 2)
    }
}

/// What the thinking line says, in turn. It starts at "Thinking…". Each
/// lookup the writer makes is shown for at least the component's interval,
/// one at a time; once the last has had its time, the line moves on to
/// "Drafting…", which is what the writer does with what it found.
struct ThinkingLines {
    static let first = "Thinking…"
    static let afterLookups = "Drafting…"

    private(set) var shown = ThinkingLines.first
    private(set) var shownAt: TimeInterval
    private var waiting: [String] = []
    private var showsLookup = false

    init(at now: TimeInterval) {
        shownAt = now
    }

    /// The writer began a lookup. Says whether the line changed at once; otherwise it waits its turn.
    mutating func lookup(_ line: String, at now: TimeInterval) -> Bool {
        guard line != shown || !showsLookup, line != waiting.last else { return false }
        waiting.append(line)
        return advance(at: now)
    }

    /// The line to show at `now`. Says whether it changed.
    mutating func advance(at now: TimeInterval) -> Bool {
        guard now - shownAt >= ThinkingMotion.interval else { return false }
        if !waiting.isEmpty {
            show(waiting.removeFirst(), lookup: true, at: now)
            return true
        }
        guard showsLookup else { return false }
        show(Self.afterLookups, lookup: false, at: now)
        return true
    }

    private mutating func show(_ line: String, lookup: Bool, at now: TimeInterval) {
        shown = line
        shownAt = now
        showsLookup = lookup
    }

    /// The words for a lookup the server reported: "searching" with the
    /// queries asked, or "reading" with the file opened.
    static func line(status: String, detail: String) -> String {
        if status == "reading" {
            let name = (detail as NSString).lastPathComponent
            return name.isEmpty ? "Reading your files…" : "Reading \(clipped(name, to: 32))…"
        }
        let query = detail.components(separatedBy: ", ").first?.trimmingCharacters(in: .whitespaces) ?? ""
        return query.isEmpty ? "Searching your files…" : "Searching for “\(clipped(query, to: 28))”…"
    }

    private static func clipped(_ text: String, to length: Int) -> String {
        text.count > length ? String(text.prefix(length - 1)) + "…" : text
    }
}
