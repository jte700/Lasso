// A shortcut that works in every app, such as ⇧⌘R for The Ranch. Carbon's
// hot keys need no Accessibility or Input Monitoring permission; while Lasso
// holds the keys, the app in front never sees them.

import Cocoa
import Carbon.HIToolbox

final class GlobalHotKey {
    private static let signature = OSType(0x4C53_534F) // 'LSSO', as the launcher's ⌘L
    private let id: UInt32
    private let action: () -> Void
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?

    /// Nil when the keys can't be held, such as when another app holds them already.
    init?(keyCode: Int, modifiers: NSEvent.ModifierFlags, id: UInt32, action: @escaping () -> Void) {
        self.id = id
        self.action = action
        var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            return Unmanaged<GlobalHotKey>.fromOpaque(context).takeUnretainedValue().handle(event)
        }, 1, &pressed, Unmanaged.passUnretained(self).toOpaque(), &handler)
        let registered = installed == noErr
            ? RegisterEventHotKey(UInt32(keyCode), Self.carbonModifiers(modifiers),
                                  EventHotKeyID(signature: Self.signature, id: id), GetApplicationEventTarget(), 0, &hotKey)
            : installed
        guard registered == noErr else {
            NSLog("Lasso could not hold a shortcut in every app (key %d, status %d)", keyCode, registered)
            release()
            return nil
        }
    }

    deinit { release() }

    static func carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32 {
        [(NSEvent.ModifierFlags.command, cmdKey), (.shift, shiftKey), (.option, optionKey), (.control, controlKey)]
            .reduce(UInt32(0)) { carbon, pair in flags.contains(pair.0) ? carbon | UInt32(pair.1) : carbon }
    }

    private func handle(_ event: EventRef) -> OSStatus {
        var pressed = EventHotKeyID()
        let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                       nil, MemoryLayout<EventHotKeyID>.size, nil, &pressed)
        guard status == noErr, pressed.signature == Self.signature, pressed.id == id else {
            return OSStatus(eventNotHandledErr)
        }
        DispatchQueue.main.async(execute: action)
        return noErr
    }

    private func release() {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let handler { RemoveEventHandler(handler) }
        hotKey = nil
        handler = nil
    }
}
