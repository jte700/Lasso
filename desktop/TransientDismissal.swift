import Cocoa

/// Escape closes transient UI only. Each owner supplies a non-mutating dismiss
/// action rather than invoking its cancel, accept, unlink or copy controls.
final class LassoTransientUI {
    static let shared = LassoTransientUI()
    private struct Entry {
        weak var owner: AnyObject?
        let priority: Int
        let isOpen: () -> Bool
        let dismiss: () -> Void
    }
    private var entries: [Entry] = []
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var dismissing = false

    func register(_ owner: AnyObject, priority: Int = 0,
                  isOpen: @escaping () -> Bool, dismiss: @escaping () -> Void) {
        entries.removeAll { $0.owner == nil || $0.owner === owner }
        entries.append(Entry(owner: owner, priority: priority, isOpen: isOpen, dismiss: dismiss))
    }

    func start() {
        if localMonitor == nil {
            localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard event.keyCode == 53,
                      event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
                      self?.dismissAll() == true else { return event }
                return nil
            }
        }
        // Nonactivating panels keep the editor in another app focused. This
        // fallback remains available when suggestions/the event tap are off.
        if globalMonitor == nil {
            globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
                if event.keyCode == 53,
                   event.modifierFlags.intersection([.command, .control, .option]).isEmpty {
                    _ = self?.dismissAll()
                }
            }
        }
    }

    func stop() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        localMonitor = nil; globalMonitor = nil
    }

    /// Whether Escape would close anything, without closing it. Main thread.
    var hasOpenSurface: Bool {
        entries.contains { $0.owner != nil && $0.isOpen() }
    }

    @discardableResult
    func dismissAll() -> Bool {
        guard !dismissing else { return false }
        entries.removeAll { $0.owner == nil }
        let open = entries.filter { $0.isOpen() }.sorted { $0.priority > $1.priority }
        guard !open.isEmpty else { return false }
        dismissing = true
        defer { dismissing = false }
        for entry in open where entry.owner != nil { entry.dismiss() }
        return true
    }
}
