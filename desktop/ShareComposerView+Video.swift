// A shared video in the composer: the player cued to the cited moment, over its
// transcript, as the recipient's page opens it.

import Cocoa

extension ShareComposerView {
    /// When the recipient's player starts, once the preview has said.
    var videoSubtitle: String {
        guard let video = preview?.video else { return "Complete \(filename)" }
        return "Opens at \(AssistVideoTime.label(video.startTime)) for the recipient"
    }

    func drawVideo(in rect: NSRect) {
        guard let video = preview?.video else {
            drawCentered(isLoading ? "Loading video…" : "Video preview unavailable", in: rect)
            return
        }
        if videoView?.video != video {
            videoView?.view.removeFromSuperview()
            let view = AssistVideoPreviewView(video: video, blocks: preview?.textBlocks ?? [],
                                              accent: highlightColor, marking: [])
            addSubview(view)
            videoView = (view, video)
        }
        videoView?.view.frame = rect
        showsVideoPreview = true
    }

    /// A player that is no longer shown stops, so it never plays out of sight.
    func showVideoView(_ shown: Bool) {
        guard let view = videoView?.view else { return }
        if !shown { view.pause() }
        view.isHidden = !shown
    }
}
