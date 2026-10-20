//  Where Accessibility reads run.
//
//  Every Accessibility call is a synchronous message to another app, which can
//  take as long as that app's messaging timeout. Repeated reads (suggestions,
//  popup tracking, highlights) therefore run on one serial background queue,
//  and their results are applied on the main thread only if nothing newer
//  happened meanwhile. Accepting a suggestion reads and writes there too; once
//  it has begun writing, it always finishes and reports.

import Foundation

enum AccessibilityWork {
    static let queue = DispatchQueue(label: "com.jte700.lasso.accessibility", qos: .userInitiated)
}

/// Keeps at most one read of a kind running and remembers a single follow-up,
/// so a slow host costs one outstanding read rather than a growing backlog.
/// Used from the main thread only.
struct CoalescingGate {
    private(set) var isRunning = false
    private var isPending = false

    /// True when the caller should start a read now. Otherwise the request is
    /// remembered for when the running read ends.
    mutating func begin() -> Bool {
        guard !isRunning else {
            isPending = true
            return false
        }
        isRunning = true
        return true
    }

    /// Ends the running read. True when a request arrived meanwhile, which the
    /// caller should now start again through `begin()`.
    mutating func end() -> Bool {
        isRunning = false
        defer { isPending = false }
        return isPending
    }

    /// Forgets a follow-up request, as when the result is no longer wanted.
    mutating func dropPending() {
        isPending = false
    }
}
