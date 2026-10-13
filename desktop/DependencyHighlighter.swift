//  Keeps local dependency highlights attached to the right words.
//
//  Relevant input and Accessibility events refresh the focused surface, with
//  a slow fallback for hosts that omit change notifications. Unchanged anchor
//  matches and overlay frames are reused. Uncertain references are marked
//  unresolved and simply not drawn; nothing is ever highlighted on a guess.

import Cocoa
import ApplicationServices

final class DependencyHighlighter {
    static let shared = DependencyHighlighter()

    var serverURL: URL? {
        didSet {
            if serverURL != nil { migrateStoredSourcePaths() }
        }
    }
    var onInspect: ((DependencyReference, CGRect) -> Void)?

    private let adapter = AccessibilityTextAdapter()
    private let store: DependencyReferenceStore
    private let view = OverlayView()
    private lazy var panel = OverlayPanel(view: view)
    private var currentContext: HostContext?
    private var geometries: [DependencyGeometry] = []
    private var scheduled = false
    private var monitors: [Any] = []
    private var settleTimer: Timer?
    private var isStarted = false
    private var systemSleeping = false
    private var displaySleeping = false
    private var lastRefresh = Date.distantPast
    private var observer: AXObserver?
    private var observedPID: pid_t?
    private var observedElements: [AXUIElement] = []
    private let resolutions = TextAnchorResolutionCache()
    private var migratingObjectIds = Set<String>()

