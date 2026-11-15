// The passage picker's window: the file's name and kind above, the document
// as it looks in the middle, and along the bottom Insert, Insert Link and the
// switch for the source. It sits on the card's Liquid Glass surface, and its
// controls are the system's glass controls on macOS 26. Insert stays dimmed
// until something is highlighted.

import Cocoa
import UniformTypeIdentifiers

/// What the writer chose: the highlighted words, and how to insert them.
struct PassagePick {
    let body: String
    /// The source to type after the words, when the switch is on.
    let citation: String?
    /// Words said in a video are quoted when they are cited.
    let quoted: Bool
    /// Where a video link starts playing.
    let videoTime: Double?
    /// The typed words this takes the place of: set when the writer chose a
    /// highlight other than the one the picker opened on.
    var replacing: PassageTrigger? = nil
}

/// Where a picker body fetches what it shows besides the text: the PDF, the slide pictures.
struct PassageSourceLinks {
    let serverURL: URL
    let objectId: String
    let versionId: String?

    var pdfURL: URL? {
        var components = URLComponents(url: serverURL.appendingPathComponent("api/dependency-objects")
            .appendingPathComponent(objectId).appendingPathComponent("source"), resolvingAgainstBaseURL: false)
        if let versionId { components?.queryItems = [URLQueryItem(name: "version", value: versionId)] }
        return components?.url
    }

    var slides: SlidePictureSource { SlidePictureSource(serverURL: serverURL, objectId: objectId, versionId: versionId) }
}

final class PassagePickerView: NSView {
    static let defaultSize = NSSize(width: 700, height: 620)
    private static let margin: CGFloat = 18
    private static let headerHeight: CGFloat = 56
    private static let footerHeight: CGFloat = 64

    var onInsert: ((PassagePick) -> Void)?
    var onLink: ((PassagePick) -> Void)?
    var onCancel: (() -> Void)?

