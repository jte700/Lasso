//  Taking back what Tab or an inserted link put in, with ⌘Z.
//
//  Not every host puts an Accessibility write on its own undo stack, and in
//  one that does not, ⌘Z would undo the typing behind the insertion instead.
//  So Lasso keeps the last insertion it verified and takes it back itself,
//  only while it is the last change in the field and its text is still there.

import ApplicationServices
import Foundation

struct AcceptedInsertion {
    let element: AXUIElement
    /// Where the inserted text ends, which is where the host left the caret.
    let caret: Int
    let inserted: String
    /// What the insertion replaced: the part of the word that was typed.
    let replaced: String
    /// A linked insertion's share, revoked once its link is taken back.
    var share: DependencyShare? = nil
    var serverURL: URL? = nil
    /// The highlight recorded for the inserted source.
    var referenceId: String? = nil

    /// The edit that puts back what was typed, planned against the text
    /// before the caret now. Nil once the caret has moved or the inserted
    /// text was changed, when the host's own undo is the one that applies.
    func revertPlan(windowStart: Int, text: [UInt16], caret: Int) -> CompletionPlan? {
        let units = Array(inserted.utf16)
        guard caret == self.caret, windowStart + text.count == caret,
              !units.isEmpty, text.count >= units.count else { return nil }
        let tail = Array(text.suffix(units.count))
        guard CompletionTransaction.equivalentHostText(tail, units) else { return nil }
        return CompletionPlan(range: (text.count - units.count)..<text.count,
                              expectedPrefix: String(decoding: tail, as: UTF16.self), insertText: replaced)
    }
}
