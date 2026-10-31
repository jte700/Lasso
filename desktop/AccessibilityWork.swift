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

/// How long a shown list may wait for an answer once the writer types on.
/// A slow host drops every read that typing overtakes, so without this the
/// list found for earlier words would stay up for as long as typing goes on.
/// Used from the main thread only.
struct UnansweredTyping {
    let limit: TimeInterval
    private var since: Date?

    init(limit: TimeInterval) {
        self.limit = limit
    }

    /// When the list should close: returned for the first key over it only,
    /// so steady typing does not keep putting the close off.
    mutating func typed(at now: Date) -> Date? {
        guard since == nil else { return nil }
        since = now
        return now.addingTimeInterval(limit)
    }

    /// An answer arrived, or the list closed: the next key starts a new wait.
    mutating func answered() {
        since = nil
    }
}
