//  A deliberately slow Accessibility host, for checking that Lasso never
//  delays typing in other apps while it waits on one.
//
//  `npm run desktop:slow-host -- 400` opens a text window whose every
//  Accessibility answer waits that long (400 ms by default). Type in it with
//  suggestions on, then type in another app: those keys must not lag. Accept
//  a suggestion here with Tab too: the card and other apps must stay
//  responsive while Lasso reads and writes this window.

import Cocoa

let delay = TimeInterval(CommandLine.arguments.dropFirst().first.flatMap(Double.init) ?? 400) / 1000

final class SlowTextView: NSTextView {
    private func wait() { Thread.sleep(forTimeInterval: delay) }
    override func accessibilityRole() -> NSAccessibility.Role? { wait(); return super.accessibilityRole() }
    override func accessibilityValue() -> String? { wait(); return super.accessibilityValue() }
    override func accessibilitySelectedTextRange() -> NSRange { wait(); return super.accessibilitySelectedTextRange() }
    override func accessibilityString(for range: NSRange) -> String? { wait(); return super.accessibilityString(for: range) }
    override func accessibilityFrame(for range: NSRange) -> NSRect { wait(); return super.accessibilityFrame(for: range) }
    override func accessibilityAttributedString(for range: NSRange) -> NSAttributedString? {
        wait()
        return super.accessibilityAttributedString(for: range)
    }
}

final class SlowHost: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let item = NSMenuItem()
        item.submenu = NSMenu()
        item.submenu?.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(item)
        NSApp.mainMenu = menu

        let frame = NSRect(x: 0, y: 0, width: 560, height: 320)
        let window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "Slow Accessibility host (\(Int(delay * 1000)) ms per answer)"
        let scroll = NSScrollView(frame: frame)
        scroll.hasVerticalScroller = true
        scroll.autoresizingMask = [.width, .height]
        let text = SlowTextView(frame: frame)
        text.autoresizingMask = [.width]
        text.font = .systemFont(ofSize: 15)
        scroll.documentView = text
        window.contentView = scroll
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(text)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let application = NSApplication.shared
let host = SlowHost()
application.delegate = host
application.setActivationPolicy(.regular)
application.run()
