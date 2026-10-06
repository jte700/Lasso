//  Keeps local dependency highlights attached to the right words.
//
//  On every relevant event — not on a timer — the highlighter re-reads the
//  focused surface, relocates each reference by its anchor, measures the range,
//  and repaints. References that cannot be located confidently are marked
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

    private let adapter: HostTextAdapter = AccessibilityTextAdapter()
    private let store: DependencyReferenceStore
    private let view = OverlayView()
    private lazy var panel = OverlayPanel(view: view)
    private var currentContext: HostContext?
    private var geometries: [DependencyGeometry] = []
    private var scheduled = false
    private var monitors: [Any] = []

    var isDebugging = false {
        didSet { view.debug = isDebugging; refresh() }
    }

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Lasso", isDirectory: true)
        store = DependencyReferenceStore(url: support.appendingPathComponent("references.json"))
    }

    // MARK: Lifecycle

    func start() {
        // Event driven: application switches, plus a low-frequency settle timer
        // for window movement and scrolling, which many hosts do not announce.
        let centre = NSWorkspace.shared.notificationCenter
        monitors.append(centre.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                self?.scheduleRefresh()
            })
        monitors.append(centre.addObserver(
            forName: NSWorkspace.didDeactivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                self?.hide()
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

        Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { [weak self] _ in
            self?.scheduleRefresh()
        }
    }

    /// Stage B. Records a reference from an already-verified range: the caller
    /// has proved these characters are the accepted phrase, so no searching or
    /// guessing happens here.
    func recordVerifiedInsertion(objectId: String, versionId: String?, label: String,
                                 valueText: String?, sourcePath: String, sourceLocation: String,
                                 document: [UInt16], range: Range<Int>, documentOffset: Int = 0) {
        guard let context = adapter.focusedContext() else {
            AssistLog.write("  ✗ host lost before the reference could be stored")
            return
        }
        guard let anchor = TextAnchor.make(in: document, range: range,
                                           documentOffset: documentOffset) else {
            AssistLog.write("  ✗ verified range could not be anchored")
            return
        }
        let colorSlot = sourceColorSlot(path: sourcePath, objectId: objectId, in: context)
        let reference = DependencyReference(
            id: "ref_" + UUID().uuidString.prefix(8),
            objectId: objectId, versionId: versionId,
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

    /// Pre-color builds stored the human breadcrumb in sourcePath. Resolve each
    /// indexed object through the local-only API and repair it to the owning
    /// file path. Nothing leaves the machine and unresolved objects are kept.
    private func migrateStoredSourcePaths() {
        guard let serverURL else { return }
        for reference in store.references {
            let url = serverURL
                .appendingPathComponent("api/dependency-objects")
                .appendingPathComponent(reference.objectId)
            URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
                guard let self, let data,
                      (response as? HTTPURLResponse)?.statusCode == 200,
                      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let object = root["object"] as? [String: Any],
                      let path = object["path"] as? String,
                      !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                DispatchQueue.main.async {
                    guard let current = self.store.reference(id: reference.id) else { return }
                    if current.sourcePath != path {
                        self.store.update(id: reference.id) {
                            $0.sourcePath = path
                            $0.sourceColorSlot = nil
                        }
                        AssistLog.write("highlight: repaired source identity for \(reference.id) → \(path)")
                    }
                    self.normalizeSourceColorSlots(
                        documentContext: current.documentContext,
                        bundleIdentifier: current.hostBundleIdentifier)
                    self.scheduleRefresh()
                }
            }.resume()
        }
    }


    private func sourceKey(path: String, objectId: String) -> String {
        AssistSourceIdentity.key(path: path, objectId: objectId)
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

    private func sourceColorSlot(path: String, objectId: String, in context: HostContext) -> Int {
        let key = sourceKey(path: path, objectId: objectId)
        let existing = store.references(forContext: context.documentContext,
                                        bundleIdentifier: context.bundleIdentifier)
        if let sameSource = existing.first(where: {
            sourceKey(path: $0.sourcePath, objectId: $0.objectId) == key
        }) {
            return sameSource.sourceColorSlot ?? stableSourceColorSlot(key)
        }
        let occupied = Set(existing.map {
            $0.sourceColorSlot ?? stableSourceColorSlot(
                sourceKey(path: $0.sourcePath, objectId: $0.objectId))
        })
        return (0..<DependencyStyle.sourceColorCount).first(where: { !occupied.contains($0) })
            ?? stableSourceColorSlot(key)
    }

    private func normalizeSourceColorSlots(documentContext: String, bundleIdentifier: String) {
        let references = store.references(forContext: documentContext,
                                          bundleIdentifier: bundleIdentifier)
        let keyed = references.map {
            (key: sourceKey(path: $0.sourcePath, objectId: $0.objectId),
             preferred: $0.sourceColorSlot)
        }
        let assignments = AssistSourceIdentity.colorAssignments(
            keyed, paletteCount: DependencyStyle.sourceColorCount,
            fallback: stableSourceColorSlot)
        for reference in references {
            let key = sourceKey(path: reference.sourcePath, objectId: reference.objectId)
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
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in
            self?.scheduled = false
            self?.refresh()
        }
    }

    private func refresh() {
        guard AXIsProcessTrusted() else { hide(); return }
        guard let context = adapter.focusedContext() else { hide(); return }
        normalizeSourceColorSlots(in: context)

        // Only this document's references, never another window's.
        let references = store.references(forContext: context.documentContext,
                                          bundleIdentifier: context.bundleIdentifier)
        guard !references.isEmpty else { hide(); return }
        guard let document = adapter.documentText(context) else { hide(); return }

        let units = Array(document.utf16)
        var found: [DependencyGeometry] = []
        var states: [String: DependencyVisualState] = [:]
        var sourceSlots: [String: Int] = [:]

        for reference in references {
            switch TextAnchorResolver.resolve(reference.anchor, in: units) {
            case .unresolved(let reason):
                // The phrase is gone or cannot be told apart: never draw a guess.
                if reason == .textMissing {
                    store.remove(id: reference.id)   // no ghost highlights
                    AssistLog.write("highlight: \(reference.id) text deleted; reference dropped")
                } else {
                    store.update(id: reference.id) { $0.state = .unresolved }
                }
            case .resolved(let range):
                if reference.state == .unresolved {
                    store.update(id: reference.id) { $0.state = .healthy }
                }
                states[reference.id] = reference.state == .unresolved ? .healthy : reference.state
                sourceSlots[reference.id] = reference.sourceColorSlot
                    ?? stableSourceColorSlot(sourceKey(path: reference.sourcePath, objectId: reference.objectId))
                let rects = adapter.rects(for: range, in: context)
                guard !rects.isEmpty else { continue }
                let converted = rects.map {
                    HostGeometryConverter.toAppKit($0, primaryHeight: Self.primaryHeight())
                }
                found.append(DependencyGeometry.coalesce(converted, referenceId: reference.id))
            }
        }

        guard !found.isEmpty else { hide(); return }
        currentContext = context
        geometries = found
        view.geometries = found
        view.states = states
        view.sourceSlots = sourceSlots

        // The panel covers only what it needs to.
        let union = found.dropFirst().reduce(found[0].bounds) { $0.union($1.bounds) }
        panel.setFrame(union.insetBy(dx: -6, dy: -6), display: true)
        view.panelFrame = panel.frame
        view.frame = NSRect(origin: .zero, size: panel.frame.size)
        view.needsDisplay = true
        panel.orderFrontRegardless()
    }

    private func hide() {
        geometries = []
        view.geometries = []
        view.sourceSlots = [:]
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
