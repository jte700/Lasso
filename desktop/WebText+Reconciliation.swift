//  Reconciling a web editor's AXValue against live markers and DOM text leaves.
//
//  Rich contenteditable editors in Chromium and Electron (such as Lexical and
//  ProseMirror) can keep a stale AXValue after the user deletes text and leaves
//  an empty block such as `<p><br></p>`. Comparing AXValue against live element
//  markers and AXStaticText leaves prevents ghost highlights over empty fields
//  or placeholder text without altering native controls.

import Cocoa
import ApplicationServices

extension WebTextReader {
    /// True when `element` belongs to browser or Electron web content rather
    /// than a native AppKit control. Checks cheap element-local web attributes
    /// before walking parents so native editors pay minimal overhead.
    static func isWebElement(_ element: AXUIElement) -> Bool {
        if attribute(element, kAXRoleAttribute as String) as? String == "AXWebArea" { return true }
        if attribute(element, "AXDOMClassList") != nil
            || attribute(element, "AXDOMIdentifier") != nil
            || attribute(element, selectedRange) != nil {
            return true
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 0.015
        return webArea(from: element, before: deadline) != nil
    }

    /// Live DOM text state of a web element's own subtree, separate from AXValue.
    struct ContentEditableLeafState: Equatable {
        /// True when the element lives inside web content and has non-scrollbar
        /// child nodes (as contenteditable editors do), unlike native controls
        /// or plain `<input>`/`<textarea>` fields.
        let hasContentChildren: Bool
        /// Every AXStaticText leaf value in the subtree when the walk finished
        /// within budget and encountered no nested editor or unreadable leaf.
        let leafTexts: [String]?
    }

    /// How an element's AXValue reconciles with live browser markers and DOM leaves.
    enum TextValueReconciliation: Equatable {
        /// AXValue matches the live editor content and defines element index space.
        case use(String)
        /// Live markers or DOM leaves prove the editor is empty.
        case empty
        /// AXValue disagrees with the live editor content; prefer `liveText`.
        case stale(liveText: String?)
    }

    /// Normalizes non-breaking spaces, line breaks, zero-width placeholders and
    /// object replacement characters so live web text can be compared against
    /// AXValue without false mismatches from HTML whitespace formatting.
    static func canonicalWebText(_ text: String) -> String {
        var result = ""
        var previousSpace = false
        for scalar in text.unicodeScalars {
            if scalar.value == 0xFFFC || scalar.value == 0x200B || scalar.value == 0xFEFF { continue }
            if CharacterSet.whitespacesAndNewlines.contains(scalar)
                || scalar.value == 0x00A0 || scalar.value == 0x2007 || scalar.value == 0x202F {
                if !result.isEmpty { previousSpace = true }
                continue
            }
            if previousSpace {
                result.append(" ")
                previousSpace = false
            }
            result.unicodeScalars.append(scalar)
        }
        return result
    }

    /// Reconciles an editor's reported AXValue against placeholder text,
    /// element-scoped text markers, and live contenteditable text leaves.
    static func reconcileTextValue(axValue: String,
                                   placeholder: String?,
                                   markerText: String?,
                                   leaves: ContentEditableLeafState?) -> TextValueReconciliation {
        let canonicalValue = canonicalWebText(axValue)
        if canonicalValue.isEmpty { return .use(axValue) }

        let canonicalPlaceholder = placeholder.map(canonicalWebText)
        let matchesPlaceholder = canonicalPlaceholder.map { !$0.isEmpty && $0 == canonicalValue } ?? false

        if let markerText {
            let canonicalMarker = canonicalWebText(markerText)
            if canonicalMarker.isEmpty { return .empty }
            if let canonicalPlaceholder, !canonicalPlaceholder.isEmpty, canonicalMarker == canonicalPlaceholder {
                return .empty
            }
            if canonicalMarker != canonicalValue {
                return .stale(liveText: markerText)
            }
        }

        if let leaves, leaves.hasContentChildren, let leafTexts = leaves.leafTexts {
            let joinedLeaves = leafTexts.joined(separator: "\n")
            let canonicalLeaves = canonicalWebText(joinedLeaves)
            if canonicalLeaves.isEmpty { return .empty }
            if let canonicalPlaceholder, !canonicalPlaceholder.isEmpty, canonicalLeaves == canonicalPlaceholder {
                return .empty
            }
            let allLeavesInValue = leafTexts.allSatisfy { leaf in
                let piece = canonicalWebText(leaf)
                return piece.isEmpty || canonicalValue.contains(piece)
            }
            if !allLeavesInValue {
                return .stale(liveText: joinedLeaves)
            }
        }

        if matchesPlaceholder && (markerText != nil || leaves?.hasContentChildren == true) {
            return .empty
        }

        return .use(axValue)
    }

    /// True when live web evidence (element marker text or complete contenteditable
    /// leaves) does not contradict the presence of `phrase`.
    static func liveWebTextContains(phrase: String,
                                    markerText: String?,
                                    leaves: ContentEditableLeafState?) -> Bool {
        let target = canonicalWebText(phrase)
        guard !target.isEmpty else { return false }
        if let markerText {
            let canonicalMarker = canonicalWebText(markerText)
            if canonicalMarker.isEmpty || !canonicalMarker.contains(target) { return false }
        }
        if let leaves, leaves.hasContentChildren, let leafTexts = leaves.leafTexts {
            let joinedTight = canonicalWebText(leafTexts.joined())
            let joinedSpaced = canonicalWebText(leafTexts.joined(separator: " "))
            if (joinedTight.isEmpty && joinedSpaced.isEmpty)
                || (!joinedTight.contains(target) && !joinedSpaced.contains(target)) {
                return false
            }
        }
        return true
    }

    /// Inspects whether `element` is a web contenteditable container with DOM
    /// children and collects its live AXStaticText leaves within a short budget.
    static func contentEditableLeafState(of element: AXUIElement) -> ContentEditableLeafState {
        let deadline = ProcessInfo.processInfo.systemUptime + 0.040
        let role = attribute(element, kAXRoleAttribute as String) as? String
        guard role != "AXWebArea", role != "AXTextField" else {
            return ContentEditableLeafState(hasContentChildren: false, leafTexts: nil)
        }
        guard let topChildren = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement],
              !topChildren.isEmpty else {
            return ContentEditableLeafState(hasContentChildren: false, leafTexts: nil)
        }
        guard isWebElement(element) else {
            return ContentEditableLeafState(hasContentChildren: false, leafTexts: nil)
        }
        let contentChildren = topChildren.filter {
            (attribute($0, kAXRoleAttribute as String) as? String) != "AXScrollBar"
        }
        guard !contentChildren.isEmpty else {
            return ContentEditableLeafState(hasContentChildren: false, leafTexts: nil)
        }
        var leaves: [String] = []
        var visited = 0
        let nestedEditors: Set<String> = ["AXTextField", "AXTextArea", "AXWebArea", "AXComboBox"]
        func collect(_ node: AXUIElement, depth: Int) -> Bool {
            visited += 1
            guard visited <= 1_500, depth <= 40, hasTime(before: deadline) else { return false }
            let nodeRole = attribute(node, kAXRoleAttribute as String) as? String
            if let nodeRole, nestedEditors.contains(nodeRole) { return false }
            if nodeRole == kAXStaticTextRole as String {
                guard let value = attribute(node, kAXValueAttribute as String) as? String else { return false }
                if !value.isEmpty { leaves.append(value) }
                return true
            }
            if nodeRole == "AXScrollBar" { return true }
            for child in attribute(node, kAXChildrenAttribute as String) as? [AXUIElement] ?? [] {
                if !collect(child, depth: depth + 1) { return false }
            }
            return true
        }
        for child in contentChildren {
            if !collect(child, depth: 1) {
                return ContentEditableLeafState(hasContentChildren: true, leafTexts: nil)
            }
        }
        return ContentEditableLeafState(hasContentChildren: true, leafTexts: leaves)
    }
}
