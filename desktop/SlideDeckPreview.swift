import Cocoa
import PDFKit

// A deck's slides as pictures, wherever Lasso shows one: the suggestion card
// and the share composer. Lasso's server draws each slide with Quick Look on
// its own, so the cited slide shows as soon as it is drawn rather than after
// the whole deck. Every slide has its page from the start, a placeholder of
// the right shape, and its picture replaces it when it arrives: the cited
// slide first, then the ones beside it, then whichever are scrolled to.
// A slide menu above or below the slides names the one in view and turns to
// any other.

/// A deck's slides as the server lists them for its slide menu, and their shape.
struct AssistSlideDeck: Equatable {
    struct Slide: Equatable {
        let number: Int
        let title: String?
    }

    let slides: [Slide]
    /// Width over height, the same for every slide of a deck.
    let aspect: CGFloat

    private static let aspectRange: ClosedRange<CGFloat> = 0.2...5

    init(slides: [Slide], aspect: CGFloat) {
        self.slides = slides
        self.aspect = min(max(aspect, Self.aspectRange.lowerBound), Self.aspectRange.upperBound)
    }

    /// The `deck` of a preview or document the server sent; nil when there is none.
    init?(json: Any?) {
        guard let json = json as? [String: Any], let list = json["slides"] as? [[String: Any]] else { return nil }
        let slides = list.compactMap { entry -> Slide? in
            guard let number = (entry["number"] as? NSNumber)?.intValue, number > 0 else { return nil }
            let title = (entry["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return Slide(number: number, title: title?.isEmpty == false ? title : nil)
        }
        guard !slides.isEmpty else { return nil }
        let aspect = (json["aspect"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 16 / 9
        self.init(slides: slides, aspect: aspect.isFinite && aspect > 0 ? aspect : 16 / 9)
    }

    func title(of number: Int) -> String? { slides.first { $0.number == number }?.title }

    /// "Slide 3 of 12 · Revenue", what the menu shows for the slide in view.
    func label(for number: Int) -> String {
        "Slide \(number) of \(slides.count)" + (title(of: number).map { " \u{00B7} " + $0 } ?? "")
    }

    /// "3  Revenue", one slide in the menu's list.
    func menuTitle(for slide: Slide) -> String {
        "\(slide.number)  " + (slide.title ?? "Untitled slide")
    }
}

/// Where one deck's slide pictures come from: the server's /slides route for
/// the cited object, at the version the card or composer shows.
struct SlidePictureSource: Equatable {
    let serverURL: URL
    let objectId: String
    let versionId: String?

    func url(for number: Int) -> URL? {
        var components = URLComponents(url: serverURL.appendingPathComponent("api/dependency-objects")
            .appendingPathComponent(objectId).appendingPathComponent("slides").appendingPathComponent(String(number)),
                                       resolvingAgainstBaseURL: false)
        if let versionId { components?.queryItems = [URLQueryItem(name: "version", value: versionId)] }
        return components?.url
    }

    var cacheKey: String { objectId + "|" + (versionId ?? "") }
}

/// Slide pictures already fetched, as the JPEG the server sent, shared by
/// every window: a slide seen on the card opens at once in the composer.
enum SlidePictureCache {
    private static let pictures: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.totalCostLimit = 96 * 1024 * 1024
        return cache
    }()

    static func picture(_ number: Int, of source: SlidePictureSource) -> Data? {
        pictures.object(forKey: key(number, source) as NSString) as Data?
    }

    static func keep(_ data: Data, _ number: Int, of source: SlidePictureSource) {
        pictures.setObject(data as NSData, forKey: key(number, source) as NSString, cost: data.count)
    }

    private static func key(_ number: Int, _ source: SlidePictureSource) -> String { source.cacheKey + "|" + String(number) }
}

/// A deck's slides, or one of them, as PDF pages a PDF view scrolls through
/// and the share composer marks up. A slide's page is a placeholder until its
/// picture arrives, then the picture's page takes its place.
final class SlideDeckDocument {
    /// Slides are pages this wide, in points, as the server's marked copies make them.
    static let pageWidth: CGFloat = 960
    private static let requestTimeout: TimeInterval = 20
    /// Slides past the one in view that are fetched ahead of a scroll.
    private static let lookAhead = 1

    let deck: AssistSlideDeck
    let source: SlidePictureSource
    /// The slides this document holds, in order: all of them, or the cited one.
    let numbers: [Int]
    let document = PDFDocument()
    /// Called on the main thread just before and after a slide's picture replaces its placeholder.
    var willReplacePage: ((_ old: PDFPage) -> Void)?
    var didReplacePage: ((_ old: PDFPage, _ new: PDFPage) -> Void)?
    /// The navigator those two belong to. The deck is cached, so a newer view's
    /// navigator can take them over before an older one goes away.
    var pageWatcher: ObjectIdentifier?
    private(set) var drawn = Set<Int>()
    private var failed = Set<Int>()
    /// While true, as while a stroke is drawn across a page, pictures wait to replace their pages.
    var holdsPages = false {
        didSet { if !holdsPages { arrived.forEach { show($0.value, for: $0.key) }; arrived.removeAll() } }
    }
    private var arrived: [Int: Data] = [:]
    private var requests: [Int: URLSessionDataTask] = [:]
    /// Fetches the URL a slide's picture is at; a test gives its own.
    var fetch: (URL, @escaping (Data?) -> Void) -> URLSessionDataTask? = SlideDeckDocument.download

    /// `only` limits the document to those slides, such as the one a
    /// "Cited slide only" share publishes.
    init(deck: AssistSlideDeck, source: SlidePictureSource, only: [Int]? = nil) {
        self.deck = deck
        self.source = source
        let all = deck.slides.map(\.number)
        numbers = only.map { wanted in all.filter(wanted.contains) } ?? all
        for (index, number) in numbers.enumerated() {
            let cached = SlidePictureCache.picture(number, of: source)
            let page = cached.flatMap { picturePage($0) } ?? placeholderPage(number)
            if cached != nil, page != nil { drawn.insert(number) }
            if let page { document.insert(page, at: index) }
        }
    }

    deinit { requests.values.forEach { $0.cancel() } }

    /// The page showing slide `number`, if this document holds it.
    func page(for number: Int) -> PDFPage? {
        numbers.firstIndex(of: number).flatMap { document.page(at: $0) }
    }

    /// The slide a page of this document shows.
    func number(of page: PDFPage) -> Int? {
        let index = document.index(for: page)
        return numbers.indices.contains(index) ? numbers[index] : nil
    }

    /// Fetches the pictures of `number` and the slides beside it, nearest first.
    func load(around number: Int) {
        load([number, number + 1, number - 1] + (1...Self.lookAhead).map { number + 1 + $0 })
    }

    /// Fetches the pictures of the slides in view, and those just past them.
    func load(showing pages: [PDFPage]) {
        let shown = pages.compactMap(number(of:))
        guard let first = shown.min(), let last = shown.max() else { return }
        load(shown + [last + 1, first - 1] + (1...Self.lookAhead).map { last + 1 + $0 })
    }

    func load(_ wanted: [Int]) {
        for number in wanted where numbers.contains(number) && !drawn.contains(number)
            && !failed.contains(number) && requests[number] == nil {
            if let cached = SlidePictureCache.picture(number, of: source) {
                show(cached, for: number)
                continue
            }
            guard let url = source.url(for: number) else { continue }
            requests[number] = fetch(url) { [weak self] data in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.requests[number] = nil
                    guard let data, NSImage(data: data) != nil else { self.failed.insert(number); return }
                    SlidePictureCache.keep(data, number, of: self.source)
                    self.show(data, for: number)
                }
            }
        }
    }

    private func show(_ data: Data, for number: Int) {
        guard !holdsPages else { arrived[number] = data; return }
        guard let index = numbers.firstIndex(of: number), let old = document.page(at: index),
              let page = picturePage(data) else { return }
        drawn.insert(number)
        willReplacePage?(old)
        document.insert(page, at: index)
        document.removePage(at: index + 1)
        didReplacePage?(old, page)
    }

    private static func download(_ url: URL, _ completion: @escaping (Data?) -> Void) -> URLSessionDataTask? {
        var request = URLRequest(url: url)
        request.timeoutInterval = requestTimeout
        let task = URLSession.shared.dataTask(with: request) { data, response, _ in
            completion((response as? HTTPURLResponse)?.statusCode == 200 ? data : nil)
        }
        task.resume()
        return task
    }

    // MARK: Pages

    private var placeholderSize: CGSize {
        CGSize(width: Self.pageWidth, height: (Self.pageWidth / deck.aspect).rounded())
    }

    /// A slide's picture on a page the size of its placeholder, so nothing in
    /// view moves when it arrives; the server's marked copy is the picture's
    /// own shape, within a point of it, and marks are placed in proportion.
    /// Each page is made from its picture alone: a page lifted out of another
    /// PDF document breaks PDFKit's accessibility.
    private func picturePage(_ data: Data) -> PDFPage? {
        guard let picture = NSImage(data: data), let pixels = picture.representations.first,
              pixels.pixelsWide > 0, pixels.pixelsHigh > 0 else { return nil }
        return Self.page(of: picture, size: placeholderSize)
    }

    /// The slide's place while its picture is drawn: its number and title on grey.
    private func placeholderPage(_ number: Int) -> PDFPage? {
        let title = deck.title(of: number)
        let size = placeholderSize
        let image = NSImage(size: size, flipped: false) { box in
            NSColor(white: 0.93, alpha: 1).setFill()
            box.fill()
            let style = NSMutableParagraphStyle()
            style.alignment = .center
            let text = NSMutableAttributedString(string: "Slide \(number)", attributes: [
                .font: NSFont.systemFont(ofSize: 30, weight: .semibold),
                .foregroundColor: NSColor(white: 0.42, alpha: 1), .paragraphStyle: style])
            if let title {
                text.append(NSAttributedString(string: "\n" + title, attributes: [
                    .font: NSFont.systemFont(ofSize: 24), .foregroundColor: NSColor(white: 0.5, alpha: 1), .paragraphStyle: style]))
            }
            let bounds = text.boundingRect(with: CGSize(width: box.width - 120, height: box.height - 80),
                                           options: [.usesLineFragmentOrigin, .usesFontLeading])
            text.draw(with: CGRect(x: 60, y: (box.height - bounds.height) / 2, width: box.width - 120, height: bounds.height),
                      options: [.usesLineFragmentOrigin, .usesFontLeading])
            return true
        }
        return Self.page(of: image, size: size)
    }

    private static func page(of image: NSImage, size: CGSize) -> PDFPage? {
        PDFPage(image: image, options: [.mediaBox: NSValue(rect: CGRect(origin: .zero, size: size)),
                                        .compressionQuality: 0.85, .upscaleIfSmaller: true])
    }
}

/// A button that answers the first click, as everything on Lasso's non-activating panels must.
private final class SlideMenuButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// One slide in the slide list: its number and title, the slide in view marked.
private final class SlideListRow: NSView {
    static let height: CGFloat = 24
    let number: Int
    private let title: String
    private let isCurrent: Bool
    private let onPick: (Int) -> Void

    init(number: Int, title: String, isCurrent: Bool, onPick: @escaping (Int) -> Void) {
        self.number = number
        self.title = title
        self.isCurrent = isCurrent
        self.onPick = onPick
        super.init(frame: .zero)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { pick() }
    func pick() { onPick(number) }

    override func draw(_ dirtyRect: NSRect) {
        if isCurrent {
            NSColor.controlAccentColor.withAlphaComponent(0.22).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 4, dy: 1), xRadius: 5, yRadius: 5).fill()
        }
        NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize, weight: isCurrent ? .semibold : .regular),
            .foregroundColor: NSColor.labelColor,
        ]).draw(with: NSRect(x: 12, y: 4, width: bounds.width - 20, height: bounds.height - 6),
                options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
}

