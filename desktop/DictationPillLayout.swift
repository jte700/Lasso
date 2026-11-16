// The dictation pill's rules, apart from its drawing (DictationPill.swift):
// when it shows, how loud a voice reads, the waves it draws, where it sits by
// the caret, and the outline it morphs through on its way into the card.

import Foundation
import CoreGraphics
import CoreAudio

/// How loud the voice is, from 0 (silence) to 1, for the waves.
enum VoiceLevel {
    /// Quieter than this reads as silence, so a room's hum leaves the waves flat.
    static let floorDecibels: Float = -48
    /// As loud as the waves go; a raised voice fills them.
    static let ceilingDecibels: Float = -12
    /// Below 1 lifts soft speech, so the waves move when someone talks quietly.
    static let curve: Float = 0.7

    /// `rms` is the root mean square of samples between -1 and 1.
    static func normalized(rms: Float) -> CGFloat {
        guard rms.isFinite, rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        let linear = min(max((decibels - floorDecibels) / (ceilingDecibels - floorDecibels), 0), 1)
        return CGFloat(pow(linear, curve))
    }
}

/// The pill's waves: the voice's loudness over the last moment, newest on the
/// right. The meter reports in short slices, often several at once, so they
/// queue and each bar takes the loudest of its share.
struct VoiceWaveform: Equatable {
    static let barCount = 15
    /// Readings per bar: two slices of about 21 ms, so bars move on 24 times a second.
    static let slicesPerBar = 2
    /// A meter running ahead never leaves the waves more than this far behind the voice.
    static let maximumQueued = 24
    /// With no reading for a bar, the last one fades rather than dropping to nothing.
    static let fade: CGFloat = 0.8

    /// Oldest first, each from 0 to 1.
    private(set) var bars = [CGFloat](repeating: 0, count: barCount)
    private var queued: [CGFloat] = []

    mutating func hear(_ levels: [CGFloat]) {
        queued.append(contentsOf: levels.map { min(max($0, 0), 1) })
        if queued.count > Self.maximumQueued { queued.removeFirst(queued.count - Self.maximumQueued) }
    }

    /// Moves the waves on by one bar.
    mutating func advance() {
        let taken = min(Self.slicesPerBar, queued.count)
        let level = taken > 0 ? queued.prefix(taken).max() ?? 0 : (bars.last ?? 0) * Self.fade
        queued.removeFirst(taken)
        bars.removeFirst()
        bars.append(level)
    }

    mutating func reset() {
        bars = [CGFloat](repeating: 0, count: Self.barCount)
        queued = []
    }

    /// Each bar's height: a dot in silence, the full height at its loudest.
    /// The ends are a little shorter, so the waves sit in the pill as a shape.
    func heights(minimum: CGFloat, maximum: CGFloat) -> [CGFloat] {
        bars.enumerated().map { index, level in
            minimum + (maximum - minimum) * level * Self.taper(index)
        }
    }

    static func taper(_ index: Int) -> CGFloat {
        let position = (CGFloat(index) + 0.5) / CGFloat(barCount)
        return 0.55 + 0.45 * sin(.pi * position)
    }
}

/// Whether the pill shows: from a Dictation shortcut until it is pressed again,
/// Escape, or a quiet spell, and again whenever dictated words arrive. A live
/// microphone alone is not dictation (a call is not), so it never starts one.
struct DictationPillSession: Equatable {
    /// Through a pause to think, after the last dictated words.
    static let afterWords: TimeInterval = 12
    /// After the shortcut, before any words: time to start speaking.
    static let beforeWords: TimeInterval = 10
    /// Dictation can stay on through a silence longer than the pill waits,
    /// so the shortcut this soon after the last words ends it rather than
    /// starting it again, even with the pill gone.
    static let dictationMemory: TimeInterval = 60
    /// The 🎤 key arrives twice for one press; presses this close are one.
    static let samePress: TimeInterval = 0.5
    /// Dictation writes its last words as it stops; they do not bring the pill back.
    static let afterStop: TimeInterval = 4

    private(set) var since: Date?
    private var lastWords: Date?
    private var lastPress = Date.distantPast
    private var stoppedAt = Date.distantPast

