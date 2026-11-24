//  The caret of Google Docs and Slides, read off the screen.
//
//  Needs Screen Recording (asked for once, the first time it is needed) and
//  macOS 14's ScreenCaptureKit screenshots. Only the editor's page is
//  pictured, Lasso's own windows left out, and the picture is scanned for the
//  caret and dropped. A caret found is kept for a moment, so the card's
//  frequent position checks picture the page only when the text or caret
//  moved, or once a second to follow scrolling.

import Cocoa
import ScreenCaptureKit

final class GoogleEditorCaret {
    static let shared = GoogleEditorCaret()
    /// A caret found is reused this long while the text and caret are unchanged.
    static let reuseFor: TimeInterval = 1
    /// While the caret blinks off or cannot be told apart, the last one stands this long.
    static let holdFor: TimeInterval = 3
    /// Pictures taken this far apart catch the caret on in one and off in another.
    static let blinkGap: TimeInterval = 0.3
    static let extraPictures = 2
    private static let askedKey = "ScreenCaretAccessAsked"

    private struct Found {
        let element: AXUIElement
        let key: String
        let page: CGRect
        let bar: CaretBar
        let rect: CGRect
        let when: Date
    }

    private let lock = NSLock()
    private var found: Found?

    /// The caret's rectangle in Accessibility's top-left screen coordinates.
    func locate(in element: AXUIElement) -> CGRect? {
        guard let page = GoogleEditorText.pageFrame(of: element) else { return nil }
        let key = Self.caretKey(element)
        let now = Date()
        lock.lock()
        let last = found.flatMap { CFEqual($0.element, element) && $0.page == page ? $0 : nil }
        lock.unlock()
        if let last, last.key == key, now.timeIntervalSince(last.when) < Self.reuseFor { return last.rect }
        guard #available(macOS 14.0, *), Self.mayCapture() else { return nil }
        guard let result = scan(page: page, following: last?.bar) else {
            return last.flatMap { now.timeIntervalSince($0.when) < Self.holdFor ? $0.rect : nil }
        }
        let (bar, shot) = result
        let rect = CGRect(x: shot.region.minX + CGFloat(bar.x) / shot.scale,
                          y: shot.region.minY + CGFloat(bar.top) / shot.scale,
                          width: 0, height: CGFloat(bar.height) / shot.scale)
        lock.lock()
        found = Found(element: element, key: key, page: page, bar: bar, rect: rect, when: now)
        lock.unlock()
        return rect
    }

    /// One picture when the caret can be followed from last time, otherwise
    /// up to three, a fraction of a blink apart.
    @available(macOS 14.0, *)
    private func scan(page: CGRect, following last: CaretBar?) -> (caret: CaretBar, shot: ScreenShot)? {
        guard let first = ScreenShot.take(page) else { return nil }
        var frames = [ScreenCaret.bars(in: first.grid, scale: first.scale)]
        if let last, let bar = ScreenCaret.follow(frames[0], from: last, reach: Int(400 * first.scale)) {
            return (bar, first)
        }
        for _ in 0..<Self.extraPictures {
            Thread.sleep(forTimeInterval: Self.blinkGap)
            guard let next = ScreenShot.take(page), next.region == first.region else { return nil }
            frames.append(ScreenCaret.bars(in: next.grid, scale: next.scale))
            if let bar = ScreenCaret.blinking(in: frames) { return (bar, first) }
        }
        return nil
    }

    private static func caretKey(_ element: AXUIElement) -> String {
        var range = CFRange()
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
           let value, CFGetTypeID(value) == AXValueGetTypeID() {
            AXValueGetValue(value as! AXValue, .cfRange, &range)
        }
        var count: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXNumberOfCharactersAttribute as CFString, &count)
        return "\(range.location),\(range.length),\((count as? Int) ?? -1)"
    }

    /// Screen Recording is asked for once; after that the person decides in
    /// System Settings.
    private static func mayCapture() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: askedKey) else { return false }
        defaults.set(true, forKey: askedKey)
        DispatchQueue.main.async { _ = CGRequestScreenCaptureAccess() }
        return false
    }
}

/// A picture of part of one display, without Lasso's windows.
@available(macOS 14.0, *)
struct ScreenShot {
    let grid: PixelGrid
    let scale: CGFloat
    /// What was pictured, in Accessibility's top-left screen coordinates.
    let region: CGRect

    private static let wait: TimeInterval = 0.5
    private static let contentLifetime: TimeInterval = 30
    private static let lock = NSLock()
    private static var content: (value: SCShareableContent, when: Date)?

    static func take(_ area: CGRect) -> ScreenShot? {
        guard let content = shareableContent(),
              let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(area.center) })
        else { return nil }
        let bounds = CGDisplayBounds(display.displayID)
        let region = area.intersection(bounds)
        guard !region.isNull, region.width >= 1, region.height >= 1 else { return nil }
        let own = content.applications.filter { $0.processID == getpid() }
        let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
        let scale = CGFloat(filter.pointPixelScale)
        let configuration = SCStreamConfiguration()
        configuration.sourceRect = region.offsetBy(dx: -bounds.minX, dy: -bounds.minY)
        configuration.width = Int(region.width * scale)
        configuration.height = Int(region.height * scale)
        configuration.showsCursor = false
        var picture: CGImage?
        let done = DispatchSemaphore(value: 0)
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
            if let error { NSLog("Lasso could not picture the editor's caret: %@", error.localizedDescription) }
            picture = image
            done.signal()
        }
        guard done.wait(timeout: .now() + wait) == .success, let picture,
              let grid = PixelGrid(image: picture) else { return nil }
        return ScreenShot(grid: grid, scale: CGFloat(grid.width) / region.width, region: region)
    }

    private static func shareableContent() -> SCShareableContent? {
        lock.lock()
        if let content, Date().timeIntervalSince(content.when) < contentLifetime {
            lock.unlock()
            return content.value
        }
        lock.unlock()
        var fetched: SCShareableContent?
        let done = DispatchSemaphore(value: 0)
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { value, error in
            if let error { NSLog("Lasso could not list the screen's contents: %@", error.localizedDescription) }
            fetched = value
            done.signal()
        }
        guard done.wait(timeout: .now() + wait) == .success, let fetched else { return nil }
        lock.lock()
        content = (fetched, Date())
        lock.unlock()
        return fetched
    }
}

private extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }
}
