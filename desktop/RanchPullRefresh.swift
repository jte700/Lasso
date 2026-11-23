// Pull to refresh on The Ranch's sources pages, rebuilt from the motion
// studies' "Pull to Refresh" (designbookmark.com/motion#db-pull-refresh) with
// its springs, threshold and timing (RanchPullPhysics). At the top of the
// page, pulling down with two fingers (or turning a mouse wheel up) moves the
// page with rubber resistance; a drop stretches out of a handle behind it,
// the two fused like goo. Past the threshold the drop pops and becomes a
// spinner, the library is read again, and the page springs home. The line by
// the bell says what is happening, and a click on it refreshes too.

import Cocoa
import SwiftUI

/// Where everything is on one frame.
struct RanchPullFrame: Equatable {
    var offset = 0.0
    var dropY = RanchPullPhysics.restY
    var dropScale = RanchPullPhysics.restScale
    /// How far the drop stretches with its speed.
    var stretch = 1.0
    var spinner = 0.0
    var spin = 0.0
}

final class RanchPull: ObservableObject {
    enum Mode { case idle, pulling, loading, settling }

    @Published private(set) var frame = RanchPullFrame()
    @Published private(set) var mode = Mode.idle
    /// Past the threshold while pulling: letting go refreshes.
    @Published private(set) var armed = false
    /// When the last refresh finished, for "Updated just now".
    @Published private(set) var refreshed: Date?

    /// Whether the page is scrolled all the way up, where a pull can start, as
    /// SwiftUI last reported it; the scroll view itself is asked first (`scrolledToTop`).
    var atTop = true
    /// While true, as when a file is open over the page, nothing is pulled.
    var blocked = false
    /// Reads the library again, as the refresh starts.
    var onRefresh: () -> Void = {}
    /// Once the page is home again, so what arrived can come into place.
    var onLanded: () -> Void = {}
    /// The page area, for knowing which scrolls are over it.
    weak var area: NSView?

    private var page = RanchSpring(0, RanchPullPhysics.back.k, RanchPullPhysics.back.c)
    private var drop = RanchSpring(RanchPullPhysics.restY, RanchPullPhysics.drop.k, RanchPullPhysics.drop.c)
    private var dropScale = RanchSpring(RanchPullPhysics.restScale, RanchPullPhysics.dropScale.k, RanchPullPhysics.dropScale.c)
    private var spinner = RanchSpring(0, RanchPullPhysics.spinner.k, RanchPullPhysics.spinner.c)
    private var pulled = 0.0
    private var waited = 0.0
    private var spin = 0.0
    private var clock: Timer?
    private var last = CACurrentMediaTime()
    private var monitor: Any?
    /// Wheel turns have no end of their own; the pull ends when they stop.
    private var wheelEnd: DispatchWorkItem?
    /// The fling after a pull is let go is kept from scrolling the page.
    private var swallowingMomentum = false
    private let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    deinit { detach() }