private final class SlideListDocument: NSView {
    override var isFlipped: Bool { true }
}

/// The slide menu: the slide in view by number and title, a list of every
/// slide to turn to, and buttons for the slide before and after it. The list
/// opens inside the window showing the slides: a pop-up menu is a window of
/// its own, and opening one from the suggestion card closed the card.
final class SlideMenuBar: NSView {
    static let height: CGFloat = 26
    private static let arrowWidth: CGFloat = 26
    private static let gap: CGFloat = 4
    private static let listRows: CGFloat = 8

    /// Called with the slide the person turned to.
    var onChoose: ((Int) -> Void)?
    private(set) var current: Int
    private let deck: AssistSlideDeck
    /// The slides that can be turned to; only the cited one when that is all a share holds.
    private let numbers: [Int]
    private let previous = SlideMenuButton()
    private let next = SlideMenuButton()
    /// Reads "Slide 3 of 12 · Revenue" and opens the list of every slide.
    private let title = SlideMenuButton()
    private var list: NSScrollView?
    private var clickMonitor: Any?

    init(deck: AssistSlideDeck, numbers: [Int]? = nil, current: Int) {
        self.deck = deck
        self.numbers = numbers ?? deck.slides.map(\.number)
        self.current = current
        super.init(frame: .zero)
        for (button, symbol, label) in [(previous, "chevron.left", "Previous slide"), (next, "chevron.right", "Next slide")] {
            button.bezelStyle = .accessoryBarAction
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
            button.imagePosition = .imageOnly
            button.controlSize = .small
            button.toolTip = label
            button.target = self
            button.action = button === previous ? #selector(turnBack) : #selector(turnOn)
            addSubview(button)
        }
        title.bezelStyle = .accessoryBarAction
        title.controlSize = .small
        title.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        title.image = NSImage(systemSymbolName: "chevron.up.chevron.down", accessibilityDescription: nil)
        title.imagePosition = .imageTrailing
        title.alignment = .left
        title.lineBreakMode = .byTruncatingTail
        title.target = self
        title.action = #selector(toggleList)
        title.setAccessibilityLabel("Slide menu")
        addSubview(title)
        show(current)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { if let clickMonitor { NSEvent.removeMonitor(clickMonitor) } }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override var isHidden: Bool { didSet { if isHidden { closeList() } } }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        super.viewWillMove(toWindow: newWindow)
        if newWindow == nil { closeList() }
    }

