// Finds AI-written text in the app in front and brackets it. Two kinds of
// record are drawn: snippets written here (the writer's answers, pastes of
// text copied from an AI), anchored in the field they went into, and the
// parts of a saved file the server says an AI wrote, found in the window
// whose document is that file. Like linked words, a part is drawn only where
// its text is found for certain; nothing is bracketed on a guess.
//
// Hovering a part shows its card (AIProvenancePopup.swift). The brackets and
// the card never take a click, and the card makes way for a linked word's
// pill under the pointer, so links inside AI-written text work as before.

import Cocoa
import ApplicationServices

final class AIAuthorshipHighlighter {
    static let shared = AIAuthorshipHighlighter()

    var serverURL: URL? {
        didSet { if serverURL != oldValue { answers = [:]; scheduleRefresh() } }
    }

    private let reader = AISnippetReader()
    private let store: AISnippetStore
    private let view = AIBracketView()
    private lazy var panel = AIBracketPanel(view: view)
    private var monitors: [Any] = []
    private var timer: Timer?
    private var isStarted = false
    private var scheduled = false
    private var reading = false
    private var again = false
    private var groups: [AIBracketGroup] = []
    /// The server's answer for each file shown lately, and when it came.
    private var answers: [String: (answer: AIAuthorshipAnswer, at: Date)] = [:]
    private var asking = Set<String>()
    /// The document in front, as last read.
    private var documentPath: String?
    private var missingSince: [String: Date] = [:]
    private var quietUntil = Date.distantPast
    private var hoverWork: DispatchWorkItem?
    private var hoveredId: String?