    func attach() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self else { return event }
            return self.handle(event) ? nil : event
        }
    }

    func detach() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        clock?.invalidate()
        clock = nil
    }

    // MARK: Gestures

    /// Takes a scroll that pulls the page, and lets every other one through.
    private func handle(_ event: NSEvent) -> Bool {
        if swallowingMomentum, !event.momentumPhase.isEmpty {
            if event.momentumPhase == .ended || event.momentumPhase == .cancelled { swallowingMomentum = false }
            return true
        }
        swallowingMomentum = false
        let wheel = event.phase.isEmpty && event.momentumPhase.isEmpty
        let delta = event.hasPreciseScrollingDeltas ? Double(event.scrollingDeltaY) : Double(event.scrollingDeltaY) * 12
        switch mode {
        case .pulling:
            pull(by: delta)
            if wheel {
                waitForWheel()
            } else if event.phase == .ended || event.phase == .cancelled {
                letGo()
            }
            return true
        case .idle:
            guard !blocked, delta > 0, event.momentumPhase.isEmpty, scrolledToTop, over(event),
                  wheel || event.phase == .began || event.phase == .changed else { return false }
            begin()
            pull(by: delta)
            if wheel { waitForWheel() }
            return true
        case .loading, .settling:
            // A pull during a refresh is not passed on, so the page does not jump under the spinner.
            return over(event) && scrolledToTop && delta > 0
        }
    }

    /// Whether the page is scrolled all the way up, read from the scroll view
    /// itself. On newer macOS a SwiftUI scroll view stops reporting where its
    /// content sits while it scrolls, so `atTop` can stay true far down the
    /// page, and every scroll up would be taken for a pull.
    private var scrolledToTop: Bool {
        guard let scroll = area?.enclosingScrollView, let document = scroll.documentView else { return atTop }
        let clip = scroll.contentView
        if document.isFlipped { return clip.bounds.minY <= -clip.contentInsets.top + Self.topSlack }
        return clip.bounds.maxY >= document.bounds.maxY - Self.topSlack
    }

    /// How near the top, in points, still counts as the top.
    private static let topSlack: CGFloat = 0.5

    private func over(_ event: NSEvent) -> Bool {
        guard let area, let window = area.window else { return false }
        let point: NSPoint
        if event.window === window {
            point = event.locationInWindow
        } else if event.window == nil, let location = event.cgEvent?.location, let screen = NSScreen.screens.first {
            // An event made by hand carries only where it is on the screen, counted from the top.
            point = window.convertPoint(fromScreen: NSPoint(x: location.x, y: screen.frame.maxY - location.y))
        } else {
            return false
        }
        return area.convert(area.bounds, to: nil).contains(point)
    }

    private func begin() {
        mode = .pulling
        armed = false
        pulled = 0
        page.tune(RanchPullPhysics.follow, reduce: reduce)
        run()
    }

    private func pull(by delta: Double) {
        pulled = max(0, pulled + delta)
        page.t = RanchPullPhysics.rubber(pulled)
        let over = page.t >= RanchPullPhysics.threshold
        if over && !armed {
            armed = true
            // The drop gives a little pop as it is ready to let go.
            dropScale.v += 4
        } else if !over && armed {
            armed = false
        }
    }

    private func waitForWheel() {
        wheelEnd?.cancel()
        let end = DispatchWorkItem { [weak self] in self?.letGo() }
        wheelEnd = end
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28, execute: end)
    }

    private func letGo() {
        guard mode == .pulling else { return }
        wheelEnd?.cancel()
        swallowingMomentum = true
        if page.t >= RanchPullPhysics.threshold {
            refresh()
        } else {
            mode = .idle
            armed = false
            page.tune(RanchPullPhysics.back, reduce: reduce)
            page.t = 0
        }
    }

    /// Reads the library again with the spinner showing: from a pull, or from a click on the line by the bell.
    func refresh() {
        guard mode == .idle || mode == .pulling else { return }
        mode = .loading
        armed = false
        waited = 0
        page.tune(RanchPullPhysics.back, reduce: reduce)
        page.t = RanchPullPhysics.hold
        onRefresh()
        run()
    }

    // MARK: Frames

    private func run() {
        guard clock == nil else { return }
        last = CACurrentMediaTime()
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        clock = timer
    }

    private func tick() {
        let now = CACurrentMediaTime()
        let dt = min(now - last, 1.0 / 30)
        last = now
        if mode == .loading {
            waited += dt
            if waited >= RanchPullPhysics.holdSeconds { land() }
        }
        // Four small steps a frame, as the motion studies take them.
        let small = dt / 4
        for _ in 0..<4 {
            let reached = min(1, max(0, page.x / RanchPullPhysics.threshold))
            switch mode {
            case .pulling:
                drop.t = max(RanchPullPhysics.restY, page.x * 0.5)
                dropScale.t = RanchPullPhysics.restScale + (1 - RanchPullPhysics.restScale) * reached
                spinner.t = 0
            case .loading:
                drop.t = RanchPullPhysics.hold / 2
                dropScale.t = 1
                spinner.t = 1
            case .idle, .settling:
                drop.t = RanchPullPhysics.restY
                dropScale.t = RanchPullPhysics.restScale
                spinner.t = 0
            }
            page.step(small)
            drop.step(small)
            dropScale.step(small)
            spinner.step(small)
        }
        spin = (spin + dt * 360 / 0.8).truncatingRemainder(dividingBy: 360)
        frame = RanchPullFrame(offset: max(0, page.x), dropY: drop.x, dropScale: dropScale.x,
                               stretch: 1 + min(0.35, abs(drop.v) / 1600), spinner: min(1, max(0, spinner.x)), spin: spin)
        if mode == .idle && page.settled && drop.settled && dropScale.settled && spinner.settled {
            clock?.invalidate()
            clock = nil
        }
    }

    /// The refresh is done: the page springs home and what arrived comes into place.
    private func land() {
        mode = .settling
        refreshed = Date()
        page.tune(RanchPullPhysics.back, reduce: reduce)
        page.t = 0
        onLanded()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, self.mode == .settling else { return }
            self.mode = .idle
        }
    }
}

