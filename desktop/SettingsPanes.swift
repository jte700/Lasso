// The General and Apps panes of Settings, drawn as grouped forms so they look
// like System Settings on each macOS: Liquid Glass on macOS 26, the earlier
// inset groups before it. General shows the everyday choices; the rest waits
// under Advanced until someone opens it. Apps holds a switch for every app
// Lasso has suggested in, folded away once there are more than a handful.

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
    @Published private(set) var marksAIText = AIProvenancePreferences.showsMarks
    @Published private(set) var remembersAICopies = AIProvenancePreferences.remembersCopies
    /// The AI record's choices, kept by the server; nil until it answers.
    @Published private(set) var aiRecord: AIRecordSettings?
    /// The name as typed, sent once typing pauses.
    @Published var aiRecordName = ""
    private var pendingName: DispatchWorkItem?
    @Published private(set) var startState = LaunchHelper.State.on
    /// Nil in a build without the command.
    @Published private(set) var terminalCommand: TerminalCommand.State?
    @Published private(set) var version = ""
    @Published private(set) var apps: [SettingsApp] = []
    @Published var advancedOpen = false { didSet { onResize?() } }
    @Published var advancedShortcutsOpen = false { didSet { onResize?() } }
    /// Whether the Apps list was opened or closed by hand; until then it is open while short.
    @Published private var appsChoice: Bool? { didSet { onResize?() } }

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
        marksAIText = AIProvenancePreferences.showsMarks
        remembersAICopies = AIProvenancePreferences.remembersCopies
        reloadAIRecord()
        startState = LaunchHelper.state
        terminalCommand = TerminalCommand.launcher.map { TerminalCommand.state(launcher: $0) }
        version = actions.version()
        reloadApps()
        onResize?()
    }

    func reloadAIRecord() {
        guard let serverURL = AIAuthorshipHighlighter.shared.serverURL else { return }
        AIRecordSettings.exchange(serverURL: serverURL) { [weak self] settings in
            guard let self, let settings else { return }
            let appeared = self.aiRecord == nil
            self.aiRecord = settings
            if self.pendingName == nil { self.aiRecordName = settings.name }
            if appeared { self.onResize?() }
        }
    }

    private func changeAIRecord(_ changes: [String: Any]) {
        guard let serverURL = AIAuthorshipHighlighter.shared.serverURL else { return }
        AIRecordSettings.exchange(serverURL: serverURL, changes: changes) { [weak self] settings in
            if let settings { self?.aiRecord = settings }
        }
    }

    var carriesAIRecordChoice: Binding<Bool> {
        Binding(get: { self.aiRecord?.carry ?? true }, set: { value in
            self.aiRecord?.carry = value
            self.changeAIRecord(["carry": value])
        })
    }

    var includesPromptsChoice: Binding<Bool> {
        Binding(get: { self.aiRecord?.includePrompts ?? false }, set: { value in
            self.aiRecord?.includePrompts = value
            self.changeAIRecord(["includePrompts": value])
        })
    }

    var aiRecordNameChoice: Binding<String> {
        Binding(get: { self.aiRecordName }, set: { value in
            self.aiRecordName = value
            self.pendingName?.cancel()
            let send = DispatchWorkItem { [weak self] in
                self?.pendingName = nil
                self?.changeAIRecord(["name": value])
            }
            self.pendingName = send
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: send)
        })
    }

    var appsOpen: Bool { appsChoice ?? SuggestionAppsFold.startsOpen(count: apps.count) }

    var appsOpenChoice: Binding<Bool> {
        Binding(get: { self.appsOpen }, set: { self.appsChoice = $0 })
    }

    var appsSummary: String {
        SuggestionAppsFold.summary(count: apps.count, off: apps.filter { !$0.allowed }.map(\.name))
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

    var marksAITextChoice: Binding<Bool> {
        Binding(get: { self.marksAIText }, set: { value in
            AIProvenancePreferences.showsMarks = value
            self.changed()
        })
    }

    var remembersAICopiesChoice: Binding<Bool> {
        Binding(get: { self.remembersAICopies }, set: { value in
            AIProvenancePreferences.remembersCopies = value
            self.changed()
        })
    }

    func allowsSuggestions(in app: SettingsApp) -> Binding<Bool> {
        Binding(get: { self.apps.first { $0.id == app.id }?.allowed ?? true }, set: { allowed in
            self.suggestionApps.setAllowed(allowed, for: app.id)
            if allowed { HostAccessibilityMode.shared.forget(bundleIdentifier: app.id) }
            self.reloadApps()
        })
    }

    /// An app added by hand is added to be switched off: that is why people add one.
    func addSwitchedOff(_ bundleID: String) {
        suggestionApps.setAllowed(false, for: bundleID)
        reloadApps()
        // The list opens so the app just added shows with its switch off.
        appsChoice = true
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

    func installTerminalCommand() {
        _ = TerminalCommand.install()
        refresh()
    }

    func removeTerminalCommand() {
        TerminalCommand.remove()
        refresh()
    }

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
            Section {
                Toggle(isOn: model.marksAITextChoice) {
                    SettingsLabel("Mark AI-written text",
                                  note: "Brackets in each AI\u{2019}s colour around what ChatGPT, Claude and others wrote, from Lasso\u{2019}s records. Hover one to see who wrote it and why.")
                }
                Toggle(isOn: model.remembersAICopiesChoice) {
                    SettingsLabel("Remember text copied from AI apps",
                                  note: "Text copied in ChatGPT, Claude or their websites is marked where you paste it. Copies from other apps are never read.")
                }
            }
            if model.aiRecord != nil {
                Section {
                    Toggle(isOn: model.carriesAIRecordChoice) {
                        SettingsLabel("Carry the AI record in Word documents",
                                      note: "Once you close a Word document with AI-written parts, Lasso writes which parts an AI wrote into the file, signed by your Lasso. Anyone with Lasso you send it to sees the same brackets.")
                    }
                    Toggle(isOn: model.includesPromptsChoice) {
                        SettingsLabel("Include prompts",
                                      note: "Off, the record says which AI wrote each part but not what it was asked.")
                    }
                    .disabled(!(model.aiRecord?.carry ?? true))
                    TextField(text: model.aiRecordNameChoice, prompt: Text("Your name")) {
                        SettingsLabel("Your name on records", note: "Shown to the people you send documents to.")
                    }
                    .disabled(!(model.aiRecord?.carry ?? true))
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

    /// Collapsed until someone opens it: the default colour, starting at login, the terminal command and the version.
    private var advanced: some View {
        SettingsDisclosureSection("Advanced", isExpanded: $model.advancedOpen) { advancedRows }
    }

    @ViewBuilder private var advancedRows: some View {
        Picker(selection: model.folderColorChoice) {
            ForEach(DirectoryToggleColor.choices(including: model.folderColor, DirectoryColorPreferences.lastCustom()),
                    id: \.self) { option in
                Label { Text(option.title) } icon: { Image(nsImage: option.swatch(size: Self.swatchSize)) }
                    .tag(option)
            }
        } label: {
            SettingsLabel("Folder colour",
                          note: "For folders you haven\u{2019}t given their own colour, and the text you accept from them.")
        }
        if model.startState == .on { startRow }
        if let state = model.terminalCommand { terminalRow(state) }
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

    private func terminalRow(_ state: TerminalCommand.State) -> some View {
        LabeledContent {
            switch state {
            case .installed: Button("Remove", action: model.removeTerminalCommand)
            case .absent(let needsPassword): Button(needsPassword ? "Install\u{2026}" : "Install", action: model.installTerminalCommand)
            case .other: EmptyView()
            }
        } label: {
            SettingsLabel("Terminal command", note: TerminalCommand.note(for: state))
        }
    }
}

// MARK: Apps

struct SettingsAppsView: View {
    @ObservedObject var model: SettingsModel
    private static let iconSize: CGFloat = 20
    /// Past this many apps an open list scrolls inside a fixed height.
    private static let scrollingAfter = 9
    private static let scrollingHeight: CGFloat = 520

    var body: some View {
        let scrolls = model.appsOpen && model.apps.count > Self.scrollingAfter
        Form {
            SettingsDisclosureSection(isExpanded: model.appsOpenChoice) {
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
            } label: {
                HStack {
                    Text("Suggest While Typing In")
                    Spacer()
                    if !model.apps.isEmpty {
                        Text(model.appsSummary).font(.callout).fontWeight(.regular)
                            .foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                    }
                }
            }
            Section {
                LabeledContent {
                    addMenu
                } label: {
                    SettingsLabel("Add an app",
                                  note: "Lasso adds each app you type in. Switch one off and Lasso stays quiet there and does not read its text.")
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

/// A section that folds away under its header, as System Settings' do.
/// Before macOS 14 sections cannot fold, so the rows sit in a disclosure group instead.
struct SettingsDisclosureSection<Content: View, Header: View>: View {
    let isExpanded: Binding<Bool>
    @ViewBuilder let content: () -> Content
    @ViewBuilder let label: () -> Header

    init(isExpanded: Binding<Bool>, @ViewBuilder content: @escaping () -> Content,
         @ViewBuilder label: @escaping () -> Header) {
        self.isExpanded = isExpanded
        self.content = content
        self.label = label
    }

    var body: some View {
        if #available(macOS 14.0, *) {
            Section(isExpanded: isExpanded, content: content, header: label)
        } else {
            Section { DisclosureGroup(isExpanded: isExpanded, content: content, label: label) }
        }
    }
}

extension SettingsDisclosureSection where Header == Text {
    init(_ title: String, isExpanded: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) {
        self.init(isExpanded: isExpanded, content: content) { Text(title) }
    }
}

/// A pull-down button, as System Settings puts beside its rows.
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