    private static let answerLife: TimeInterval = 5
    private static let deletionGrace: TimeInterval = 3
    private static let quietTime: TimeInterval = 0.35
    private static let hoverDelay: TimeInterval = 0.22

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Lasso", isDirectory: true)
        store = AISnippetStore(url: support.appendingPathComponent("ai-snippets.json"))
    }

    // MARK: Lifecycle

    func start() {
        guard !isStarted else { return }
        isStarted = true
        let centre = NSWorkspace.shared.notificationCenter
        monitors.append(centre.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            self?.scheduleRefresh()
        })
        monitors.append(centre.addObserver(forName: NSWorkspace.didDeactivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            self?.hide()
        })
        monitors.append(NotificationCenter.default.addObserver(forName: .aiProvenancePreferencesDidChange, object: nil, queue: .main) { [weak self] _ in
            self?.scheduleRefresh()
        })
        if let hover = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: { [weak self] _ in
            self?.hover(at: NSEvent.mouseLocation)
        }) { monitors.append(hover) }
        // Typing and scrolling move text: the brackets step aside until it settles.
        if let moving = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .scrollWheel], handler: { [weak self] event in
            self?.textMayMove(event)
        }) { monitors.append(moving) }
        if let clicks = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp], handler: { [weak self] _ in
            self?.closeCard()
            self?.scheduleRefresh()
        }) { monitors.append(clicks) }
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.scheduleRefresh() }
        timer?.tolerance = 0.3
        scheduleRefresh()
    }

    // MARK: Words written here

    /// Words an AI just wrote into `element`, at `anchor` in its text: kept
    /// and bracketed here, and reported so a save of the file is marked too.
    /// Without an anchor (a field Lasso cannot read back) only the report is made.
    func recordWritten(kind: String, agentName: String, agentId: String, model: String? = nil, tool: String?,
                       prompt: String?, text: String, anchor: TextAnchor?, element: AXUIElement?) {
        AccessibilityWork.queue.async { [reader] in
            let focused = reader.focused()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let context = focused?.context
                let path = focused?.documentPath
                var snippetId: String?
                if let anchor, let context, let element, CFEqual(context.element, element) {
                    let snippet = AISnippet(
                        id: "ai_" + UUID().uuidString.prefix(8), markId: nil, kind: kind, agentId: agentId, agentName: agentName,
                        model: model, tool: tool, prompt: prompt, hostBundleIdentifier: context.bundleIdentifier,
                        hostApplication: context.applicationName, documentContext: context.documentContext,
                        documentPath: path, anchor: anchor, createdAt: Date())
                    self.store.add(snippet)
                    snippetId = snippet.id
                    self.scheduleRefresh()
                }
                guard let serverURL = self.serverURL else { return }
                AIAuthorshipClient.record(serverURL: serverURL, [
                    "kind": kind, "agent": agentName, "model": model, "tool": tool, "prompt": prompt, "text": text,
                    "hostApp": context?.applicationName ?? NSWorkspace.shared.frontmostApplication?.localizedName,
                    "documentPath": path,
                ]) { [weak self] markId in
                    guard let self, let markId, let snippetId else { return }
                    self.store.update(id: snippetId) { $0.markId = markId }
                }
            }
        }
    }

    // MARK: Reading the app in front

    private var showsAnything: Bool {
        guard AIProvenancePreferences.showsMarks, AXIsProcessTrusted(),
              let front = NSWorkspace.shared.frontmostApplication,
              AccessibilityWork.mayRead(pid: front.processIdentifier) else { return false }
        return true
    }

    func scheduleRefresh() {
        guard isStarted else { return }
        guard showsAnything else { hide(); return }
        guard !scheduled else { return }
        scheduled = true
        let delay = max(0.05, quietUntil.timeIntervalSinceNow + 0.02)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.scheduled = false
            self?.refresh()
        }
    }

    private func refresh() {
        guard showsAnything else { hide(); return }
        guard Date() >= quietUntil else { scheduleRefresh(); return }
        guard !reading else { again = true; return }
        reading = true
        let snippets = store.snippets
        let answers = self.answers.mapValues(\.answer)
        AccessibilityWork.queue.async { [reader] in
            let result = reader.read(snippets: snippets, answers: answers)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.reading = false
                self.apply(result)
                if self.again { self.again = false; self.scheduleRefresh() }
            }
        }
    }

    private func apply(_ result: AISnippetReader.Reading?) {
        guard let result, showsAnything, Date() >= quietUntil else { hide(); return }
        documentPath = result.documentPath
        if let path = result.documentPath { askIfStale(path) }
        forgetMissing(result)
        let primary = HostGeometryConverter.primaryHeight(NSScreen.screens.map { $0.frame })
        var found: [AIBracketGroup] = []
        for part in result.parts {
            let lines = AIBracketGroup.readingOrder(DependencyGeometry.coalesce(
                part.rects.map { HostGeometryConverter.toAppKit($0, primaryHeight: primary) }, referenceId: part.id).fragments)
            guard !lines.isEmpty else { continue }
            found.append(AIBracketGroup(id: part.id, info: part.info, lines: lines,
                                        roomBefore: part.roomBefore, roomAfter: part.roomAfter))
        }
        guard !found.isEmpty else { hide(); return }
        if found != groups || !panel.isVisible {
            groups = found
            view.show(found)
            reframe()
            panel.orderFrontRegardless()
        }
        if let hoveredId, !found.contains(where: { $0.id == hoveredId }) { closeCard() }
    }

    /// Asks the server about the document in front when its last answer is old.
    private func askIfStale(_ path: String) {
        guard let serverURL, !asking.contains(path) else { return }
        if let known = answers[path], Date().timeIntervalSince(known.at) < Self.answerLife { return }
        asking.insert(path)
        AIAuthorshipClient.fetch(serverURL: serverURL, path: path) { [weak self] answer in
            guard let self else { return }
            self.asking.remove(path)
            guard let answer else { return }
            let changed = self.answers[path]?.answer != answer
            self.answers[path] = (answer, Date())
            if self.answers.count > 24, let oldest = self.answers.min(by: { $0.value.at < $1.value.at })?.key {
                self.answers.removeValue(forKey: oldest)
            }
            if changed { self.scheduleRefresh() }
        }
    }

    /// A snippet whose words stay gone from the field it was written in (taken back with ⌘Z, deleted) is let go.
    private func forgetMissing(_ result: AISnippetReader.Reading) {
        let now = Date()
        for id in result.missing {
            let since = missingSince[id] ?? now
            missingSince[id] = since
            if now.timeIntervalSince(since) >= Self.deletionGrace {
                store.remove(id: id)
                missingSince[id] = nil
            }
        }
        for part in result.parts { missingSince[part.id] = nil }
    }

    private func reframe() {
        guard let painted = view.paintedBounds else { return }
        let frame = painted.integral
        if panel.frame != frame { panel.setFrame(frame, display: false) }
        view.panelFrame = panel.frame
        view.frame = NSRect(origin: .zero, size: frame.size)
        view.needsDisplay = true
    }

    private func hide() {
        closeCard()
        guard panel.isVisible || !groups.isEmpty else { return }
        groups = []
        view.show([])
        view.hoveredId = nil
        panel.orderOut(nil)
    }

    private func textMayMove(_ event: NSEvent) {
        closeCard()
        guard panel.isVisible else { return }
        if event.type == .scrollWheel, event.scrollingDeltaY == 0, event.scrollingDeltaX == 0 { return }
        if event.type == .keyDown, !DependencyHighlighter.mayEditText(event) { return }
        quietUntil = Date().addingTimeInterval(Self.quietTime)
        groups = []
        view.show([])
        panel.orderOut(nil)
        scheduleRefresh()
    }

    // MARK: The card

    private func hover(at point: NSPoint) {
        guard panel.isVisible else { closeCard(); return }
        // A linked word's pill under the pointer is that link's; its menu, when open, too.
        let overLink = DependencyHighlighter.shared.covers(point) || ReferenceMenuController.shared.isShown
        let group = overLink ? nil : groups.first { $0.contains(point) }
        view.hoveredId = group?.id
        guard group?.id != hoveredId else { return }
        hoveredId = group?.id
        hoverWork?.cancel()
        guard let group else { AIProvenancePopupController.shared.hide(); return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.hoveredId == group.id, let first = group.lines.first, let last = group.lines.last else { return }
            let linked = DependencyHighlighter.shared.linkCount(inside: group.lines)
            AIProvenancePopupController.shared.show(id: group.id, info: group.info, linked: linked, above: first, below: last)
        }
        hoverWork = work
        let delay = AIProvenancePopupController.shared.isShown ? 0.05 : Self.hoverDelay
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func closeCard() {
        hoverWork?.cancel()
        hoveredId = nil
        view.hoveredId = nil
        AIProvenancePopupController.shared.hide()
    }
}