    override func layout() {
        super.layout()
        let arrows = numbers.count > 1
        previous.isHidden = !arrows
        next.isHidden = !arrows
        let side = arrows ? Self.arrowWidth + Self.gap : 0
        previous.frame = NSRect(x: 0, y: 0, width: Self.arrowWidth, height: bounds.height)
        next.frame = NSRect(x: bounds.width - Self.arrowWidth, y: 0, width: Self.arrowWidth, height: bounds.height)
        title.frame = NSRect(x: side, y: 0, width: max(0, bounds.width - side * 2), height: bounds.height)
    }

    /// Names slide `number` as the one in view.
    func show(_ number: Int) {
        current = number
        title.title = deck.label(for: number)
        title.isEnabled = numbers.count > 1
        title.toolTip = numbers.count > 1 ? "Choose a slide" : "Only this slide is shared"
        guard let index = numbers.firstIndex(of: number) else { return }
        previous.isEnabled = index > 0
        next.isEnabled = index < numbers.count - 1
    }

    /// The slides the list offers, by number.
    var listedSlides: [Int] { numbers }
    var shownLabel: String { title.title }
    var canTurnBack: Bool { !previous.isHidden && previous.isEnabled }
    var canTurnOn: Bool { !next.isHidden && next.isEnabled }
    /// The open list, in the slides' own window; nil while closed.
    var openList: NSView? { list }

