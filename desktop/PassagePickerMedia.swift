// The passage picker for a video: the player above, the transcript to
// highlight below, the player cued to the moment the highlight starts.
// A deck's picker is in PassagePickerSlides.swift.

import Cocoa
import AVFoundation
import AVKit

final class PassageVideoBody: NSView, PassagePickerBody {
    private static let gap: CGFloat = 12
    /// The player's share of the height at most; the transcript keeps the rest.
    private static let playerShare: CGFloat = 0.5

    private let document: PassageDocument
    private let playerView = AVPlayerView()
    private let transcript: PassageTextBody
    private var cuedAt: Double?
    var onSelectionChange: (() -> Void)?
    var view: NSView { self }
    override var isFlipped: Bool { true }

    init(document: PassageDocument, highlight: NSColor) {
        self.document = document
        transcript = PassageTextBody(document: document, highlight: highlight)
        super.init(frame: .zero)
        if let path = document.localPath, FileManager.default.fileExists(atPath: path) {
            let player = AVPlayer(url: URL(fileURLWithPath: path))
            player.actionAtItemEnd = .pause
            playerView.player = player
            playerView.controlsStyle = .inline
            playerView.showsFullScreenToggleButton = true
            playerView.wantsLayer = true
            playerView.layer?.cornerRadius = 12
            playerView.layer?.masksToBounds = true
            addSubview(playerView)
        }
        addSubview(transcript)
        transcript.onSelectionChange = { [weak self] in
            self?.cueToSelection()
            self?.onSelectionChange?()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        guard playerView.superview != nil else { transcript.frame = bounds; return }
        let height = min((bounds.width * 9 / 16).rounded(), (bounds.height * Self.playerShare).rounded())
        playerView.frame = NSRect(x: 0, y: 0, width: bounds.width, height: height)
        transcript.frame = NSRect(x: 0, y: height + Self.gap, width: bounds.width, height: max(0, bounds.height - height - Self.gap))
    }

    func select(_ range: NSRange?) {
        transcript.select(range)
        cueToSelection()
    }

    /// The player waits at the highlight's first word, paused; it never jumps while playing.
    private func cueToSelection() {
        guard let player = playerView.player, player.rate == 0,
              let time = document.time(of: transcript.selectedRange), time != cuedAt else { return }
        cuedAt = time
        player.seek(to: CMTime(seconds: time, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func pick(citing: Bool) -> PassagePick? { transcript.pick(citing: citing) }
    var isOpeningSelection: Bool { transcript.isOpeningSelection }
    func citation() -> String? { transcript.citation() }
    func moveSelection(forward: Bool, byLine: Bool, extending: Bool) {
        transcript.moveSelection(forward: forward, byLine: byLine, extending: extending)
    }
    func stop() { playerView.player?.pause() }
}
