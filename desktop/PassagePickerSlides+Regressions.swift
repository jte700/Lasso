// Checks for a deck's passage picker: swiping between slides, and each slide
// keeping its highlight. Run only by the native regression harness.

import Cocoa

#if BROWSER_GEOMETRY_TEST
extension PassageSlidesBody {
    private static let regressionSlides = [
        "Timeline\nBookings failed from nine until ten",
        "Root cause\nThe label export held connections for ninety seconds",
        "Follow up\nAlert on pool use before bookings fail",
    ]

    /// Swipes through a made-up three-slide deck whose pictures are already
    /// fetched, and checks where it lands and what stays highlighted.
    static func runRegression() -> [String: Bool] {
        let (document, source) = regressionDeck()
        let body = PassageSlidesBody(document: document, source: source, highlight: .systemBlue.withAlphaComponent(0.35))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 480),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = body
        defer { window.contentView = nil }
        body.layoutSubtreeIfNeeded()
        let cited = (document.text as NSString).range(of: "label export")
        body.select(cited)
        var checks: [String: Bool] = [:]
        checks["the cited words are highlighted on their slide"] = waitFor { body.canvas.selection != nil } && body.shown == 2
        let opening = body.canvas.selection
        checks["the picker opens on its cited words"] = body.isOpeningSelection

        let citedPick = body.pick(citing: true)
        checks["the cited words are what would be inserted"] = citedPick?.body.contains("label export") == true

        body.swipe([-40, -40], lifting: false)
        checks["the slide follows the fingers up"] = body.canvas.frame.minY < -60
        body.swipe([-40], lifting: true, beginning: false)
        checks["a swipe up turns to the next slide"] = body.shown == 3
        checks["the next slide shows no highlight"] = waitFor { !body.canvas.words.isEmpty } && body.canvas.selection == nil
        checks["the cited words stay chosen on another slide"] =
            body.pick(citing: true)?.body == citedPick?.body && body.citation() == citedPick?.citation && body.isOpeningSelection

        body.swipe([-30], lifting: true)
        checks["a short swipe stays on the slide"] = body.shown == 3
        body.swipe([-200], lifting: true)
        checks["a swipe past the last slide stays on it"] = body.shown == 3
        checks["the slide goes back after a swipe past the end"] = waitFor { body.canvas.frame.minY == 0 }

        body.swipe([60, 60], lifting: true)
        checks["a swipe down turns back"] = body.shown == 2
        checks["the cited words are highlighted again on return"] =
            waitFor { body.canvas.selection != nil } && body.canvas.selection == opening && body.isOpeningSelection

        body.swipe([120], lifting: true)
        checks["a second swipe down reaches the first slide"] = body.shown == 1
        _ = waitFor { !body.canvas.words.isEmpty }
        body.canvas.onChoose?(0...1)
        checks["words chosen on another slide replace the highlight"] =
            body.chosen?.slide == 1 && body.isOpeningSelection == false && body.pick(citing: false)?.body.contains("label") == false
        body.swipe([-120], lifting: true)
        checks["the replaced highlight is gone from its slide"] = waitFor { !body.canvas.words.isEmpty } && body.canvas.selection == nil
        body.swipe([120], lifting: true)
        checks["a chosen highlight is kept on return"] = waitFor { body.canvas.selection != nil } && body.canvas.selection == 0...1

        body.swipe([-50, -50], lifting: true, sideways: 80)
        checks["a scroll that starts sideways turns nothing"] = body.shown == 1
        body.wheel(-1)
        checks["a mouse wheel notch turns a slide"] = body.shown == 2
        return checks
    }

    private static func regressionDeck() -> (PassageDocument, SlidePictureSource) {
        var text = ""
        var places: [PassagePlace] = []
        for (index, slide) in regressionSlides.enumerated() {
            let start = (text as NSString).length
            text += slide + "\n\n"
            places.append(PassagePlace(range: NSRange(location: start, length: (slide as NSString).length),
                                       kind: "slide", time: nil, number: index + 1, title: nil))
        }
        let document = PassageDocument(name: "Incident Review.pptx", kind: "slides", text: text, decorations: [],
                                       headings: [], places: places, joinsLines: false, selection: nil,
                                       unavailable: nil, truncated: false)
        let source = SlidePictureSource(serverURL: URL(string: "http://127.0.0.1:9")!,
                                        objectId: "regression-\(UUID().uuidString)", versionId: nil)
        for (index, slide) in regressionSlides.enumerated() {
            SlidePictureCache.keep(regressionPicture(slide), index + 1, of: source)
        }
        return (document, source)
    }

    /// A white slide with its lines in large black type, as PNG.
    private static func regressionPicture(_ slide: String) -> Data {
        let size = NSSize(width: 1600, height: 900)
        let image = NSImage(size: size, flipped: true) { rect in
            NSColor.white.setFill()
            rect.fill()
            var y: CGFloat = 120
            for (index, line) in slide.split(separator: "\n").enumerated() {
                let font = NSFont.systemFont(ofSize: index == 0 ? 96 : 54)
                (String(line) as NSString).draw(at: NSPoint(x: 120, y: y), withAttributes: [.font: font, .foregroundColor: NSColor.black])
                y += index == 0 ? 220 : 90
            }
            return true
        }
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else { return Data() }
        return png
    }

    /// Two fingers touching if `beginning`, moving up or down by each distance in turn, then lifting if `lifting`.
    private func swipe(_ distances: [CGFloat], lifting: Bool, beginning: Bool = true, sideways: CGFloat = 0) {
        let began = 1, changed = 2, ended = 4
        if beginning { trackpadScroll(dx: 0, dy: 0, phase: began) }
        for (index, distance) in distances.enumerated() {
            trackpadScroll(dx: index == 0 ? sideways : 0, dy: distance, phase: changed)
        }
        if lifting { trackpadScroll(dx: 0, dy: 0, phase: ended) }
    }

    private func trackpadScroll(dx: CGFloat, dy: CGFloat, phase: Int) {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                  wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { return }
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase))
        event.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: Double(dy))
        event.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: Double(dx))
        if let scroll = NSEvent(cgEvent: event) { scrollWheel(with: scroll) }
    }

    private func wheel(_ lines: Int32) {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1,
                                  wheel1: lines, wheel2: 0, wheel3: 0),
              let scroll = NSEvent(cgEvent: event) else { return }
        scrollWheel(with: scroll)
    }

    /// Runs the main loop until `done`, for at most ten seconds.
    private static func waitFor(_ done: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(10)
        while !done(), Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        return done()
    }
}
#endif