    /// Opens the list and chooses slide `number` from it, as clicks would.
    func chooseFromList(_ number: Int) {
        if list == nil { toggleList() }
        let rows = list?.documentView?.subviews.compactMap { $0 as? SlideListRow } ?? []
        rows.first { $0.number == number }?.pick()
    }

    func clickNext() { next.performClick(nil) }

    @objc private func toggleList() {
        if list != nil { closeList(); return }
        guard numbers.count > 1, let host = window?.contentView else { return }
        let rowsHeight = CGFloat(numbers.count) * SlideListRow.height + 8
        let anchor = convert(bounds, to: host)
        let hostFlipped = host.isFlipped
        // Room above and below the bar, in the window's own content.
        let above = hostFlipped ? anchor.minY : host.bounds.maxY - anchor.maxY
        let below = hostFlipped ? host.bounds.maxY - anchor.maxY : anchor.minY
        let upward = above > below
        let height = min(rowsHeight, min(Self.listRows * SlideListRow.height + 8, max(above, below) - 4))
        let y: CGFloat = hostFlipped
            ? (upward ? anchor.minY - height - 2 : anchor.maxY + 2)
            : (upward ? anchor.maxY + 2 : anchor.minY - height - 2)
        let scroll = NSScrollView(frame: NSRect(x: anchor.minX, y: y, width: anchor.width, height: max(SlideListRow.height, height)))
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.drawsBackground = true
        scroll.backgroundColor = .windowBackgroundColor
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 8
        scroll.layer?.borderWidth = 1
        scroll.layer?.borderColor = NSColor.separatorColor.cgColor
        let document = SlideListDocument(frame: NSRect(x: 0, y: 0, width: anchor.width, height: rowsHeight))
        for (index, number) in numbers.enumerated() {
            let slide = deck.slides.first { $0.number == number } ?? .init(number: number, title: nil)
            let row = SlideListRow(number: number, title: deck.menuTitle(for: slide), isCurrent: number == current) { [weak self] picked in
                self?.closeList()
                self?.turn(to: picked)
            }
            row.frame = NSRect(x: 0, y: 4 + CGFloat(index) * SlideListRow.height, width: anchor.width, height: SlideListRow.height)
            row.autoresizingMask = [.width]
            document.addSubview(row)
        }
        scroll.documentView = document
        host.addSubview(scroll)
        list = scroll
        if let index = numbers.firstIndex(of: current) {
            document.scrollToVisible(NSRect(x: 0, y: 4 + CGFloat(index) * SlideListRow.height, width: 1, height: SlideListRow.height))
        }
        // A click anywhere else closes the list, and still does what it would.
        clickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            guard let self, let list = self.list, event.window === list.window else { self?.closeList(); return event }
            let point = list.superview?.convert(event.locationInWindow, from: nil) ?? .zero
            let onTitle = self.title.convert(event.locationInWindow, from: nil)
            if !list.frame.contains(point) && !self.title.bounds.contains(onTitle) { self.closeList() }
            return event
        }
    }

    private func closeList() {
        list?.removeFromSuperview()
        list = nil
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
    }

    @objc private func turnBack() { step(-1) }
    @objc private func turnOn() { step(1) }

    private func step(_ delta: Int) {
        guard let index = numbers.firstIndex(of: current), numbers.indices.contains(index + delta) else { return }
        turn(to: numbers[index + delta])
    }

    private func turn(to number: Int) {
        guard numbers.contains(number) else { return }
        show(number)
        onChoose?(number)
    }
}

