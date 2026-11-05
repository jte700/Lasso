//  The card's video preview: a player cued to the moment the quoted words
//  are said, over the lines of the transcript around them.

import Cocoa
import AVFoundation
import AVKit

final class AssistVideoPreviewView: NSView {
    /// The player's share of the preview's height; the transcript has the rest.
    private static let playerShare: CGFloat = 0.62
    private static let gap: CGFloat = 6

    private let playerView = AVPlayerView()
    private let transcript: AssistTextPreviewView
    private let hasTranscript: Bool

    init(video: AssistVideoPreview, blocks: [AssistTextBlock], accent: NSColor, marking words: [String]) {
        hasTranscript = !blocks.isEmpty
        transcript = AssistTextPreviewView(blocks: blocks, accent: accent, wraps: true, marking: words)
        super.init(frame: .zero)
        playerView.controlsStyle = .inline
        playerView.showsFullScreenToggleButton = true
        playerView.wantsLayer = true
        playerView.layer?.cornerRadius = 6
        playerView.layer?.masksToBounds = true
        let player = AVPlayer(url: video.fileURL)
        player.actionAtItemEnd = .pause
        playerView.player = player
        // Cued, not playing: the writer chooses to listen.
        player.seek(to: CMTime(seconds: video.startTime, preferredTimescale: 600),
                    toleranceBefore: .zero, toleranceAfter: .zero)
        addSubview(playerView)
        if hasTranscript { addSubview(transcript) }
    }

    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let playerHeight = !hasTranscript ? bounds.height : (bounds.height * Self.playerShare).rounded()
        playerView.frame = NSRect(x: 0, y: 0, width: bounds.width, height: playerHeight)
        transcript.frame = NSRect(x: 0, y: playerHeight + Self.gap, width: bounds.width,
                                  height: max(0, bounds.height - playerHeight - Self.gap))
    }

    /// A preview taken off the card stops playing with it.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { playerView.player?.pause() }
    }
}
