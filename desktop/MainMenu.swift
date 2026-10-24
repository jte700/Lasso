// The standard macOS menu bar: Lasso, File, Edit, View, Window and Help.
//
// Lasso runs as a menu bar extra, so the bar itself shows only while the
// Settings window is open. AppKit still routes Command-key shortcuts through
// this menu at all times; without it Copy, Paste, Select All and Close do
// nothing in Lasso's own windows, panels and web views.

import Cocoa

enum MainMenu {
    /// App-specific commands, implemented by the application delegate.
    struct Commands {
        let target: AnyObject
        let about: Selector
        let settings: Selector
        let addDirectories: Selector
        let openRanch: Selector
        let help: Selector
    }

    static let appName = "Lasso"

    static func install(_ commands: Commands) {
        let bar = NSMenu()
        let windowMenu = makeWindowMenu()
        let helpMenu = makeHelpMenu(commands)
        for menu in [makeAppMenu(commands), makeFileMenu(commands), makeEditMenu(), makeViewMenu(), windowMenu, helpMenu] {
            let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
            item.submenu = menu
            bar.addItem(item)
        }
        NSApp.mainMenu = bar
        NSApp.windowsMenu = windowMenu
        NSApp.helpMenu = helpMenu
    }

    private static func item(_ title: String, _ action: Selector?, _ key: String = "",
                             _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = key.isEmpty ? [] : modifiers
        item.target = target
        return item
    }

    private static func makeAppMenu(_ commands: Commands) -> NSMenu {
        let menu = NSMenu(title: appName)
        menu.addItem(item("About \(appName)", commands.about, target: commands.target))
        menu.addItem(.separator())
        menu.addItem(item("Settings…", commands.settings, ",", target: commands.target))
        menu.addItem(.separator())
        let services = item("Services", nil)
        let servicesMenu = NSMenu(title: "Services")
        services.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        menu.addItem(services)
        menu.addItem(.separator())
        menu.addItem(item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"))
        menu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        menu.addItem(item("Show All", #selector(NSApplication.unhideAllApplications(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"))
        return menu
    }

    private static func makeFileMenu(_ commands: Commands) -> NSMenu {
        let menu = NSMenu(title: "File")
        menu.addItem(item("Add Work Directories…", commands.addDirectories, target: commands.target))
        menu.addItem(item("Open \(Ranch.title)", commands.openRanch, "r", target: commands.target))
        menu.addItem(.separator())
        menu.addItem(item("Close", #selector(NSWindow.performClose(_:)), "w"))
        return menu
    }

    private static func makeEditMenu() -> NSMenu {
        // AppKit appends Start Dictation and Emoji & Symbols to a menu titled Edit.
        let menu = NSMenu(title: "Edit")
        menu.addItem(item("Undo", Selector(("undo:")), "z"))
        menu.addItem(item("Redo", Selector(("redo:")), "z", [.command, .shift]))
        menu.addItem(.separator())
        menu.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        menu.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        menu.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        menu.addItem(item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]))
        menu.addItem(item("Delete", #selector(NSText.delete(_:))))
        menu.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        menu.addItem(.separator())
        let find = item("Find", nil)
        let findMenu = NSMenu(title: "Find")
        let findAction = #selector(NSTextView.performFindPanelAction(_:))
        let findItems: [(String, String, NSEvent.ModifierFlags, NSFindPanelAction)] = [
            ("Find…", "f", .command, .showFindPanel),
            ("Find Next", "g", .command, .next),
            ("Find Previous", "g", [.command, .shift], .previous),
            ("Use Selection for Find", "e", .command, .setFindString),
        ]
        for (title, key, modifiers, action) in findItems {
            let findItem = item(title, findAction, key, modifiers)
            findItem.tag = Int(action.rawValue)
            findMenu.addItem(findItem)
        }
        find.submenu = findMenu
        menu.addItem(find)
        return menu
    }

    private static func makeViewMenu() -> NSMenu {
        // The View menu holds only the full-screen command, as the HIG suggests.
        let menu = NSMenu(title: "View")
        menu.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        return menu
    }

    private static func makeWindowMenu() -> NSMenu {
        let menu = NSMenu(title: "Window")
        menu.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        menu.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        menu.addItem(.separator())
        menu.addItem(item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))))
        return menu
    }

    private static func makeHelpMenu(_ commands: Commands) -> NSMenu {
        let menu = NSMenu(title: "Help")
        menu.addItem(item("\(appName) Help", commands.help, "?", target: commands.target))
        return menu
    }
}