/// Keeps a PDF view showing a slide deck and its slide menu in step: the menu
/// names the slide in view, choosing one scrolls to it, and the pictures of
/// the slides in view are fetched as they are scrolled to.
final class SlideDeckNavigator {
    let deck: SlideDeckDocument
    let bar: SlideMenuBar
    /// Called with a slide's number once its picture has replaced its placeholder.
    var onPictured: ((Int) -> Void)?
    private weak var view: PDFView?
    private var observers: [NSObjectProtocol] = []

    init(deck: SlideDeckDocument, view: PDFView, current: Int) {
        self.deck = deck
        self.view = view
        bar = SlideMenuBar(deck: deck.deck, numbers: deck.numbers, current: current)
        bar.onChoose = { [weak self] number in self?.go(to: number) }
        deck.willReplacePage = { [weak self] old in self?.hold(old) }
        deck.didReplacePage = { [weak self] old, new in self?.replaced(old, with: new) }
        deck.pageWatcher = ObjectIdentifier(self)
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .PDFViewPageChanged, object: view, queue: .main) { [weak self] _ in
            self?.followView()
        })
        observers.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let view = self.view, let clip = note.object as? NSView, clip.isDescendant(of: view) else { return }
            self.followView()
        })
        deck.load(around: current)
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        guard deck.pageWatcher == ObjectIdentifier(self) else { return }
        deck.willReplacePage = nil
        deck.didReplacePage = nil
        deck.pageWatcher = nil
    }

    /// Scales the slides so a whole one fits in the view, as wide as it can be;
    /// fitting the width alone would cut the foot off every slide.
    func fitSlides() {
        guard let view, let page = deck.document.page(at: 0) else { return }
        let box = page.bounds(for: .cropBox)
        let content = view.documentView?.enclosingScrollView?.contentSize ?? view.bounds.size
        guard box.width > 0, box.height > 0, content.width > 0, content.height > 0 else { return }
        let breaks = view.displaysPageBreaks ? view.pageBreakMargins.top + view.pageBreakMargins.bottom : 0
        let scale = min(content.width / box.width, max(0.05, (content.height - breaks) / box.height))
        view.autoScales = false
        if abs(view.scaleFactor - scale) > 0.001 { view.scaleFactor = scale }
    }

    /// Scrolls the view to the top of slide `number`.
    func go(to number: Int) {
        guard let view, let page = deck.page(for: number) else { return }
        view.go(to: PDFDestination(page: page, at: NSPoint(x: 0, y: page.bounds(for: .cropBox).maxY)))
        bar.show(number)
        deck.load(around: number)
    }

    /// The slide filling most of the view.
    var slideInView: Int? {
        guard let view else { return nil }
        let shown = view.visiblePages.map { page -> (Int?, CGFloat) in
            let area = view.convert(page.bounds(for: .cropBox), from: page).intersection(view.bounds)
            return (deck.number(of: page), area.isNull ? 0 : area.width * area.height)
        }
        return shown.max { $0.1 < $1.1 }?.0
    }

    private var following = false

    /// PDFKit reports a scroll before it has laid the pages out where they
    /// land, so the slide in view is read once the scroll has settled.
    private func followView() {
        guard !following else { return }
        following = true
        DispatchQueue.main.async { [weak self] in
            guard let self, let view = self.view else { return }
            self.following = false
            view.layoutDocumentView()
            self.deck.load(showing: view.visiblePages)
            if let number = self.slideInView, number != self.bar.current { self.bar.show(number) }
        }
    }

    /// The slide at the top of the view, and where on it the view's top is,
    /// while a page is swapped for its picture.
    private var held: (number: Int, y: CGFloat)?

    private func hold(_ old: PDFPage) {
        guard let view else { return }
        view.layoutDocumentView()
        let top = NSPoint(x: view.bounds.midX, y: view.isFlipped ? view.bounds.minY : view.bounds.maxY)
        guard let page = view.page(for: top, nearest: true), let number = deck.number(of: page) else { held = nil; return }
        held = (number, view.convert(top, to: page).y)
    }

    /// Puts the view back where it was: a page coming or going makes PDFKit
    /// scroll on its own.
    private func replaced(_ old: PDFPage, with new: PDFPage) {
        defer {
            held = nil
            if let number = deck.number(of: new) { onPictured?(number) }
        }
        guard let view, let held, let page = deck.page(for: held.number) else { return }
        view.layoutDocumentView()
        view.go(to: PDFDestination(page: page, at: NSPoint(x: 0, y: held.y)))
    }
}