    /// When the pill goes if nothing more happens, or nil while it is not showing.
    var endsAt: Date? {
        guard let since else { return nil }
        return lastWords.map { $0.addingTimeInterval(Self.afterWords) } ?? since.addingTimeInterval(Self.beforeWords)
    }

    func isOn(at now: Date) -> Bool { endsAt.map { now < $0 } ?? false }

    /// The shortcut starts dictation, or stops it while it may still be on.
    mutating func shortcutPressed(at now: Date) {
        guard now.timeIntervalSince(lastPress) >= Self.samePress else { return }
        lastPress = now
        let lastHeard = lastWords ?? since
        if isOn(at: now) || lastHeard.map({ now.timeIntervalSince($0) < Self.dictationMemory }) == true {
            stop(at: now)
        } else {
            since = now
            lastWords = nil
        }
    }

    /// Words arrived that nobody typed while the dictation watch was listening.
    /// They keep the pill up, or bring it back after a pause, only in a
    /// dictation the 🎤 key started; on their own they never show it.
    mutating func wordsArrived(at now: Date) {
        guard now.timeIntervalSince(stoppedAt) >= Self.afterStop,
              let lastHeard = lastWords ?? since,
              now.timeIntervalSince(lastHeard) < Self.dictationMemory else { return }
        lastWords = now
    }

    /// Escape, the shortcut pressed again, or another app coming forward.
    mutating func stop(at now: Date) {
        since = nil
        lastWords = nil
        stoppedAt = now
    }
}

/// Where the pill sits: just under the caret line, beside the blue
/// microphone macOS Dictation draws there, with the microphone on its left.
/// That microphone is drawn inside the writer's app, where no other app can
/// turn it off or ask where it is; its place was measured from the screen.
/// Without room under the line the pill sits above. AppKit coordinates.
enum DictationPillPlacement {
    static let gap: CGFloat = 4
    /// macOS's microphone: 30 points wide, centred on the caret, its top 5
    /// points under the line and its middle about 17.
    static let microphoneHalfWidth: CGFloat = 15
    /// The pill's top, this far under the line, so it sits level with the microphone.
    static let underLine: CGFloat = 1
    /// From the caret to the pill's leading edge: past the microphone and a little space.
    static let leadIn: CGFloat = microphoneHalfWidth + 6
    /// While words arrive the pill keeps about a word ahead, so the
    /// microphone, which macOS moves at once with each word, lands in the
    /// space rather than under the pill as it catches up.
    static let longestLead: CGFloat = 72
    /// Moves of the caret shorter than this are not a word.
    static let shortestWord: CGFloat = 8

    /// How far ahead to keep while the caret steps from `previous` to `caret`:
    /// a word's width along the line, kept through steps too short to be a
    /// word, and none on a new line or going back.
    static func lead(from previous: CGRect?, to caret: CGRect, keeping lead: CGFloat) -> CGFloat {
        guard let previous, abs(previous.midY - caret.midY) < 4 else { return 0 }
        let step = caret.midX - previous.midX
        if step < 0 { return 0 }
        return step < shortestWord ? lead : min(step, longestLead)
    }

    /// The pill's own frame, not its panel's, `lead` ahead of the microphone.
    static func frame(caret: CGRect, size: CGSize, visible: CGRect?, lead: CGFloat = 0) -> CGRect {
        var x = caret.midX + leadIn + lead
        var y = caret.minY - underLine - size.height
        if let visible {
            if y < visible.minY { y = caret.maxY + gap }
            // At the right edge it sits before the microphone instead.
            if x + size.width > visible.maxX { x = caret.midX - leadIn - size.width }
            x = min(max(visible.minX, x), visible.maxX - size.width)
            y = min(max(visible.minY, y), visible.maxY - size.height)
        }
        return CGRect(x: x, y: y, width: size.width, height: size.height)
    }
}

/// Which microphone the waves listen through. A Bluetooth headset works
/// differently once a second app opens its microphone, and Dictation
/// starting at that moment hears nothing, so a headset is never used: the
/// Mac's own microphone, or a wired one that is the input.
struct MeterInput: Equatable {
    let uid: String
    let transport: UInt32

    /// Wireless microphones: Bluetooth, Bluetooth LE, AirPlay and an iPhone's.
    static let wireless: Set<UInt32> = [kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE,
                                        kAudioDeviceTransportTypeAirPlay, kAudioDeviceTransportTypeContinuityCaptureWireless]

