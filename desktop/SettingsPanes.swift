// The General and Apps panes of Settings, drawn as grouped forms so they look
// like System Settings on each macOS: Liquid Glass on macOS 26, the earlier
// inset groups before it. General shows the everyday choices; the rest waits
// under Advanced until someone opens it. Apps holds a switch for every app
// Lasso has suggested in.

import Cocoa
import SwiftUI
import UniformTypeIdentifiers

/// An app with a switch in the Apps pane.
struct SettingsApp: Identifiable, Equatable {
    let id: String
    let name: String
    let icon: NSImage
    let allowed: Bool

    /// Names and icons come from the installed app; one since removed shows its identifier.
    static func resolve(_ bundleID: String, allowed: Bool) -> SettingsApp {
        let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)
        let name = url.map { FileManager.default.displayName(atPath: $0.path) }
            .map { $0.hasSuffix(".app") ? String($0.dropLast(4)) : $0 } ?? bundleID
        let icon = url.map { NSWorkspace.shared.icon(forFile: $0.path) }
            ?? NSImage(systemSymbolName: "app.dashed", accessibilityDescription: nil) ?? NSImage()
        return SettingsApp(id: bundleID, name: name, icon: icon, allowed: allowed)
    }
}

/// What both panes show, read again whenever Settings opens or the panel changes something.
final class SettingsModel: ObservableObject {
    @Published private(set) var appearance = AppearancePreference.current()
    @Published private(set) var folderColor = DirectoryColorPreferences.defaultColor()
    @Published private(set) var insertion = InsertionMode.current
    @Published private(set) var startState = LaunchHelper.State.on
    @Published private(set) var version = ""
    @Published private(set) var apps: [SettingsApp] = []
    @Published var advancedOpen = false { didSet { onResize?() } }

    private let actions: SettingsActions
    private let suggestionApps: SettingsAppStore
    /// Asks the window to take the height the pane now needs.
    var onResize: (() -> Void)?

    init(actions: SettingsActions, suggestionApps: SettingsAppStore = SuggestionApps.shared) {
        self.actions = actions
        self.suggestionApps = suggestionApps
    }

    func refresh() {
        appearance = AppearancePreference.current()
        folderColor = DirectoryColorPreferences.defaultColor()
        insertion = InsertionMode.current
        startState = LaunchHelper.state
        version = actions.version()
        reloadApps()
        onResize?()
    }

    func reloadApps() {
        let listed = suggestionApps.listed.map { app($0, allowed: suggestionApps.allows($0)) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        if listed != apps { apps = listed }
    }

    /// Names and icons found once per app, since the panel asks Settings to refresh often.
    private var resolved: [String: SettingsApp] = [:]

    private func app(_ bundleID: String, allowed: Bool) -> SettingsApp {
        let found = resolved[bundleID] ?? SettingsApp.resolve(bundleID, allowed: allowed)
        resolved[bundleID] = found
        return SettingsApp(id: bundleID, name: found.name, icon: found.icon, allowed: allowed)
    }

    // MARK: Changes

    var appearanceChoice: Binding<AppearancePreference> {
        Binding(get: { self.appearance }, set: { value in
            AppearancePreference.set(value)
            self.changed()
        })
    }

    var folderColorChoice: Binding<DirectoryToggleColor> {
        Binding(get: { self.folderColor }, set: { value in
            DirectoryColorPreferences.setDefault(value)
            self.changed()
        })
    }

    var insertionChoice: Binding<InsertionMode> {
        Binding(get: { self.insertion }, set: { value in
            InsertionMode.set(value)
            self.changed()
        })
    }

    func allowsSuggestions(in app: SettingsApp) -> Binding<Bool> {
        Binding(get: { self.apps.first { $0.id == app.id }?.allowed ?? true }, set: { allowed in
            self.suggestionApps.setAllowed(allowed, for: app.id)
            self.reloadApps()
        })
    }

    /// An app added by hand is added to be switched off: that is why people add one.
    func addSwitchedOff(_ bundleID: String) {
        suggestionApps.setAllowed(false, for: bundleID)
        reloadApps()
        onResize?()
    }

    /// Running apps people could switch off, leaving out those already listed.
    var runningApps: [SettingsApp] {
        let listed = Set(apps.map(\.id))
        let own = Bundle.main.bundleIdentifier
        let candidates = NSWorkspace.shared.runningApplications.filter { app in
            app.activationPolicy == .regular && app.bundleIdentifier.map { !listed.contains($0) && $0 != own } == true
        }
        return candidates.compactMap { $0.bundleIdentifier }
            .map { app($0, allowed: true) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func chooseApp() {
        let panel = NSOpenPanel()
        panel.title = "Choose an App"
        panel.prompt = "Add"
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowedContentTypes = [.application]
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            if let id = Bundle(url: url)?.bundleIdentifier { addSwitchedOff(id) }
        }
    }

    func openLoginItems() { LaunchHelper.openSettings() }

    private func changed() {
        actions.didChange()
        refresh()
    }
}

/// The part of `SuggestionApps` the Apps pane uses, so it can be checked on its own.
protocol SettingsAppStore {
    var listed: [String] { get }
    func allows(_ bundleID: String) -> Bool
    func setAllowed(_ allowed: Bool, for bundleID: String)
}

extension SuggestionApps: SettingsAppStore {}

// MARK: General

struct SettingsGeneralView: View {
    @ObservedObject var model: SettingsModel
    static let swatchSize: CGFloat = 12

    var body: some View {
        Form {
            Section {
                Picker("Appearance", selection: model.appearanceChoice) {
                    ForEach(AppearancePreference.allCases, id: \.self) { Text($0.title).tag($0) }
                }
            }
            Section {
                Picker(selection: model.insertionChoice) {
                    ForEach(InsertionMode.allCases, id: \.self) { Text($0.title).tag($0) }
                } label: {
                    SettingsLabel("Tab inserts", note: model.insertion.explanation)
                }
            }
            // A start-up problem needs the user, so it never hides under Advanced.
            if model.startState != .on {
                Section { startRow }
            }
            advanced
        }
        .formStyle(.grouped)
        .scrollDisabled(true)
    }

    /// Collapsed until someone opens it: the default colour, starting at login and the version.
    @ViewBuilder private var advanced: some View {
        if #available(macOS 14.0, *) {
            Section("Advanced", isExpanded: $model.advancedOpen) { advancedRows }
        } else {
            Section {
                DisclosureGroup("Advanced", isExpanded: $model.advancedOpen) { advancedRows }
            }
        }
    }

    @ViewBuilder private var advancedRows: some View {
        Picker(selection: model.folderColorChoice) {
            ForEach(DirectoryToggleColor.allCases, id: \.self) { option in
                Label { Text(option.title) } icon: { Image(nsImage: option.swatch(size: Self.swatchSize)) }
                    .tag(option)
            }
        } label: {
            SettingsLabel("Folder colour",
                          note: "For folders you haven\u{2019}t given their own colour, and the text you accept from them.")
        }
        if model.startState == .on { startRow }
        LabeledContent("Version") {
            Text(model.version).textSelection(.enabled).multilineTextAlignment(.trailing)
        }
    }

    private var startRow: some View {
        LabeledContent {
            if model.startState != .on {
                Button("Open Login Items\u{2026}", action: model.openLoginItems)
            }
        } label: {
            SettingsLabel("Start at login", note: LaunchHelper.note(for: model.startState))
        }
    }
}

// MARK: Apps

struct SettingsAppsView: View {
    @ObservedObject var model: SettingsModel
    private static let iconSize: CGFloat = 20
    /// Past this many apps the list scrolls inside a fixed height.
    private static let scrollingAfter = 9
    private static let scrollingHeight: CGFloat = 520