#if BROWSER_GEOMETRY_TEST
extension SlideDeckDocument {
    /// A deck of `pictures.count` slides, its pictures fetched from `pictures`
    /// with a short delay as the server would send them, in the order asked.
    static func regressionDeck(pictures: [Data], only: [Int]? = nil, asked: @escaping (Int) -> Void = { _ in }) -> SlideDeckDocument {
        let deck = AssistSlideDeck(slides: pictures.indices.map { .init(number: $0 + 1, title: "Title \($0 + 1)") }, aspect: 16 / 9)
        let document = SlideDeckDocument(deck: deck, source: SlidePictureSource(
            serverURL: URL(string: "http://127.0.0.1:9")!, objectId: "regression-\(UUID().uuidString)", versionId: nil), only: only)
        document.fetch = { url, completion in
            guard let number = Int(url.lastPathComponent), pictures.indices.contains(number - 1) else { completion(nil); return nil }
            asked(number)
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { completion(pictures[number - 1]) }
            // Never started: it stands for the request while the picture is on its way.
            return URLSession.shared.dataTask(with: url)
        }
        return document
    }
}

extension AssistSlidePreviewView {
    /// The card's slides from slide 3 of five: the cited slide is fetched
    /// first, then its neighbours, the menu names and turns to each slide,
    /// and a scroll fetches the slides it reaches. Writes the card's slides,
    /// drawn from their pages, to `outputDirectory`.
    static func runRegression(pictures: [Data], outputDirectory: String? = nil) -> [String] {
        var failures: [String] = []
        func require(_ condition: Bool, _ message: String) { if !condition { failures.append(message) } }
        func spin(_ seconds: TimeInterval) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
        guard pictures.count >= 5 else { return ["Five slide pictures are needed."] }
        var asked: [Int] = []
        let slides = SlideDeckDocument.regressionDeck(pictures: Array(pictures.prefix(5))) { asked.append($0) }
        require(slides.document.pageCount == 5 && slides.drawn.isEmpty, "Every slide has a placeholder page before any picture arrives")
        let view = AssistSlidePreviewView(slides: slides, current: 3)
        let window = NSWindow(contentRect: NSRect(x: -10_000, y: 0, width: 358, height: 222), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.contentView = view
        view.frame = NSRect(x: 0, y: 0, width: 358, height: 222)
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        view.layoutSubtreeIfNeeded()
        spin(0.4)
        require(asked.first == 3, "The cited slide is fetched first (asked \(asked))")
        require(Set(asked.prefix(3)) == [2, 3, 4], "Then the slides beside it (asked \(asked))")
        require(slides.drawn.isSuperset(of: [2, 3, 4]), "The cited slide and its neighbours get their pictures (drawn \(slides.drawn.sorted()))")
        require(view.navigator.slideInView == 3,
                "The card opens on the cited slide (shows \(view.navigator.slideInView ?? 0))")
        require(view.navigator.bar.shownLabel == "Slide 3 of 5 \u{00B7} Title 3", "The slide menu names it: \(view.navigator.bar.shownLabel)")
        require(view.navigator.bar.listedSlides == [1, 2, 3, 4, 5], "The slide menu lists every slide")
        view.navigator.bar.performSelector(onMainThread: Selector(("toggleList")), with: nil, waitUntilDone: true)
        require(view.navigator.bar.openList?.window === window,
                "The slide list opens inside the card's own window, never as a menu window of its own")
        let picture = slides.page(for: 3)?.bounds(for: .cropBox).size ?? .zero
        require(abs(picture.width - SlideDeckDocument.pageWidth) < 0.5 && picture.height > 400,
                "A slide's picture is a page as wide as a marked copy's")

        view.navigator.bar.chooseFromList(1)
        spin(0.3)
        require(view.navigator.slideInView == 1, "Choosing slide 1 from the menu turns to it")
        require(slides.drawn.contains(1), "and fetches its picture")
        require(!view.navigator.bar.canTurnBack && view.navigator.bar.canTurnOn, "The first slide has no slide before it")
        view.navigator.bar.clickNext()
        spin(0.3)
        require(view.navigator.slideInView == 2 && view.navigator.bar.current == 2, "The next-slide button turns on")

        // Scrolling to the last slide fetches it, and the menu follows.
        if let last = slides.page(for: 5) {
            view.pdfView.go(to: PDFDestination(page: last, at: NSPoint(x: 0, y: last.bounds(for: .cropBox).maxY)))
        }
        spin(0.4)
        require(slides.drawn.contains(5), "Scrolling to a slide fetches its picture")
        require(view.navigator.bar.current == 5, "The slide menu follows the scroll (names \(view.navigator.bar.current))")
        require(!view.navigator.bar.canTurnOn, "The last slide has no slide after it")
        require(asked.count == Set(asked).count, "No slide is fetched twice (asked \(asked))")

        let cached = SlideDeckDocument(deck: slides.deck, source: slides.source)
        require(cached.drawn == slides.drawn, "Another window showing the deck starts with the pictures already fetched")

        if let outputDirectory {
            // PDFKit draws the slide in view a moment after it is scrolled to.
            spin(0.5)
            for number in [1, 3, 5] {
                guard let page = slides.page(for: number) else { continue }
                let image = page.thumbnail(of: NSSize(width: 640, height: 360), for: .cropBox)
                if let data = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: data),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: outputDirectory).appendingPathComponent("card-slide-\(number).png"))
                }
            }
            if let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
                try? bitmap.representation(using: .png, properties: [:])?
                    .write(to: URL(fileURLWithPath: outputDirectory).appendingPathComponent("card-slides.png"))
            }
        }
        return failures
    }
}
#endif