    static func choose(_ inputs: [MeterInput], defaultInput: String?) -> String? {
        if let builtIn = inputs.first(where: { $0.transport == kAudioDeviceTransportTypeBuiltIn }) { return builtIn.uid }
        guard let defaultInput, let input = inputs.first(where: { $0.uid == defaultInput }),
              !wireless.contains(input.transport) else { return nil }
        return input.uid
    }
}

/// The glass outline the pill and the card share: a rounded body with the
/// card's arrow, which a pill holds flat. Inside the morph's panel, with the
/// origin at its top-left as SwiftUI draws.
struct DictationOutline: Equatable {
    var rect: CGRect
    var cornerRadius: CGFloat
    var pointerHeight: CGFloat
    var pointerWidth: CGFloat
    /// From the outline's leading edge.
    var pointerX: CGFloat
    var pointerAtTop: Bool

    /// A capsule with its flat arrow under `caretX`, on the side facing the caret.
    static func pill(_ rect: CGRect, caretX: CGFloat, pointerAtTop: Bool) -> DictationOutline {
        DictationOutline(rect: rect, cornerRadius: rect.height / 2, pointerHeight: 0, pointerWidth: 0,
                         pointerX: caretX - rect.minX, pointerAtTop: pointerAtTop)
    }

    /// A circle at the pill's centre, which it grows out of and shrinks back into.
    static func seed(of pill: DictationOutline) -> DictationOutline {
        let side = pill.rect.height
        var seed = pill
        seed.rect = CGRect(x: pill.rect.midX - side / 2, y: pill.rect.minY, width: side, height: side)
        seed.cornerRadius = side / 2
        seed.pointerX = side / 2
        return seed
    }

    /// The way from `from` to `to` at `progress`, which a spring carries a
    /// little past 1 and back. Nothing goes below zero on the way.
    static func between(_ from: DictationOutline, _ to: DictationOutline, progress: CGFloat) -> DictationOutline {
        func mix(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * progress }
        return DictationOutline(
            rect: CGRect(x: mix(from.rect.minX, to.rect.minX), y: mix(from.rect.minY, to.rect.minY),
                         width: max(1, mix(from.rect.width, to.rect.width)),
                         height: max(1, mix(from.rect.height, to.rect.height))),
            cornerRadius: max(0, mix(from.cornerRadius, to.cornerRadius)),
            pointerHeight: max(0, mix(from.pointerHeight, to.pointerHeight)),
            pointerWidth: max(0, mix(from.pointerWidth, to.pointerWidth)),
            pointerX: mix(from.pointerX, to.pointerX),
            pointerAtTop: to.pointerAtTop)
    }
}

/// The panel a morph plays in: room for where it starts and ends, and for a
/// shadow around both, with AppKit rectangles turned into its own top-left ones.
struct DictationMorphCanvas: Equatable {
    /// AppKit coordinates.
    let frame: CGRect

    static func covering(_ rects: [CGRect], margin: CGFloat) -> DictationMorphCanvas {
        let union = rects.dropFirst().reduce(rects.first ?? .zero) { $0.union($1) }
        return DictationMorphCanvas(frame: union.insetBy(dx: -margin, dy: -margin).integral)
    }

    func local(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX - frame.minX, y: frame.maxY - rect.maxY, width: rect.width, height: rect.height)
    }

    /// The other way: a rectangle in the panel back on the screen.
    func appKit(_ rect: CGRect) -> CGRect {
        CGRect(x: frame.minX + rect.minX, y: frame.maxY - rect.maxY, width: rect.width, height: rect.height)
    }
}

/// An opacity on its way from one value to another over a stretch of a morph,
/// easing out as it lands.
struct DictationFade: Equatable {
    var from: Double
    var to: Double
    var delay: Double
    var duration: Double

    static func hold(_ value: Double) -> DictationFade {
        DictationFade(from: value, to: value, delay: 0, duration: 0)
    }

    func value(at elapsed: Double) -> Double {
        let progress = duration <= 0 ? (elapsed >= delay ? 1 : 0) : min(max((elapsed - delay) / duration, 0), 1)
        return from + (to - from) * (1 - pow(1 - progress, 3))
    }

    func isDone(at elapsed: Double) -> Bool { elapsed >= delay + duration }
}
