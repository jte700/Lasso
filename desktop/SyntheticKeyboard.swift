//  Synthesized keystrokes.
//
//  Events are tagged so the application's own keyboard tap can tell them apart
//  from real typing, and posted at the HID level, which is what unfocused rich
//  editors such as Gmail's compose box accept most reliably.

import Cocoa

enum SyntheticKeyboard {
    /// Marks events this app generated, so the tap ignores its own output.
    static let marker: Int64 = 0x0C01AB

    private static func source() -> CGEventSource? {
        // A private state avoids inheriting modifier keys the user is holding —
        // Tab is still physically down when an insertion begins.
        let source = CGEventSource(stateID: .privateState)
        source?.setLocalEventsFilterDuringSuppressionState(
            [.permitLocalKeyboardEvents, .permitLocalMouseEvents, .permitSystemDefinedEvents],
            state: .eventSuppressionStateSuppressionInterval)
        return source
    }

    private static func post(_ event: CGEvent?) {
        guard let event else { return }
        event.flags = []
        event.setIntegerValueField(.eventSourceUserData, value: marker)
        event.post(tap: .cghidEventTap)
    }

    static func deleteBackwards(_ count: Int) {
        guard count > 0 else { return }
        let source = source()
        for _ in 0..<count {
            post(CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: true))
            post(CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: false))
            Thread.sleep(forTimeInterval: 0.004)
        }
    }

    /// Types text as unicode key events, which works regardless of layout.
    static func type(_ text: String) {
        let source = source()
        for chunk in text.chunkedForTyping(16) {
            var buffer = Array(chunk.utf16)
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { continue }
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: &buffer)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: &buffer)
            post(down)
            post(up)
            Thread.sleep(forTimeInterval: 0.006)
        }
    }

    static func paste() {
        let source = source()
        let vKey: CGKeyCode = 9
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false) else { return }
        down.setIntegerValueField(.eventSourceUserData, value: marker)
        up.setIntegerValueField(.eventSourceUserData, value: marker)
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

extension String {
    func chunkedForTyping(_ size: Int) -> [String] {
        guard count > size else { return [self] }
        var result: [String] = []
        var index = startIndex
        while index < endIndex {
            let end = self.index(index, offsetBy: size, limitedBy: endIndex) ?? endIndex
            result.append(String(self[index..<end]))
            index = end
        }
        return result
    }
}
