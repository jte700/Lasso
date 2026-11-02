//  The element that really holds the caret, when the host reports a pane instead.

import ApplicationServices

/// Word 16.114 reports the document pane (an AXSplitGroup) as the focused
/// element. The text area with the caret is several groups below it and marks
/// itself focused, so the search walks down from what the host reported.
enum FocusedTextElement {
    /// Word's text area is about eight levels below the pane, behind a few
    /// dozen scroll bars and groups; this leaves room without walking a
    /// whole window when focus is on something that holds no text.
    static let maxVisits = 200
    static let messagingTimeout: Float = 0.2

    /// Breadth first, so the nearest focused text wins.
    static func search<Node>(from root: Node, children: (Node) -> [Node], isFocusedText: (Node) -> Bool,
                             maxVisits: Int = maxVisits) -> Node? {
        var queue = [root]
        var index = 0
        while index < queue.count, index < maxVisits {
            let node = queue[index]
            if isFocusedText(node) { return node }
            queue += children(node)
            index += 1
        }
        return nil
    }

    /// The reported element when it already has a caret, otherwise the
    /// focused text element below it, otherwise the reported element.
    static func resolve(_ reported: AXUIElement) -> AXUIElement {
        if hasCaret(reported) { return reported }
        return search(from: reported, children: children(of:), isFocusedText: { element in
            hasCaret(element) && (attribute(element, kAXFocusedAttribute as String) as? Bool) == true
        }) ?? reported
    }

    private static func hasCaret(_ element: AXUIElement) -> Bool {
        guard let range = attribute(element, kAXSelectedTextRangeAttribute as String) else { return false }
        return CFGetTypeID(range) == AXValueGetTypeID()
    }

    private static func children(of element: AXUIElement) -> [AXUIElement] {
        attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(element, messagingTimeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
}
