import Cocoa

/// A scroll view on the card's glass: transparent, with a slim scroller that
/// stays shown while there is more to see, whatever the system's scroll bar
/// setting (an overlay scroller fades away). The suggestion list and every
/// preview scroll in one.
class AssistSlimScrollView: NSScrollView {
    init(vertical: Bool = true, horizontal: Bool = false) {
        super.init(frame: .zero)
        drawsBackground = false
        contentView.drawsBackground = false
        hasVerticalScroller = vertical
        hasHorizontalScroller = horizontal
        autohidesScrollers = true
        if vertical { verticalScroller = AssistListScroller() }
        if horizontal { horizontalScroller = AssistListScroller() }
        horizontalScrollElasticity = horizontal ? .automatic : .none
        super.scrollerStyle = .legacy
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var scrollerStyle: NSScroller.Style {
        get { .legacy }
        set { super.scrollerStyle = .legacy }
    }
}

/// The suggestion card's rows in a scroll view that only the card moves: ↑
/// and ↓ glide it to the highlighted row instead of jumping a row at a time.
/// Two fingers and a wheel leave it where it is, and its scroller only
/// shows where the list is.
final class AssistSuggestionScrollView: AssistSlimScrollView {
    /// When the list's current glide ends.
    private var glideEnds = Date.distantPast

    var isGliding: Bool { Date() < glideEnds }

    init() {
        super.init(vertical: true)
        verticalScrollElasticity = .none
        (verticalScroller as? AssistListScroller)?.showsPositionOnly = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The person's scrolling does not move the list; ↑ and ↓ do.
    override func scrollWheel(with event: NSEvent) {}

    /// Scrolls the rows to `origin`, gliding there over `glideDuration`, or at
    /// once when it is nil, which also stops a glide under way.
    func scroll(to origin: NSPoint, glideDuration: TimeInterval?) {
        let clip = contentView
        glideEnds = glideDuration.map { Date().addingTimeInterval($0) } ?? .distantPast
        NSAnimationContext.runAnimationGroup { context in
            // At once, it goes through the animator too, so it replaces a glide under way.
            context.duration = glideDuration ?? 0
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            clip.animator().setBoundsOrigin(origin)
        }
        reflectScrolledClipView(clip)
    }
}

/// A slim knob with no track, light enough to sit on the card's glass.
final class AssistListScroller: NSScroller {
    static let width: CGFloat = 10
    private static let knobInset = NSSize(width: 3, height: 3)
    /// Shows where the content is without taking clicks or drags.
    var showsPositionOnly = false

    override func hitTest(_ point: NSPoint) -> NSView? { showsPositionOnly ? nil : super.hitTest(point) }

    override class func scrollerWidth(for controlSize: NSControl.ControlSize,
                                      scrollerStyle: NSScroller.Style) -> CGFloat { width }

    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) { drawKnob() }
    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}

    override func drawKnob() {
        let knob = rect(for: .knob).insetBy(dx: Self.knobInset.width, dy: Self.knobInset.height)
        guard knob.height > 0, knob.width > 0 else { return }
        // Across the knob's narrow side, whichever way the scroller runs.
        let radius = min(knob.width, knob.height) / 2
        NSColor.tertiaryLabelColor.setFill()
        NSBezierPath(roundedRect: knob, xRadius: radius, yRadius: radius).fill()
    }
}

/// Content the card draws inside a scroll view, such as the suggestion rows
/// or a table's rows, so it matches the rest of the card.
final class AssistDrawnView: NSView {
    var drawContent: ((NSRect) -> Void)?
    /// A click, in this view's coordinates.
    var onClick: ((NSPoint) -> Void)?

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) { drawContent?(dirtyRect) }

    override func mouseDown(with event: NSEvent) {
        guard let onClick else { return super.mouseDown(with: event) }
        onClick(convert(event.locationInWindow, from: nil))
    }
}

/// Where the rows sit in the scroll view: which are in view, and where the
/// list must scroll to bring one into view. Pure geometry, so the card and
/// its checks share it.
struct AssistSuggestionListGeometry {
    let rowCount: Int
    let rowHeight: CGFloat
    /// The highlight's inset from the top of its row, and its height.
    let surfaceTop: CGFloat
    let surfaceHeight: CGFloat
    /// Space under the last row.
    let bottomPadding: CGFloat
    /// Height of the part of the list in view.
    let visibleHeight: CGFloat

    var contentHeight: CGFloat { CGFloat(rowCount) * rowHeight + bottomPadding }
    var maximumOffset: CGFloat { max(0, contentHeight - visibleHeight) }

    /// True when row `index`'s highlight is wholly in view at `offset`.
    func isInView(_ index: Int, at offset: CGFloat) -> Bool {
        let top = CGFloat(index) * rowHeight + surfaceTop
        return top >= offset - 0.5 && top + surfaceHeight <= offset + visibleHeight + 0.5
    }

    /// The rows wholly in view at `offset`.
    func rowsInView(at offset: CGFloat) -> Range<Int> {
        let indexes = (0..<rowCount).filter { isInView($0, at: offset) }
        guard let first = indexes.first, let last = indexes.last else { return 0..<0 }
        return first..<(last + 1)
    }

    /// The offset that brings row `index` into view from `offset`, moving the
    /// list as little as it can; `offset` itself when the row is in view.
    func offset(revealing index: Int, from offset: CGFloat) -> CGFloat {
        guard rowCount > 0 else { return 0 }
        let current = min(max(0, offset), maximumOffset)
        guard !isInView(index, at: current) else { return current }
        let top = CGFloat(index) * rowHeight
        let bottom = top + rowHeight + bottomPadding
        let target = top < current ? top : bottom - visibleHeight
        return min(max(0, target), maximumOffset)
    }
}