    private let icon = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: "Highlight the words to insert")
    private let closeButton = PassagePickerControls.circleButton(symbol: "xmark", label: "Back to suggestions (Esc)")
    private let message = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let insertButton = PassagePillButton(title: "Insert", symbol: "arrow.right.to.line", style: .prominent)
    private let linkButton = PassagePillButton(title: "Insert Link", symbol: "link", style: .secondary)
    private let sourceSwitch = PassageToggle()
    private let sourceLabel = NSTextField(labelWithString: "Insert with source")
    private let citationLabel = NSTextField(labelWithString: "")
    private var body: PassagePickerBody?
    /// The folder's colour, which the highlight is drawn in, as the card marks its words.
    var highlightColor: NSColor = .controlAccentColor
    /// A link needs an indexed source that can be shared.
    var linkAvailable = true { didSet { updateControls() } }

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        build()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func build() {
        icon.imageScaling = .scaleProportionallyUpOrDown
        insertButton.glyph = "\u{21E5}"
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.lineBreakMode = .byTruncatingMiddle
        hint.font = .systemFont(ofSize: 11.5)
        hint.textColor = .secondaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(cancel)
        message.alignment = .center
        message.textColor = .secondaryLabelColor
        message.font = .systemFont(ofSize: 13)
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.isDisplayedWhenStopped = false
        insertButton.target = self
        insertButton.action = #selector(insert)
        insertButton.toolTip = "Insert the highlighted words (Tab)"
        linkButton.target = self
        linkButton.action = #selector(link)
        linkButton.toolTip = "Insert the highlighted words as a share link (\u{21E7}\u{2318}\u{21A9})"
        sourceSwitch.setAccessibilityLabel("Insert with source")
        sourceSwitch.target = self
        sourceSwitch.action = #selector(sourceToggled)
        sourceLabel.font = .systemFont(ofSize: 13)
        citationLabel.font = .systemFont(ofSize: 11)
        citationLabel.textColor = .secondaryLabelColor
        citationLabel.lineBreakMode = .byTruncatingMiddle
        citationLabel.alignment = .right
        [icon, title, hint, closeButton, message, spinner, insertButton, linkButton, sourceSwitch, sourceLabel, citationLabel]
            .forEach(addSubview)
        showLoading()
    }

    private var bodyFrame: NSRect {
        NSRect(x: Self.margin, y: Self.headerHeight, width: bounds.width - Self.margin * 2,
               height: max(0, bounds.height - Self.headerHeight - Self.footerHeight))
    }

    override func layout() {
        super.layout()
        let margin = Self.margin, width = bounds.width
        icon.frame = NSRect(x: margin, y: 12, width: 32, height: 32)
        closeButton.frame = NSRect(x: width - margin - 28, y: 13, width: 28, height: 28)
        title.frame = NSRect(x: margin + 44, y: 11, width: width - margin * 2 - 84, height: 18)
        hint.frame = NSRect(x: margin + 44, y: 29, width: width - margin * 2 - 84, height: 15)
        body?.view.frame = bodyFrame
        message.frame = NSRect(x: margin * 2, y: bodyFrame.midY - 10, width: width - margin * 4, height: 44)
        spinner.frame = NSRect(x: bounds.midX - 10, y: bodyFrame.midY - 34, width: 20, height: 20)
        let footerY = bounds.height - Self.footerHeight + 16
        insertButton.frame = NSRect(x: margin, y: footerY, width: max(96, insertButton.intrinsicContentSize.width), height: 32)
        linkButton.frame = NSRect(x: insertButton.frame.maxX + 8, y: footerY, width: linkButton.intrinsicContentSize.width, height: 32)
        let toggle = sourceSwitch.intrinsicContentSize
        let switchX = width - margin - toggle.width
        sourceSwitch.frame = NSRect(x: switchX, y: footerY + (32 - toggle.height) / 2, width: toggle.width, height: toggle.height)
        sourceLabel.sizeToFit()
        sourceLabel.frame.origin = NSPoint(x: switchX - 10 - sourceLabel.frame.width, y: footerY)
        let citationX = linkButton.frame.maxX + 12
        citationLabel.frame = NSRect(x: citationX, y: footerY + 17, width: max(0, switchX - 10 - citationX), height: 14)
    }

    func showLoading(name: String = "", kind: String = "text") {
        body?.stop()
        body?.view.removeFromSuperview()
        body = nil
        title.stringValue = name
        icon.image = Self.fileIcon(name)
        spinner.startAnimation(nil)
        show(message: "Opening \(name.isEmpty ? "the source" : name)\u{2026}")
    }

    /// The file's icon as Finder and the suggestion card show it.
    static func fileIcon(_ name: String) -> NSImage {
        NSWorkspace.shared.icon(for: UTType(filenameExtension: (name as NSString).pathExtension) ?? .data)
    }

    func show(message text: String) {
        message.stringValue = text
        message.isHidden = false
        if text.hasPrefix("Opening") { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        updateControls()
    }

    /// The document as its kind looks, opened on the passage the suggestion cited.
    func show(_ document: PassageDocument, links: PassageSourceLinks?) {
        title.stringValue = document.name
        icon.image = Self.fileIcon(document.name)
        spinner.stopAnimation(nil)
        if let reason = document.unavailable { show(message: reason); return }
        message.isHidden = true
        trigger = document.trigger
        let highlight = highlightColor.withAlphaComponent(0.35)
        let opened: PassagePickerBody
        switch document.kind {
        case "video":
            let video = PassageVideoBody(document: document, highlight: highlight)
            opened = video
            install(opened)
            video.select(document.selection)
        case "slides":
            let slides = PassageSlidesBody(document: document, source: links?.slides, highlight: highlight)
            opened = slides
            install(opened)
            slides.select(document.selection)
        case "pdf":
            let pdf = PassagePDFBody(document: document, fileURL: links?.pdfURL, highlight: highlight)
            opened = pdf
            install(opened)
            pdf.select(document.selection)
        default:
            let text = PassageTextBody(document: document, highlight: highlight)
            opened = text
            install(opened)
            text.select(document.selection)
        }
        updateControls()
    }

    private func install(_ opened: PassagePickerBody) {
        body?.stop()
        body?.view.removeFromSuperview()
        body = opened
        opened.onSelectionChange = { [weak self] in self?.updateControls() }
        opened.view.frame = bodyFrame
        addSubview(opened.view, positioned: .below, relativeTo: insertButton)
        opened.view.layoutSubtreeIfNeeded()
    }

    /// The picker is closing: a video stops playing.
    func stop() { body?.stop() }

    // MARK: Choosing

    /// The typed words the opening highlight was found by.
    private var trigger: PassageTrigger?

    var currentPick: PassagePick? {
        guard var pick = body?.pick(citing: sourceSwitch.isOn) else { return nil }
        // Words the writer highlighted themselves replace what was typed to find them.
        if body?.isOpeningSelection == false { pick.replacing = trigger }
        return pick
    }
    var canInsert: Bool { currentPick != nil }

    private func updateControls() {
        let citation = body?.citation()
        let picked = body?.pick(citing: false) != nil
        insertButton.isEnabled = picked
        linkButton.isEnabled = picked && linkAvailable
        citationLabel.stringValue = picked ? (citation ?? "") : ""
        citationLabel.textColor = sourceSwitch.isOn ? .secondaryLabelColor : .tertiaryLabelColor
        hint.stringValue = picked ? "Tab inserts the highlighted words \u{00B7} Esc goes back" : "Highlight the words to insert"
    }

    @objc private func sourceToggled() { updateControls() }

    @objc func insert() {
        guard let pick = currentPick else { NSSound.beep(); return }
        onInsert?(pick)
    }

    @objc func link() {
        guard linkAvailable, let pick = currentPick else { NSSound.beep(); return }
        onLink?(pick)
    }

    @objc func cancel() { onCancel?() }

    func moveSelection(forward: Bool, byLine: Bool, extending: Bool) {
        body?.moveSelection(forward: forward, byLine: byLine, extending: extending)
    }

    // MARK: Moving

    /// The title bar is the handle the window is moved by, its name and icon
    /// included; the close button keeps its click.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        if bounds.contains(local), local.y < Self.headerHeight, !closeButton.frame.contains(local) { return self }
        let hit = super.hitTest(point)
        // The window's own labels and icon are handles too; the document's text never is.
        if let label = hit as? NSTextField, label.superview === self { return self }
        return hit
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// A drag on the title bar, or on the bare space beside the buttons, moves
    /// the window, kept on the screen. The picker never takes the keyboard, so
    /// it is moved here rather than by the system's window dragging.
    override func mouseDown(with event: NSEvent) {
        if let window { CardPanelTakeover.drag(window) }
    }
}