    var body: some View {
        let scrolls = model.apps.count > Self.scrollingAfter
        Form {
            Section {
                if model.apps.isEmpty {
                    Text("Apps you type in will appear here.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.apps) { app in
                    Toggle(isOn: model.allowsSuggestions(in: app)) {
                        HStack(spacing: 8) {
                            Image(nsImage: app.icon).resizable().interpolation(.high)
                                .frame(width: Self.iconSize, height: Self.iconSize)
                            Text(app.name).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .toggleStyle(.switch)
                    .help(app.id)
                }
            } header: {
                Text("Suggest While Typing In")
            } footer: {
                HStack(alignment: .top, spacing: 12) {
                    SettingsFootnote("Lasso adds each app you type in. Switch one off and Lasso stays quiet there and does not read its text.")
                    Spacer(minLength: 0)
                    addMenu
                }
            }
        }
        .formStyle(.grouped)
        .scrollDisabled(!scrolls)
        .frame(height: scrolls ? Self.scrollingHeight : nil)
    }

    private var addMenu: some View {
        Menu("Add App\u{2026}") {
            let running = model.runningApps
            if !running.isEmpty {
                Section("Open Apps") {
                    ForEach(running) { app in
                        Button { model.addSwitchedOff(app.id) } label: {
                            Label { Text(app.name) } icon: { Image(nsImage: Self.menuIcon(app.icon)) }
                        }
                    }
                }
                Divider()
            }
            Button("Choose\u{2026}") { model.chooseApp() }
        }
        .modifier(SettingsPullDown())
        .fixedSize()
        .help("Switch off suggestions in an app you haven\u{2019}t typed in yet.")
    }

    /// Menus draw images at their own size; a full app icon would be huge.
    private static func menuIcon(_ icon: NSImage) -> NSImage {
        let size = NSSize(width: 16, height: 16)
        return NSImage(size: size, flipped: false) { rect in
            icon.draw(in: rect)
            return true
        }
    }
}

/// A pull-down button, as System Settings puts under its lists.
private struct SettingsPullDown: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 14.0, *) {
            content.menuStyle(.button).buttonStyle(.bordered).controlSize(.small)
        } else {
            content.menuStyle(.borderlessButton).controlSize(.small)
        }
    }
}

/// A row's name with a line under it saying what the choice does.
struct SettingsLabel: View {
    let title: String
    let note: String
    init(_ title: String, note: String) {
        self.title = title
        self.note = note
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            SettingsFootnote(note)
        }
    }
}

/// The small grey line under a choice that says what it does.
struct SettingsFootnote: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}