    var isDebugging = false {
        didSet { view.debug = isDebugging; view.needsDisplay = true; refresh() }
    }

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Lasso", isDirectory: true)
        store = DependencyReferenceStore(url: support.appendingPathComponent("references.json"))
    }

    // MARK: Lifecycle

    func start() {
        guard !isStarted else { return }
        isStarted = true
        let centre = NSWorkspace.shared.notificationCenter
        monitors.append(centre.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                self?.scheduleRefresh()
            })
        monitors.append(centre.addObserver(
            forName: NSWorkspace.didDeactivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                self?.hide()
            })
        monitors.append(NotificationCenter.default.addObserver(
            forName: .directoryColorsDidChange, object: nil, queue: .main) { [weak self] _ in
                self?.scheduleRefresh()
            })

        // Hover and click handling for dependency regions only. Global monitors
        // observe without consuming, so the host application keeps every event.
        let hover = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: { [weak self] _ in
            self?.handleHover(NSEvent.mouseLocation)
        })
        if let hover { monitors.append(hover) }
        let click = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown], handler: { [weak self] _ in
            self?.handleClick(NSEvent.mouseLocation)
        })
        if let click { monitors.append(click) }
        if let changes = NSEvent.addGlobalMonitorForEvents(
            matching: [.keyDown, .scrollWheel, .leftMouseDown, .leftMouseDragged, .leftMouseUp],
            handler: { [weak self] _ in self?.scheduleRefresh() }) { monitors.append(changes) }

        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification] {
            monitors.append(centre.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                if name == NSWorkspace.willSleepNotification { self?.systemSleeping = true }
                else { self?.displaySleeping = true }
                self?.updatePolling()
                self?.hide()
            })
        }
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
            monitors.append(centre.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                if name == NSWorkspace.didWakeNotification { self?.systemSleeping = false }
                else { self?.displaySleeping = false }
                self?.scheduleRefresh()
            })
        }
        scheduleRefresh()
    }

    private var hasRelevantHost: Bool {
        guard !systemSleeping, !displaySleeping,
              let bundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else { return false }
        return store.hasReferences(bundleIdentifier: bundle)
    }

    private func updatePolling() {
        guard hasRelevantHost else {
            settleTimer?.invalidate()
            settleTimer = nil
            detachObserver()
            return
        }
        guard settleTimer == nil else { return }
        // Hosts do not consistently notify programmatic scroll/layout changes.
        // Preserve that fallback, but never poll apps with no saved references.
        let timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.scheduleRefresh()
        }
        timer.tolerance = 0.4
        settleTimer = timer
    }

    private func detachObserver() {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observer = nil
        observedPID = nil
        observedElements = []
    }

    private func observe(_ context: HostContext) {
        var pid: pid_t = 0
        guard AXUIElementGetPid(context.element, &pid) == .success else { return }
        if observedPID != pid {
            detachObserver()
            var created: AXObserver?
            guard AXObserverCreate(pid, { _, _, _, refcon in
                guard let refcon else { return }
                Unmanaged<DependencyHighlighter>.fromOpaque(refcon).takeUnretainedValue().scheduleRefresh()
            }, &created) == .success, let created else { return }
            observer = created
            observedPID = pid
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        }
        guard let observer else { return }
        if observedElements.contains(where: { CFEqual($0, context.element) }) { return }
        let notifications = [kAXValueChangedNotification, kAXSelectedTextChangedNotification,
                             kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification,
                             kAXMovedNotification, kAXResizedNotification, "AXLayoutChanged"]
        for element in observedElements {
            for name in notifications { AXObserverRemoveNotification(observer, element, name as CFString) }
        }
        let application = AXUIElementCreateApplication(pid)
        var window: CFTypeRef?
        AXUIElementCopyAttributeValue(context.element, kAXWindowAttribute as CFString, &window)
        observedElements = [application, context.element]
        if let window, CFGetTypeID(window) == AXUIElementGetTypeID() { observedElements.append(window as! AXUIElement) }
        for element in observedElements {
            for name in notifications {
                AXObserverAddNotification(observer, element, name as CFString,
                                          Unmanaged.passUnretained(self).toOpaque())
            }
        }
    }

    /// Stage B. Records a reference from an already-verified range: the caller
    /// has proved these characters are the accepted phrase, so no searching or
    /// guessing happens here.
    func recordVerifiedInsertion(objectId: String, versionId: String?, projectId: String? = nil, label: String,
                                 valueText: String?, sourcePath: String, sourceLocation: String,
                                 document: [UInt16], range: Range<Int>, documentOffset: Int = 0) {
        adapter.beginRefresh()
        guard let context = adapter.focusedContext() else {
            AssistLog.write("  ✗ host lost before the reference could be stored")
            return
        }
        guard let anchor = TextAnchor.make(in: document, range: range,
                                           documentOffset: documentOffset) else {
            AssistLog.write("  ✗ verified range could not be anchored")
            return
        }
        let colorSlot = sourceColorSlot(path: sourcePath, objectId: objectId,
                                       projectId: projectId, in: context)
        let reference = DependencyReference(
            id: "ref_" + UUID().uuidString.prefix(8),
            objectId: objectId, versionId: versionId, projectId: projectId,
            hostBundleIdentifier: context.bundleIdentifier,
            hostApplication: context.applicationName,
            documentContext: context.documentContext,
            anchor: anchor, state: .healthy,
            label: label, valueText: valueText,
            sourcePath: sourcePath, sourceLocation: sourceLocation,
            sourceColorSlot: colorSlot,
            createdAt: Date(), updatedAt: Date())
        store.add(reference)
        AssistLog.write("  ✓ dependency reference stored [\(reference.id)] → “\(anchor.text)”")
        let documentRange = (documentOffset + range.lowerBound)..<(documentOffset + range.upperBound)
        reportGeometry(for: reference, in: context, range: documentRange)
        scheduleRefresh()
    }

    /// Stage C, reported separately so a geometry failure is never mistaken for
    /// an insertion or anchoring failure.
    private func reportGeometry(for reference: DependencyReference,
                                in context: HostContext, range: Range<Int>) {
        let rects = adapter.rects(for: range, in: context)
        if rects.isEmpty {
            AssistLog.write("  ✗ geometry unavailable in \(context.applicationName) — highlight not rendered")
        } else {
            AssistLog.write("  ✓ geometry: \(rects.count) rect(s), first \(Int(rects[0].minX)),\(Int(rects[0].minY))")
        }
    }

    func unlink(id: String) {
        store.remove(id: id)
        scheduleRefresh()
    }

    func reference(id: String) -> DependencyReference? { store.reference(id: id) }

    /// Older builds did not store a work-directory owner and sometimes stored
    /// a human breadcrumb in sourcePath. Resolve ownership through the object
    /// API so files with identical relative paths cannot borrow another
    /// directory's color. Known owners already carry the canonical file path.
    private func migrateStoredSourcePaths() {
        guard let serverURL else { return }
        let legacyObjectIds = Set(store.references.filter {
            $0.projectId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
        }.map(\.objectId))
        for objectId in legacyObjectIds {
            guard migratingObjectIds.insert(objectId).inserted else { continue }
            let url = serverURL
                .appendingPathComponent("api/dependency-objects")
                .appendingPathComponent(objectId)
            URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
                let root = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                let object = root?["object"] as? [String: Any]
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.migratingObjectIds.remove(objectId)
                    guard self.serverURL == serverURL,
                          (response as? HTTPURLResponse)?.statusCode == 200,
                          let object,
                          let projectId = object["projectId"] as? String,
                          !projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    let path = (object["path"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    let references = self.store.references.filter {
                        $0.objectId == objectId
                            && $0.projectId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
                    }
                    self.store.batchUpdates {
                        for reference in references {
                            self.store.update(id: reference.id) {
                                $0.projectId = projectId
                                if let path, !path.isEmpty, $0.sourcePath != path {
                                    $0.sourcePath = path
                                    $0.sourceColorSlot = nil
                                }
                            }
                            self.normalizeSourceColorSlots(
                                documentContext: reference.documentContext,
                                bundleIdentifier: reference.hostBundleIdentifier)
                            AssistLog.write("highlight: restored source directory for \(reference.id)")
                        }
                    }
                    self.scheduleRefresh()
                }
            }.resume()
        }
    }


    private func sourceKey(path: String, objectId: String, projectId: String?) -> String {
        let fileKey = AssistSourceIdentity.key(path: path, objectId: objectId)
        guard let projectId, !projectId.isEmpty else { return fileKey }
        return "project:\(projectId)|\(fileKey)"
    }

    /// FNV-1a is deterministic across launches; Swift's Hashable seed is not.
    private func stableSourceColorSlot(_ key: String) -> Int {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in key.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return Int(hash % UInt64(DependencyStyle.sourceColorCount))
    }

    private func sourceColorSlot(path: String, objectId: String, projectId: String?, in context: HostContext) -> Int {
        let key = sourceKey(path: path, objectId: objectId, projectId: projectId)
        let existing = store.references(forContext: context.documentContext,
                                        bundleIdentifier: context.bundleIdentifier)
        if let sameSource = existing.first(where: {
            sourceKey(path: $0.sourcePath, objectId: $0.objectId, projectId: $0.projectId) == key
        }) {
            return sameSource.sourceColorSlot ?? stableSourceColorSlot(key)
        }
        let occupied = Set(existing.map {
            $0.sourceColorSlot ?? stableSourceColorSlot(
                sourceKey(path: $0.sourcePath, objectId: $0.objectId, projectId: $0.projectId))
        })
        return (0..<DependencyStyle.sourceColorCount).first(where: { !occupied.contains($0) })
            ?? stableSourceColorSlot(key)
    }

    private func normalizeSourceColorSlots(documentContext: String, bundleIdentifier: String) {
        let references = store.references(forContext: documentContext,
                                          bundleIdentifier: bundleIdentifier)
        let keyed = references.map {
            (key: sourceKey(path: $0.sourcePath, objectId: $0.objectId, projectId: $0.projectId),
             preferred: $0.sourceColorSlot)
        }
        let assignments = AssistSourceIdentity.colorAssignments(
            keyed, paletteCount: DependencyStyle.sourceColorCount,
            fallback: stableSourceColorSlot)
        for reference in references {
            let key = sourceKey(path: reference.sourcePath, objectId: reference.objectId,
                                projectId: reference.projectId)
            guard let slot = assignments[key], reference.sourceColorSlot != slot else { continue }
            store.update(id: reference.id) { $0.sourceColorSlot = slot }
        }
    }

    private func normalizeSourceColorSlots(in context: HostContext) {
        normalizeSourceColorSlots(documentContext: context.documentContext,
                                  bundleIdentifier: context.bundleIdentifier)
    }

    // MARK: Refresh

    private func scheduleRefresh() {
        updatePolling()
        guard hasRelevantHost else { hide(); resolutions.clear(); return }
        guard !scheduled else { return }
        scheduled = true
        let delay = max(0.04, 0.25 - Date().timeIntervalSince(lastRefresh))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.scheduled = false
            self?.refresh()
        }
    }

    private func refresh() {
        guard hasRelevantHost else { hide(); return }
        guard AXIsProcessTrusted() else { hide(); return }
        lastRefresh = Date()
        adapter.beginRefresh()
        guard let context = adapter.focusedContext() else { hide(); return }
        observe(context)
        store.batchUpdates { normalizeSourceColorSlots(in: context) }

        // Only this document's references, never another window's.
        let references = store.references(forContext: context.documentContext,
                                          bundleIdentifier: context.bundleIdentifier)
        guard !references.isEmpty else { hide(); return }
        guard let document = adapter.documentText(context) else { hide(); return }

        let matches = resolutions.resolve(references, in: document)
        var found: [DependencyGeometry] = []
        var states: [String: DependencyVisualState] = [:]
        var sourceSlots: [String: Int] = [:]
        var directoryColors: [String: DirectoryToggleColor] = [:]

        store.batchUpdates {
            for reference in references {
                guard let match = matches[reference.id] else { continue }
                switch match {
                case .unresolved(let reason):
                    // The phrase is gone or cannot be told apart: never draw a guess.
                    if reason == .textMissing {
                        store.remove(id: reference.id)   // no ghost highlights
                        AssistLog.write("highlight: \(reference.id) text deleted; reference dropped")
                    } else if reference.state != .unresolved {
                        store.update(id: reference.id) { $0.state = .unresolved }
                    }
                case .resolved(let range):
                    if reference.state == .unresolved {
                        store.update(id: reference.id) { $0.state = .healthy }
                    }
                    states[reference.id] = reference.state == .unresolved ? .healthy : reference.state
                    sourceSlots[reference.id] = reference.sourceColorSlot
                        ?? stableSourceColorSlot(sourceKey(path: reference.sourcePath, objectId: reference.objectId,
                                                           projectId: reference.projectId))
                    directoryColors[reference.id] = DirectoryColorPreferences.color(for: reference.projectId)
                    let rects = adapter.rects(for: range, in: context)
                    guard !rects.isEmpty else { continue }
                    let converted = rects.map {
                        HostGeometryConverter.toAppKit($0, primaryHeight: Self.primaryHeight())
                    }
                    found.append(DependencyGeometry.coalesce(converted, referenceId: reference.id))
                }
            }
        }

        updatePolling()
        guard !found.isEmpty else { hide(); return }
        let unchanged = currentContext == context && geometries == found
            && view.states == states && view.sourceSlots == sourceSlots
            && view.directoryColors == directoryColors && panel.isVisible
        currentContext = context
        guard !unchanged else { return }
        geometries = found
        view.geometries = found
        view.states = states
        view.sourceSlots = sourceSlots
        view.directoryColors = directoryColors

        // The panel covers only what it needs to.
        let union = found.dropFirst().reduce(found[0].bounds) { $0.union($1.bounds) }
        panel.setFrame(union.insetBy(dx: -6, dy: -6), display: true)
        view.panelFrame = panel.frame
        view.frame = NSRect(origin: .zero, size: panel.frame.size)
        view.needsDisplay = true
        panel.orderFrontRegardless()
    }

    private func hide() {
        guard !geometries.isEmpty || panel.isVisible else { return }
        geometries = []
        view.geometries = []
        view.sourceSlots = [:]
        view.directoryColors = [:]
        panel.orderOut(nil)
    }

    private static func primaryHeight() -> CGFloat {
        HostGeometryConverter.primaryHeight(NSScreen.screens.map { $0.frame })
    }

    // MARK: Interaction

    private func handleHover(_ point: NSPoint) {
        guard panel.isVisible else { return }
        let hovered = geometries.first { $0.contains(point) }?.referenceId
        guard hovered != view.hoveredId else { return }
        view.hoveredId = hovered
        view.needsDisplay = true
    }

    private func handleClick(_ point: NSPoint) {
        guard panel.isVisible,
              let hit = geometries.first(where: { $0.contains(point) }),
              let reference = store.reference(id: hit.referenceId) else { return }
        onInspect?(reference, hit.bounds)
    }
}
