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

    /// Whether this queue may read an app's windows. Never Lasso's own: macOS
    /// answers a process's reads of itself on the thread that asks, so a read
    /// made here would run AppKit and SwiftUI off the main thread, where an
    /// exception they throw is swallowed with SwiftUI's lock still held and
    /// the app freezes. Typing in The Loop's search bar did exactly this.
    static func mayRead(pid: pid_t, own: pid_t = ProcessInfo.processInfo.processIdentifier) -> Bool {
        pid > 0 && pid != own
    }
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

/// When the card reads the caret after a key. The key reaches Lasso before
/// the app has moved its caret, so a read at once finds the old place: it
/// waits a frame for the app to draw. Each key puts the read off to a frame
/// after itself, but keys that keep coming never put it off past `longest`.
/// Used from the main thread only.
struct CaretFollowTiming {
    /// About one frame: long enough for the app to draw the key it was sent.
    static let echo: TimeInterval = 0.016
    /// The most a stream of keys may hold a read back.
    static let longest: TimeInterval = 0.05
    private var waitingSince: Date?

    /// How long from `now` to read the caret for the key that just arrived.
    mutating func keyArrived(at now: Date) -> TimeInterval {
        let since = waitingSince ?? now
        waitingSince = since
        let left = since.addingTimeInterval(Self.longest).timeIntervalSince(now)
        return max(0, min(Self.echo, left))
    }

    /// The caret was read: the next key starts a new wait.
    mutating func read() {
        waitingSince = nil
    }
}