// MARK: Views

/// The page's content, moved down as far as it is pulled.
struct RanchPullOffset<Content: View>: View {
    @ObservedObject var pull: RanchPull
    @ViewBuilder var content: Content

    var body: some View {
        content.offset(y: pull.frame.offset)
    }
}

/// Behind the top of the page: the handle and the drop, fused like goo, and
/// the spinner the drop becomes.
struct RanchPullStage: View {
    @ObservedObject var pull: RanchPull
    private static let drop: CGFloat = 32

    var body: some View {
        let frame = pull.frame
        ZStack(alignment: .top) {
            Canvas { context, size in
                // Blurred together and cut at half strength, the handle and the drop melt into one shape.
                context.addFilter(.alphaThreshold(min: 0.5, color: RanchLook.ink))
                context.addFilter(.blur(radius: 7))
                context.drawLayer { layer in
                    let middle = size.width / 2
                    layer.fill(Path(roundedRect: CGRect(x: middle - 22, y: 2, width: 44, height: 6), cornerRadius: 3),
                               with: .color(.white))
                    let width = Self.drop * CGFloat(frame.dropScale / frame.stretch)
                    let height = Self.drop * CGFloat(frame.dropScale * frame.stretch)
                    layer.opacity = 1 - frame.spinner
                    layer.fill(Path(ellipseIn: CGRect(x: middle - width / 2, y: CGFloat(frame.dropY) - height / 2,
                                                      width: width, height: height)), with: .color(.white))
                }
            }
            RanchPullSpinner(angle: frame.spin)
                .frame(width: Self.drop, height: Self.drop)
                .scaleEffect(0.6 + 0.4 * frame.spinner)
                .opacity(frame.spinner)
                .offset(y: CGFloat(frame.dropY) - Self.drop / 2)
        }
        .frame(height: 120)
        .frame(maxWidth: .infinity)
        // Unseen at rest, so nothing peeks between cards or round a table's corners.
        .opacity(pull.mode == .idle && frame.offset < 0.5 ? 0 : 1)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A light disc with a quarter turn of the page's colour going round on it.
private struct RanchPullSpinner: View {
    let angle: Double

    var body: some View {
        ZStack {
            Circle().fill(RanchLook.ink)
            Circle()
                .trim(from: 0, to: 0.25)
                .stroke(RanchLook.onInk, style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
                .padding(8)
                .rotationEffect(.degrees(angle - 90))
        }
    }
}

/// The line by the bell: when the library was read, or what the pull will do.
/// A click on it refreshes.
struct RanchPullStatus: View {
    @ObservedObject var pull: RanchPull
    /// When the library was last read, if no refresh has finished since.
    let read: Date?

    var body: some View {
        Button { pull.refresh() } label: {
            RanchHover { hovering in
                HStack(spacing: 6) {
                    Image(systemName: "arrow.clockwise").font(.system(size: 10.5, weight: .semibold))
                        .opacity(hovering && pull.mode == .idle ? 1 : 0)
                    Text(text)
                        .font(RanchLook.font(12.5))
                        .contentTransition(.opacity)
                        .animation(.easeOut(duration: 0.2), value: text)
                }
                .foregroundStyle(hovering ? RanchLook.ink2 : RanchLook.ink3)
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .disabled(pull.mode == .loading || pull.mode == .settling)
        .help("Pull down at the top of the page, or click here, to read the library again")
        .accessibilityLabel(text)
        .accessibilityHint("Reads the library again")
    }

    private var text: String {
        switch pull.mode {
        case .pulling where pull.armed: return "Release to refresh"
        case .pulling: return pull.frame.offset > 8 ? "Pull to refresh" : updated
        case .loading: return "Updating\u{2026}"
        case .settling: return "Updated just now"
        case .idle: return updated
        }
    }

    private var updated: String {
        let latest = [pull.refreshed, read].compactMap { $0 }.max()
        guard let latest else { return "Pull to refresh" }
        return "Updated \(RanchFormat.ago(latest))"
    }
}

/// The page's area, so the pull knows which scrolls are over it.
struct RanchPullArea: NSViewRepresentable {
    let pull: RanchPull

    func makeNSView(context: Context) -> NSView {
        let view = RanchPullAreaView()
        pull.area = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) { pull.area = view }
}

/// Takes no clicks; it only marks where the page is.
private final class RanchPullAreaView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Reports how far the page is scrolled from its top.
struct RanchPullTopKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