/// The Accessibility side: the focused field, its window's document, and
/// where each AI-written part sits. Used only on `AccessibilityWork.queue`.
final class AISnippetReader {
    struct Part {
        let id: String
        let info: AIMarkInfo
        /// Accessibility coordinates.
        let rects: [CGRect]
        let roomBefore: AIRoom
        let roomAfter: AIRoom
    }

    struct Reading {
        let context: HostContext
        let documentPath: String?
        let parts: [Part]
        /// Snippets written in this field whose words are gone from it.
        let missing: [String]
    }

    private let adapter = AccessibilityTextAdapter()
    private var geometry = HighlightGeometryCache()
    private static let mostParts = 80

    func focused() -> (context: HostContext, documentPath: String?)? {
        adapter.beginRefresh()
        guard let context = adapter.focusedContext() else { return nil }
        return (context, Self.documentPath(of: context.element))
    }

    func read(snippets: [AISnippet], answers: [String: AIAuthorshipAnswer]) -> Reading? {
        guard let focused = focused() else { return nil }
        let context = focused.context
        let path = focused.documentPath
        let local = snippets.filter { $0.hostBundleIdentifier == context.bundleIdentifier && $0.documentContext == context.documentContext }
        let answer = path.flatMap { answers[$0] }
        guard !local.isEmpty || !(answer?.spans.isEmpty ?? true) else {
            return Reading(context: context, documentPath: path, parts: [], missing: [])
        }
        guard let text = adapter.documentText(context) else {
            return Reading(context: context, documentPath: path, parts: [], missing: [])
        }
        let units = Self.normalized(Array(text.utf16))
        let snapshot = adapter.geometrySnapshot(context, text: text)
        var parts: [Part] = []
        var missing: [String] = []
        var drawnMarks = Set<String>()
        func measure(_ ranges: [Range<Int>]) -> [CGRect] {
            ranges.flatMap { range in
                geometry.rects(for: range, in: snapshot) { [adapter] range in adapter.measuredRects(for: range, in: context) }
            }
        }
        var taken: [Range<Int>] = []
        // Latest first: the same words pasted again are the latest paste's,
        // and an older record of those words is let go like deleted ones.
        for snippet in local.suffix(Self.mostParts).sorted(by: { $0.createdAt > $1.createdAt }) {
            switch TextAnchorResolver.resolve(Self.normalized(snippet.anchor), in: units) {
            case .resolved(let range):
                if taken.contains(where: { $0.overlaps(range) }) { missing.append(snippet.id); continue }
                let rects = measure([range])
                guard !rects.isEmpty else { continue }
                taken.append(range)
                parts.append(Part(id: snippet.id, info: snippet.info, rects: rects,
                                  roomBefore: .before(range, in: units), roomAfter: .after(range, in: units)))
                if let markId = snippet.markId { drawnMarks.insert(markId) }
            case .unresolved(.textMissing):
                missing.append(snippet.id)
            case .unresolved:
                continue
            }
        }
        if let answer {
            for (index, span) in answer.spans.prefix(Self.mostParts).enumerated() {
                guard !drawnMarks.contains(span.markId), let info = answer.marks[span.markId] else { continue }
                let ranges = Self.ranges(of: span, in: units)
                guard let first = ranges.first, let last = ranges.last,
                      !ranges.contains(where: { range in taken.contains { $0.overlaps(range) } }) else { continue }
                let rects = measure(ranges)
                guard !rects.isEmpty else { continue }
                parts.append(Part(id: "file:\(span.markId):\(index)", info: info, rects: rects,
                                  roomBefore: .before(first, in: units), roomAfter: .after(last, in: units)))
            }
        }
        return Reading(context: context, documentPath: path, parts: parts, missing: missing)
    }

