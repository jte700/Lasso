// A suggested value's recent change, as the server reports it in a
// suggestion's optional `change` field, and the one line the card shows for
// it in the row's dim detail slot. Nothing else on the card changes.

import Foundation

struct AssistValueChange: Equatable {
    enum Kind: String {
        case edited, recalculated
        /// The writer typed the value as it was before the change.
        case staleTyped = "stale-typed"
    }

    let kind: Kind
    let previousValue: String
    let currentValue: String
    let changedAt: String?
    let snapshotId: String?
    /// The values as a worksheet shows them ("18,400"), when the server says they differ from the stored ones.
    var previousDisplay: String? = nil
    var currentDisplay: String? = nil

    /// The earlier value as the row writes it.
    var previousShown: String { previousDisplay ?? previousValue }

    /// Reads the server's field, or nil when it is absent or malformed. Unknown kinds are ignored.
    init?(json: Any?) {
        guard let fields = json as? [String: Any],
              let kind = (fields["kind"] as? String).flatMap(Kind.init(rawValue:)),
              let previous = fields["previousValue"] as? String, !previous.isEmpty,
              let current = fields["currentValue"] as? String, !current.isEmpty else { return nil }
        self.kind = kind
        previousValue = previous
        currentValue = current
        changedAt = fields["changedAt"] as? String
        snapshotId = fields["snapshotId"] as? String
        previousDisplay = (fields["previousDisplay"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        currentDisplay = (fields["currentDisplay"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    init(kind: Kind, previousValue: String, currentValue: String, changedAt: String? = nil, snapshotId: String? = nil) {
        self.kind = kind
        self.previousValue = previousValue
        self.currentValue = currentValue
        self.changedAt = changedAt
        self.snapshotId = snapshotId
    }

    /// The row's dim detail with the change in it: "19,250 · was 18,400", or
    /// for a typed earlier value "changed from 18,400". A detail that is not
    /// the value itself is kept in front of it.
    func detail(replacing detail: String) -> String {
        switch kind {
        case .staleTyped:
            return "changed from \(previousShown)"
        case .edited, .recalculated:
            let shown = detail.trimmingCharacters(in: .whitespaces)
            let value = shown.isEmpty || shown == currentValue || shown == currentDisplay ? currentDisplay ?? currentValue : shown
            return "\(value) · was \(previousShown)"
        }
    }
}
