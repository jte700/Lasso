// The Shortcuts pane of Settings, drawn as a grouped form like General and
// Apps, so it looks like System Settings' own Keyboard Shortcuts. The keys
// most people need come first; the rest wait under Advanced, and the list
// scrolls once that is open rather than stretch the window past most screens.

import SwiftUI

struct SettingsShortcutsView: View {
    @ObservedObject var model: SettingsModel
    /// Read once: the list ships inside Lasso.app and does not change while it runs.
    private static let loaded = Result { try ShortcutCatalog.loadBundled().macSections }
    /// The height the pane scrolls within while Advanced is open.
    static let openHeight: CGFloat = 600
    private static let advancedID = "advanced"
    private static let revealDelay = 0.15
    /// A little below the top, so the Advanced header stays in view above its first row.
    private static let revealAnchor = UnitPoint(x: 0.5, y: 0.12)

    var body: some View {
        switch Self.loaded {
        case .success(let sections): list(sections)
        case .failure(let error): unreadable(error)
        }
    }

    private func list(_ sections: [ShortcutCatalog.MacSection]) -> some View {
        let everyday = sections.filter { !$0.advanced }
        let advanced = sections.filter(\.advanced)
        let open = model.advancedShortcutsOpen
        return ScrollViewReader { proxy in
            Form {
                ForEach(everyday, id: \.title) { ShortcutSection(section: $0) }
                if !advanced.isEmpty {
                    SettingsDisclosureSection("Advanced", isExpanded: $model.advancedShortcutsOpen) {
                        SettingsFootnote("Keys for the card\u{2019}s other views, the pickers, sharing, AI writers and The Loop.")
                            .id(Self.advancedID)
                    }
                    if open { ForEach(advanced, id: \.title) { ShortcutSection(section: $0) } }
                }
            }
            .formStyle(.grouped)
            .scrollDisabled(!open)
            .frame(height: open ? Self.openHeight : nil)
            .onChange(of: open) { isOpen in
                // Opening Advanced brings its keys into view, below the everyday ones.
                guard isOpen else { return }
                // After the window has grown to its scrolling height, which takes a moment.
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.revealDelay) {
                    withAnimation { proxy.scrollTo(Self.advancedID, anchor: Self.revealAnchor) }
                }
            }
        }
    }

    private func unreadable(_ error: Error) -> some View {
        NSLog("Lasso could not read its keyboard shortcuts: %@", error.localizedDescription)
        return Form {
            Section {
                Text("Lasso couldn\u{2019}t read its list of keyboard shortcuts. Installing Lasso again restores it.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .scrollDisabled(true)
    }
}

/// One group of shortcuts: its title above, where they work below, the keys right-aligned as in a menu.
private struct ShortcutSection: View {
    let section: ShortcutCatalog.MacSection

    var body: some View {
        Section {
            ForEach(section.rows, id: \.action) { row in
                LabeledContent {
                    Text(row.keys)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .accessibilityLabel(ShortcutCatalog.spokenKeys(row.keys))
                } label: {
                    Text(row.action)
                }
            }
        } header: {
            Text(section.title)
        } footer: {
            if let note = section.note { SettingsFootnote(note) }
        }
    }
}
