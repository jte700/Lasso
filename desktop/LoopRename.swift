import Foundation

/// Lasso's library window was called The Ranch until 2026-11-25. Its saved
/// choices (the tour finished, the sidebar's width, orders, pins, recent
/// searches) were kept under keys beginning "Ranch". They move to "Loop" once,
/// at launch, so the new name neither replays the tour nor forgets a layout.
enum LoopRename {
    static let oldPrefix = "Ranch"
    static let newPrefix = "Loop"

    /// Moves every "Ranch…" choice to its "Loop…" key. A choice already made
    /// under the new name wins; the old key goes either way.
    static func carryOver(_ defaults: UserDefaults = .standard) {
        let oldKeys = defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(oldPrefix) }
        for key in oldKeys {
            let newKey = newPrefix + key.dropFirst(oldPrefix.count)
            if defaults.object(forKey: newKey) == nil, let value = defaults.object(forKey: key) {
                defaults.set(value, forKey: newKey)
            }
            defaults.removeObject(forKey: key)
        }
    }

    /// Copies of files Lasso fetched for the window were cached under
    /// Caches/Lasso/Ranch; they are fetched again under Caches/Lasso/Loop.
    static func removeOldCache(_ files: FileManager = .default) {
        guard let caches = files.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        let old = caches.appendingPathComponent("Lasso/\(oldPrefix)", isDirectory: true)
        guard files.fileExists(atPath: old.path) else { return }
        do { try files.removeItem(at: old) }
        catch { NSLog("Lasso could not remove the old window cache at %@: %@", old.path, error.localizedDescription) }
    }
}
