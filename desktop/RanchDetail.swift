// The right side of The Ranch: the selected file, shown read-only, with the
// way out to the app that edits it, and ways to share it.

import Cocoa
import SceneKit
import SwiftUI

struct RanchDetail: View {
    @ObservedObject var store: RanchStore
    let actions: RanchActions

    var body: some View {
        if let source = store.source(store.selectedSourceID) {
            // A new version of the file shows afresh rather than as Quick Look cached it.
            RanchSourceDetail(store: store, source: source, actions: actions).id(source.id + (source.contentHash ?? ""))
        } else if let note = store.selectionNote, store.section == .changes {
            RanchEmptyState(symbol: "clock.arrow.circlepath", title: note.title, message: note.message)
        } else if case .directory(let id) = store.section, let directory = store.directory(id) {
            RanchDirectorySummary(store: store, directory: directory)
        } else {
            RanchEmptyState(symbol: "doc.text.magnifyingglass", title: "No File Selected",
                            message: "Choose a file to look through it here. To change it, use Edit, which opens it in its own app.")
        }
    }
}

struct RanchSourceDetail: View {
    @ObservedObject var store: RanchStore
    let source: RanchSource
    let actions: RanchActions
    @State private var file: Result<URL, Error>?
    @State private var editors = RanchEditorChoice.none
    @State private var shareError: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            switch file {
            case .none:
                ProgressView("Opening\u{2026}").frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failure(let error):
                RanchEmptyState(symbol: "externaldrive.badge.xmark", title: "Can\u{2019}t Show This File",
                                message: error.localizedDescription)
            case .success(let url):
                RanchFileViewer(store: store, source: source, url: url)
            }
        }
        .toolbar {
            // Flexible space puts the file's actions at the trailing edge, as Finder and Preview do.
            ToolbarItem { Spacer() }
            ToolbarItemGroup { toolbarActions }
        }
        .onAppear {
            store.resolveFile(source) { file = $0 }
            // Asking macOS which apps open a file reads the disk, so it is done once per file.
            editors = RanchEditorChoice(url: localURL)
        }
        .alert("The Share Link Couldn\u{2019}t Be Made", isPresented: Binding(get: { shareError != nil }, set: { if !$0 { shareError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(shareError ?? "")
        }
    }

    private var localURL: URL? { store.localURL(for: source) }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            RanchFileIcon(url: localURL, fileExtension: source.fileExtension, size: 42)
            VStack(alignment: .leading, spacing: 3) {
                Text(source.name).font(.title3.weight(.semibold)).lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
                Text(([store.directoryName(source.directoryId)] + source.folder.split(separator: "/").map(String.init))
                    .joined(separator: " \u{203A} "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Text("Edited \(RanchFormat.full(source.modifiedAt)) \u{00B7} \(RanchFormat.size(source.size))")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                HStack(spacing: 6) {
                    if source.activity > 0 { RanchActivityDot(activity: source.activity) }
                    Text(source.counts.summary).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                }
                if localURL == nil, case .success = file {
                    Label("The drive this file is on isn\u{2019}t connected. This is the copy Lasso saved.",
                          systemImage: "externaldrive.badge.minus")
                        .font(.caption).foregroundStyle(.orange)
                } else if let url = localURL, editors.primary == nil {
                    Label(RanchEditors.missingEditorHint(for: url), systemImage: "info.circle")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var toolbarActions: some View {
        RanchEditButton(url: localURL, choice: editors)
        if case .success(let url) = file {
            ShareLink(item: url) { Label("Send a Copy", systemImage: "square.and.arrow.up") }
                .help("Send a copy with AirDrop, Mail, Messages and more")
        }
        // Code is sent as a copy of the file; Lasso makes no share links for it.
        if source.canShareLink {
            Button(action: createShareLink) { Label("Share Link", systemImage: "link") }
                .help("Copy a Lasso share link to this file. Links stop working after 48 hours. (\u{21E7}\u{2318}L)")
                .keyboardShortcut("l", modifiers: [.command, .shift])
        }
        if let localURL {
            Button {
                NSWorkspace.shared.activateFileViewerSelecting([localURL])
            } label: {
                Label("Show in Finder", systemImage: "folder")
            }
            // ⌥⌘R: Lasso holds ⇧⌘R in every app, for opening The Ranch.
            .help("Show in Finder (\u{2325}\u{2318}R)")
            .keyboardShortcut("r", modifiers: [.command, .option])
        }
    }

    private func createShareLink() {
        let frame = NSApp.keyWindow?.frame ?? NSScreen.main?.visibleFrame ?? .zero
        let anchor = NSRect(x: frame.midX - 1, y: frame.midY - 1, width: 2, height: 2)
        store.shareTarget(for: source) { result in
            switch result {
            case .success(let target): actions.createShareLink(target, anchor)
            case .failure(let error): shareError = error.localizedDescription
            }
        }
    }
}

/// The app that edits a file and the others that open it, looked up once.
struct RanchEditorChoice {
    let primary: RanchEditor?
    let others: [RanchEditor]

    static let none = RanchEditorChoice(primary: nil, others: [])

    init(primary: RanchEditor?, others: [RanchEditor]) {
        self.primary = primary
        self.others = others
    }

    init(url: URL?) {
        guard let url else { self = .none; return }
        let primary = RanchEditors.primary(for: url)
        self.init(primary: primary, others: RanchEditors.alternatives(for: url, excluding: primary))
    }
}

/// "Edit in Microsoft Excel", with every other app that opens the file in its menu.
struct RanchEditButton: View {
    let url: URL?
    let choice: RanchEditorChoice

    var body: some View {
        if let url, let editor = choice.primary {
            if choice.others.isEmpty {
                Button { editor.open(url) } label: { editLabel(editor) }
                    .keyboardShortcut("e", modifiers: .command)
                    .help("Open in \(editor.name) to make changes (\u{2318}E)")
            } else {
                Menu {
                    Section("Open With") {
                        ForEach(choice.others) { other in
                            Button { other.open(url) } label: { editLabel(other) }
                        }
                    }
                } label: {
                    editLabel(editor)
                } primaryAction: {
                    editor.open(url)
                }
                .help("Open in \(editor.name) to make changes (\u{2318}E), or choose another app")
                // A menu's own shortcut is not certain to reach its primary action.
                .background(Button("Edit in \(editor.name)") { editor.open(url) }
                    .keyboardShortcut("e", modifiers: .command)
                    .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true))
            }
        } else if let url, !choice.others.isEmpty {
            Menu {
                ForEach(choice.others) { app in Button { app.open(url) } label: { editLabel(app, verb: "Open in") } }
            } label: {
                Label("Open With", systemImage: "arrow.up.forward.app").labelStyle(.titleAndIcon)
            }
            .help("No app on this Mac edits this file; open it in one that can show it")
        } else if url == nil {
            Button {} label: { Label("Edit", systemImage: "pencil") }
                .disabled(true)
                .help("Connect the drive this file is on to edit it")
        }
    }

    private func editLabel(_ editor: RanchEditor, verb: String = "Edit in") -> some View {
        Label {
            Text("\(verb) \(editor.name)")
        } icon: {
            if let icon = editor.icon { Image(nsImage: icon) } else { Image(systemName: "pencil") }
        }
        .labelStyle(.titleAndIcon)
    }
}

/// Picks the viewer for the file and fetches what it needs.
struct RanchFileViewer: View {
    @ObservedObject var store: RanchStore
    let source: RanchSource
    let url: URL
    @State private var scene: SCNScene?
    @State private var plan: AssistModelPreview?
    @State private var failed = false
    @State private var reset = 0
    @State private var code: String?
    @State private var selectedLines: ClosedRange<Int>?
    @Environment(\.colorScheme) private var colorScheme

    private var kind: RanchViewerKind { failed ? .quickLook : RanchViewerKind.choose(for: source) }

    var body: some View {
        ZStack(alignment: .bottom) {
            switch kind {
            case .quickLook:
                RanchQuickLookView(url: url)
            case .code:
                if let code {
                    RanchCodeView(text: code) { selectedLines = $0 }
                } else {
                    ProgressView("Reading the file\u{2026}").frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .mesh, .wireframe:
                if let scene {
                    RanchSceneView(scene: scene, resetToken: reset)
                        .background(Color(nsColor: .underPageBackgroundColor))
                } else {
                    ProgressView(kind == .mesh ? "Loading the model\u{2026}" : "Reading the model\u{2026}")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            case .plan:
                if let plan {
                    RanchPlanView(model: plan, resetToken: reset).background(Color(nsColor: .underPageBackgroundColor))
                } else {
                    ProgressView("Reading the drawing\u{2026}").frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            if kind == .code, let selectedLines {
                // What to write to insert these lines while typing elsewhere.
                Text("\(RanchCodeLines.label(selectedLines)) \u{00B7} Write \u{201C}\(source.name) \(RanchCodeLines.label(selectedLines).lowercased())\u{201D} to insert \(selectedLines.count == 1 ? "it" : "them")")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 12)
            }
            if let hint = kind.hint, scene != nil || plan != nil {
                HStack(spacing: 10) {
                    Text(hint).font(.caption).foregroundStyle(.secondary)
                    Button("Reset View") { reset += 1 }.controlSize(.small)
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(.regularMaterial, in: Capsule())
                .padding(.bottom, 12)
            }
        }
        .onAppear(perform: load)
    }

    private func load() {
        switch RanchViewerKind.choose(for: source) {
        case .quickLook:
            return
        case .code:
            let file = url
            DispatchQueue.global(qos: .userInitiated).async {
                let text = (try? Data(contentsOf: file)).map { String(decoding: $0, as: UTF8.self) }
                DispatchQueue.main.async { if let text { code = text } else { failed = true } }
            }
        case .mesh:
            let file = url
            DispatchQueue.global(qos: .userInitiated).async {
                let loaded = try? RanchModelScene.mesh(at: file)
                DispatchQueue.main.async { if let loaded { scene = loaded } else { failed = true } }
            }
        case .wireframe:
            let dark = colorScheme == .dark
            store.modelPreview(source) { model in
                if let model, let built = RanchModelScene.wireframe(model, dark: dark) { scene = built } else { failed = true }
            }
        case .plan:
            store.modelPreview(source) { model in
                if let model { plan = model } else { failed = true }
            }
        }
    }
}

struct RanchDirectorySummary: View {
    @ObservedObject var store: RanchStore
    let directory: RanchDirectory

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: directory.sidebarSymbol).font(.system(size: 44, weight: .light)).foregroundStyle(directory.color)
            Text(directory.name).font(.title2.weight(.semibold))
            Text(directory.rootPath).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                .multilineTextAlignment(.center)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                row("Files", directory.fileCount.formatted())
                row("Last edited", RanchFormat.full(directory.lastEditedAt))
                row("Last used", directory.lastUsedAt.map(RanchFormat.full) ?? "Not used yet")
                row("Created", RanchFormat.full(directory.createdAt))
                row("Added to Lasso", RanchFormat.full(directory.addedAt))
                if !directory.active { row("Status", "Paused: suggestions are off for this directory") }
                if let issue = directory.issue { row("Needs attention", issue) }
            }
            .font(.callout)
            if !directory.isApp && directory.available && !directory.offline {
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory.rootPath)])
                }
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            Text(value).lineLimit(2)
        }
    }
}
