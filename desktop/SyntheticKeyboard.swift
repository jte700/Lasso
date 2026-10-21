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

    static func paste() { command(9) }

    /// Hands ⌘Z on to the host when Lasso has no insertion of its own to take back.
    static func undo() { command(6) }

    private static func command(_ vKey: CGKeyCode) {
        let source = source()
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
    /// Splits text into key events of at most `size` UTF-16 units, the unit
    /// macOS limits per event. Whole characters stay together, so an accent
    /// or emoji is never split across two events and dropped by the host.
    func chunkedForTyping(_ size: Int) -> [String] {
        guard utf16.count > size else { return [self] }
        var result: [String] = []
        var current = ""
        for character in self {
            if !current.isEmpty, current.utf16.count + character.utf16.count > size {
                result.append(current)
                current = ""
            }
            current.append(character)
        }
        if !current.isEmpty { result.append(current) }
        return result
    }
}