    /// Where a saved file's part is in the field: whole when its text is found
    /// for certain, else line by line, keeping only lines found for certain.
    static func ranges(of span: AISpan, in units: [UInt16]) -> [Range<Int>] {
        if case .resolved(let range) = TextAnchorResolver.resolve(normalized(span.anchor), in: units) { return [range] }
        var found: [Range<Int>] = []
        for piece in span.pieces {
            if case .resolved(let range) = TextAnchorResolver.resolve(normalized(piece), in: units),
               found.last.map({ $0.upperBound <= range.lowerBound }) ?? true {
                found.append(range)
            }
        }
        return found
    }

    /// Line breaks read alike whichever an app uses (Word's carriage returns, paragraph separators).
    static func normalized(_ units: [UInt16]) -> [UInt16] {
        units.map { $0 == 13 || $0 == 0x2029 || $0 == 0x2028 ? 10 : $0 }
    }

    static func normalized(_ anchor: TextAnchor) -> TextAnchor {
        func clean(_ text: String) -> String { String(decoding: normalized(Array(text.utf16)), as: UTF16.self) }
        return TextAnchor(text: clean(anchor.text), prefixContext: clean(anchor.prefixContext),
                          suffixContext: clean(anchor.suffixContext), approximateOffset: anchor.approximateOffset)
    }

    /// The file the field's window shows, when the app says.
    static func documentPath(of element: AXUIElement) -> String? {
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
        }
        var window = attribute(element, kAXWindowAttribute as String)
        if window == nil {
            var pid: pid_t = 0
            AXUIElementGetPid(element, &pid)
            window = attribute(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute as String)
        }
        guard let window, CFGetTypeID(window) == AXUIElementGetTypeID(),
              let document = attribute(window as! AXUIElement, kAXDocumentAttribute as String) as? String,
              let url = URL(string: document), url.isFileURL else { return nil }
        return url.standardizedFileURL.resolvingSymlinksInPath().path
    }
}
