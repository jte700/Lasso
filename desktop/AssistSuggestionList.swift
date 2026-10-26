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

/// The suggestion card's rows in a scroll view. Two fingers or a wheel scroll
/// them as any Mac list scrolls, with a slim scroller beside them, and moving
/// the highlight to a row out of view glides the list there instead of
/// jumping a row at a time.
final class AssistSuggestionScrollView: AssistSlimScrollView {
    /// Called whenever the person moves the list, with two fingers, a wheel
    /// or the scroller, so the highlight can stay in view.
    var onUserScroll: (() -> Void)?
    /// Moves the card is making itself, which are not the person's scrolling.
    private var ownMoves = 0
    /// When the list's current glide ends; the list moves on its own until then.
    private var glideEnds = Date.distantPast

    var isGliding: Bool { Date() < glideEnds }

    init() {
        super.init(vertical: true)
        contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(clipViewMoved),
                                               name: NSView.boundsDidChangeNotification, object: contentView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Scrolls the rows to `origin`, gliding there over `glideDuration`, or at
    /// once when it is nil, which also stops a glide under way.
    func scroll(to origin: NSPoint, glideDuration: TimeInterval?) {
        let clip = contentView
        if let glideDuration {
            glideEnds = Date().addingTimeInterval(glideDuration)
            NSAnimationContext.runAnimationGroup { context in
                context.duration = glideDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                clip.animator().setBoundsOrigin(origin)
            }
        } else {
            glideEnds = .distantPast
            withoutUserScroll {
                // Through the animator, so it replaces a glide under way.
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0
                    clip.animator().setBoundsOrigin(origin)
                }
            }
        }
        reflectScrolledClipView(clip)
    }

    /// Runs `change`, whose scrolling is the card's and not the person's.
    func withoutUserScroll(_ change: () -> Void) {
        ownMoves += 1
        defer { ownMoves -= 1 }
        change()
    }

    @objc private func clipViewMoved() {
        if ownMoves == 0, !isGliding { onUserScroll?() }
    }
}

/// A slim knob with no track, light enough to sit on the card's glass.
final class AssistListScroller: NSScroller {
    static let width: CGFloat = 10
    private static let knobInset = NSSize(width: 3, height: 3)

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

/// Where the rows sit in the scroll view: which are in view, where the list
/// must scroll to bring one into view, and which row keeps the highlight
/// when the person scrolls it away. Pure geometry, so the card and its
/// checks share it.
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
        // A row in view leaves the list where it is, even bounced past an end.
        guard rowCount > 0, !isInView(index, at: offset) else { return rowCount > 0 ? offset : 0 }
        let current = min(max(0, offset), maximumOffset)
        guard !isInView(index, at: current) else { return current }
        let top = CGFloat(index) * rowHeight
        let bottom = top + rowHeight + bottomPadding
        let target = top < current ? top : bottom - visibleHeight
        return min(max(0, target), maximumOffset)
    }

    /// The row that keeps the highlight after a scroll to `offset`: the
    /// highlighted row while it is in view, else the nearest row in view.
    func rowKeepingHighlight(_ selected: Int, at offset: CGFloat) -> Int {
        let inView = rowsInView(at: offset)
        guard !inView.isEmpty, !inView.contains(selected) else { return selected }
        return selected < inView.lowerBound ? inView.lowerBound : inView.upperBound - 1
    }
}
