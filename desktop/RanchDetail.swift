// The right side of The Ranch: the selected file, shown read-only, with the
// way out to the app that edits it, and ways to share it.

import Cocoa
import SceneKit
import SwiftUI

struct RanchDetail: View {
    @ObservedObject var store: RanchStore
    let actions: RanchActions

    var body: some View {
        Group {
            if let source = store.source(store.selectedSourceID) {
                // A new version of the file shows afresh rather than as Quick Look cached it.
                RanchSourceDetail(store: store, source: source, actions: actions).id(source.id + (source.contentHash ?? ""))
            } else if let item = store.reviewFocus {
                RanchReviewOnly(store: store, item: item)
            } else if let note = store.selectionNote, store.section == .changes {
                RanchEmptyState(symbol: "clock.arrow.circlepath", title: note.title, message: note.message)
            } else if case .directory(let id) = store.section, let directory = store.directory(id) {
                RanchDirectorySummary(store: store, directory: directory)
            } else {
                RanchEmptyState(symbol: "doc.text.magnifyingglass", title: "No File Selected",
                                message: "Choose a file to look through it here. To change it, use Edit, which opens it in its own app.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RanchTheme.surface)
        // With no file, the top of the column still moves the window.
        .background(alignment: .top) { RanchWindowDragArea().frame(height: RanchTheme.headerHeight) }
    }
}

struct RanchSourceDetail: View {
    @ObservedObject var store: RanchStore
    let source: RanchSource
    let actions: RanchActions
    @State private var file: Result<URL, Error>?
    @State private var editors = RanchEditorChoice.none
    @State private var shareError: String?
    @State private var citedCell: RanchCellPlace?

    /// The Needs Review item this file is shown for, if it is.
    private var review: RanchReviewItem? { store.reviewFocus.flatMap { $0.fileId == source.id ? $0 : nil } }

    var body: some View {
        VStack(spacing: 0) {
            header
            details
            if let review {
                RanchReviewPanel(store: store, item: review, cell: citedCell?.name,
                                 openAtCell: openAtCell, shareAgain: source.canShareLink ? createShareLink : nil)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .overlay(alignment: .bottom) { RanchHairline() }
            }
            switch file {
            case .none:
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failure(let error):
                RanchEmptyState(symbol: "externaldrive.badge.xmark", title: "Can\u{2019}t Show This File",
                                message: error.localizedDescription)
            case .success(let url):
                RanchFileViewer(store: store, source: source, url: url, focus: review == nil ? nil : store.focusedLink,
                                citedCell: $citedCell)
            }
        }
        .background(RanchTheme.surface)
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

    /// Opens the workbook in its app at the cell a review link cites.
    private var openAtCell: (() -> Void)? {
        guard let localURL, let cell = citedCell, let name = cell.name else { return nil }
        return { _ = AssistSourceOpener.open(localURL, at: AssistOpenTarget(sheet: cell.sheetName, cell: name)) }
    }

    /// The file's name, with the way out to its app and ways to share it on
    /// the right. Where the whole name and "Edit in Microsoft Excel" don't
    /// both fit, the button says only "Edit".
    private var header: some View {
        ViewThatFits(in: .horizontal) {
            headerRow(compact: false)
            headerRow(compact: true)
        }
        .padding(.leading, 16)
        .padding(.trailing, 10)
        .frame(height: RanchTheme.headerHeight)
        .background(RanchWindowDragArea())
        .overlay(alignment: .bottom) { RanchHairline() }
        .background { shortcuts }
    }

    private func headerRow(compact: Bool) -> some View {
        HStack(spacing: 10) {
            RanchFileIcon(url: localURL, fileExtension: source.fileExtension, size: 22)
            Text(source.name).font(RanchTheme.titleFont).foregroundStyle(RanchTheme.ink)
                .lineLimit(1).truncationMode(.middle)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            fileActions(compact: compact)
        }
    }

    /// The header's buttons say their keys; the keys live here, once, whichever
    /// way the header is drawn.
    @ViewBuilder
    private var shortcuts: some View {
        ZStack {
            if let url = localURL, let editor = editors.primary {
                RanchHiddenShortcut(key: "e") { editor.open(url) }
            }
            if source.canShareLink {
                RanchHiddenShortcut(key: "l", modifiers: [.command, .shift], action: createShareLink)
            }
            // ⌥⌘R: Lasso holds ⇧⌘R in every app, for opening The Ranch.
            if let localURL {
                RanchHiddenShortcut(key: "r", modifiers: [.command, .option]) {
                    NSWorkspace.shared.activateFileViewerSelecting([localURL])
                }
            }
        }
    }

    /// Where the file is, when it changed, how big it is and how much it is used.
    private var details: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: "folder").imageScale(.small).foregroundStyle(RanchTheme.tertiaryInk)
                Text(([store.directoryName(source.directoryId)] + source.folder.split(separator: "/").map(String.init))
                    .joined(separator: " \u{203A} "))
                    .lineLimit(1).truncationMode(.middle)
                Text("\u{00B7} Edited \(RanchFormat.full(source.modifiedAt)) \u{00B7} \(RanchFormat.size(source.size))")
                    .lineLimit(1).layoutPriority(1)
            }
            HStack(spacing: 6) {
                if source.activity > 0 { RanchActivityDot(activity: source.activity) }
                Text(source.counts.summary).lineLimit(1).truncationMode(.tail)
            }
            if localURL == nil, case .success = file {
                RanchBanner(symbol: "externaldrive.badge.minus", tint: RanchTheme.warning,
                            text: "The drive this file is on isn\u{2019}t connected. This is the copy Lasso saved.")
            } else if let url = localURL, editors.primary == nil {
                RanchBanner(symbol: "info.circle", tint: RanchTheme.secondaryInk, text: RanchEditors.missingEditorHint(for: url))
            }
        }
        .font(RanchTheme.captionFont)
        .foregroundStyle(RanchTheme.secondaryInk)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { RanchHairline() }
    }

    @ViewBuilder
    private func fileActions(compact: Bool) -> some View {
        RanchEditButton(url: localURL, choice: editors, compact: compact)
        HStack(spacing: 2) {
            if case .success(let url) = file {
                ShareLink(item: url) { Label("Send a Copy", systemImage: "square.and.arrow.up") }
                    .buttonStyle(RanchIconButtonStyle())
                    .help("Send a copy with AirDrop, Mail, Messages and more")
            }
            // Code is sent as a copy of the file; Lasso makes no share links for it.
            if source.canShareLink {
                Button(action: createShareLink) { Label("Share Link", systemImage: "link") }
                    .buttonStyle(RanchIconButtonStyle())
                    .help("Copy a Lasso share link to this file. Links stop working after 48 hours. (\u{21E7}\u{2318}L)")
            }
            if let localURL {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([localURL])
                } label: {
                    Label("Show in Finder", systemImage: "folder")
                }
                .buttonStyle(RanchIconButtonStyle())
                .help("Show in Finder (\u{2325}\u{2318}R)")
            }
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

/// A short note about the file, on a wash of its colour.
struct RanchBanner: View {
    let symbol: String
    let tint: Color
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(text).foregroundStyle(RanchTheme.ink.opacity(0.8)).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(tint.opacity(0.1)))
        .padding(.top, 3)
    }
}

/// "Edit in Microsoft Excel" as a pill, with every other app that opens the
/// file behind its chevron.
struct RanchEditButton: View {
    let url: URL?
    let choice: RanchEditorChoice
    /// "Edit" alone, beside a long name in a narrow column.
    var compact = false
    @State private var hovering = false

    var body: some View {
        if let url, let editor = choice.primary {
            HStack(spacing: 0) {
                Button { editor.open(url) } label: {
                    pillLabel(editor)
                        .padding(.leading, 10)
                        .padding(.trailing, choice.others.isEmpty ? 11 : 8)
                        .frame(height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(choice.others.isEmpty ? "Open in \(editor.name) to make changes (\u{2318}E)"
                      : "Open in \(editor.name) to make changes (\u{2318}E), or choose another app")
                if !choice.others.isEmpty {
                    RanchTheme.controlEdge.frame(width: 1, height: 16)
                    Menu {
                        Section("Open With") {
                            ForEach(choice.others) { other in
                                Button { other.open(url) } label: { menuLabel(other) }
                            }
                        }
                    } label: {
                        Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .semibold))
                            .foregroundStyle(RanchTheme.secondaryInk)
                            .frame(width: 26, height: 28)
                            .contentShape(Rectangle())
                    }
                    .modifier(RanchPlainMenuStyle())
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Open in another app")
                }
            }
            .font(RanchTheme.controlFont)
            .foregroundStyle(RanchTheme.ink)
            .background(RanchPillShape(hovering: hovering))
            .onHover { hovering = $0 }
            .fixedSize()
        } else if let url, !choice.others.isEmpty {
            RanchPillMenu(title: compact ? "Open" : "Open With", symbol: "arrow.up.forward.app",
                          help: "No app on this Mac edits this file; open it in one that can show it") {
                ForEach(choice.others) { app in Button { app.open(url) } label: { menuLabel(app, verb: "Open in") } }
            }
        } else if url == nil {
            Button {} label: { Label("Edit", systemImage: "pencil") }
                .buttonStyle(RanchPillButtonStyle())
                .disabled(true)
                .help("Connect the drive this file is on to edit it")
        }
    }

    private func pillLabel(_ editor: RanchEditor) -> some View {
        HStack(spacing: 6) {
            if let icon = editor.icon {
                Image(nsImage: icon).resizable().interpolation(.high).frame(width: 16, height: 16)
            } else {
                Image(systemName: "pencil").imageScale(.small)
            }
            Text(compact ? "Edit" : "Edit in \(editor.name)").lineLimit(1)
        }
    }

    private func menuLabel(_ editor: RanchEditor, verb: String = "Edit in") -> some View {
        Label {
            Text("\(verb) \(editor.name)")
        } icon: {
            if let icon = editor.icon { Image(nsImage: icon) } else { Image(systemName: "pencil") }
        }
        .labelStyle(.titleAndIcon)
    }
}

/// Picks the viewer for the file and fetches what it needs. With a review
/// item's link in `focus`, the viewer goes to the place the link cites.
struct RanchFileViewer: View {
    @ObservedObject var store: RanchStore
    let source: RanchSource
    let url: URL
    var focus: RanchReviewLink? = nil
    /// The cell `focus` cites, once the sheet view has found it.
    @Binding var citedCell: RanchCellPlace?
    @State private var scene: SCNScene?
    @State private var plan: AssistModelPreview?
    @State private var workbook: RanchWorkbook?
    @State private var slides: SlideDeckDocument?
    @State private var failed = false
    @State private var reset = 0
    @State private var code: RanchCode?
    @State private var selectedLines: ClosedRange<Int>?
    /// Passages of a text or PDF file its latest version changed, and the note of the one pointed at or selected.
    @State private var passageChanges: [RanchPassageChange] = []
    @State private var changeNote: String?
    @State private var passageRequest: URLSessionDataTask?
    @State private var request: URLSessionDataTask?
    /// A model or drawing still being read after a few seconds.
    @State private var slow = false
    /// Quick Look's rendering of a workbook's own layout, instead of its cells.
    @AppStorage("RanchSheetLayout") private var originalLayout = false
    @Environment(\.colorScheme) private var colorScheme

    private static let slowAfter: TimeInterval = 4

    private var kind: RanchViewerKind { failed ? .quickLook : RanchViewerKind.choose(for: source) }

    var body: some View {
        VStack(spacing: 0) {
            if RanchViewerKind.choose(for: source) == .sheet && !failed {
                RanchFilterBar {
                    RanchSegmented(selection: $originalLayout, options: [(false, "Cells"), (true, "Original Layout")])
                        .help("Cells shows what Lasso reads from each cell; Original Layout shows the file as Quick Look draws it")
                }
            }
            ZStack(alignment: .bottom) {
                viewer
                notes
            }
        }
        .onAppear(perform: load)
        .onDisappear { request?.cancel(); passageRequest?.cancel() }
        .onChange(of: focus?.anchor?.elementId) { _ in if kind == .plan || kind == .wireframe { load() } }
        .onChange(of: workbook) { _ in findCitedCell() }
        .onChange(of: focus) { _ in findCitedCell() }
    }

    @ViewBuilder
    private var viewer: some View {
        switch kind {
        case .quickLook:
            // PDFs always open in PDFKit, so a review link can turn to its page
            // without swapping viewers under it.
            if source.fileExtension == "pdf" {
                RanchPDFView(url: url, page: focus.map { $0.anchor?.pageNumber ?? 1 }, find: focus?.linkedValue,
                             changes: passageChanges, onChangeNote: { changeNote = $0 })
            } else {
                RanchQuickLookView(url: url)
            }
        case .sheet:
            if originalLayout {
                RanchQuickLookView(url: url)
            } else if let workbook {
                RanchSheetViewer(workbook: workbook, place: citedCell, onVersion: { showVersion($0) })
            } else {
                RanchLoading(text: "Reading the cells\u{2026}")
            }
        case .slides:
            if let slides {
                RanchSlidesView(slides: slides, slide: focus?.anchor?.slideNumber ?? 1)
            } else {
                RanchLoading(text: "Reading the slides\u{2026}")
            }
        case .code, .text:
            if let code {
                // Only code lines can be written by number to insert them.
                RanchCodeView(code: code, focusLine: focus?.anchor?.line, changes: passageChanges,
                              onChangeNote: { changeNote = $0 }) { lines in selectedLines = kind == .code ? lines : nil }
            } else {
                RanchLoading(text: "Reading the file\u{2026}")
            }
        case .mesh, .wireframe:
            if let scene {
                RanchSceneView(scene: scene, resetToken: reset)
                    .background(RanchTheme.card)
            } else {
                loading(kind == .mesh ? "Loading the model\u{2026}" : "Reading the model\u{2026}")
            }
        case .plan:
            if let plan {
                RanchPlanView(model: plan, resetToken: reset).background(RanchTheme.card)
            } else {
                loading("Reading the drawing\u{2026}")
            }
        }
    }

    @ViewBuilder
    private var notes: some View {
        if let changeNote {
            Text(changeNote)
                .font(RanchTheme.captionFont)
                .lineLimit(3)
                .frame(maxWidth: 520)
                .ranchTooltip()
                .padding(.bottom, 14)
        } else if kind == .code, let selectedLines {
            // What to write to insert these lines while typing elsewhere.
            HStack(spacing: 6) {
                Text(RanchCodeLines.label(selectedLines)).fontWeight(.semibold)
                Text("Write \u{201C}\(source.name) \(RanchCodeLines.label(selectedLines).lowercased())\u{201D} to insert \(selectedLines.count == 1 ? "it" : "them")")
                    .foregroundStyle(RanchTheme.onTooltipSecondary)
            }
            .font(RanchTheme.captionFont)
            .ranchTooltip()
            .padding(.bottom, 14)
        }
        if let hint = kind.hint, scene != nil || plan != nil {
            HStack(spacing: 10) {
                Text(hint).foregroundStyle(RanchTheme.onTooltipSecondary)
                Button { reset += 1 } label: {
                    Text("Reset View").fontWeight(.semibold)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Color.white.opacity(0.16)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            .font(RanchTheme.captionFont)
            .ranchTooltip()
            .padding(.bottom, 14)
        }
    }

    /// The spinner, and after a few seconds a word on why and a way past it.
    private func loading(_ text: String) -> some View {
        VStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(text).font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
            if slow {
                Text("A detailed model takes a while the first time. After that it opens at once.")
                    .font(RanchTheme.captionFont).foregroundStyle(RanchTheme.tertiaryInk)
                    .multilineTextAlignment(.center).frame(maxWidth: 280)
                Button { request?.cancel(); failed = true } label: { Label("Show in Quick Look", systemImage: "eye") }
                    .buttonStyle(RanchPillButtonStyle())
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func findCitedCell() {
        citedCell = workbook.flatMap { book in focus?.anchor.flatMap(book.place(of:)) }
    }

    /// Shows one version of the workbook, chosen from the viewer's version menu.
    private func showVersion(_ snapshotId: String) {
        request?.cancel()
        request = store.workbook(source, version: snapshotId) { book in
            if let book { workbook = book }
        }
    }

    /// The passages a text or PDF file's latest version changed, for its viewer to tint.
    private func loadPassageChanges() {
        // An answer about the file shown before must not tint this one.
        passageRequest?.cancel()
        passageRequest = nil
        passageChanges = []
        changeNote = nil
        guard source.fileExtension == "pdf" || RanchViewerKind.choose(for: source) == .text else { return }
        passageRequest = store.passageChanges(source) { passageChanges = $0 }
    }

    private func load() {
        request?.cancel()
        slow = false
        loadPassageChanges()
        switch RanchViewerKind.choose(for: source) {
        case .quickLook:
            return
        case .sheet:
            request = store.workbook(source) { book in
                if let book { workbook = book } else { failed = true }
            }
        case .slides:
            store.slides(source) { deck in
                if let deck { slides = deck } else { failed = true }
            }
        case .code, .text:
            let file = url
            // The file's own name: the copy shown may be stored under another.
            let name = source.name
            DispatchQueue.global(qos: .userInitiated).async {
                let read = (try? Data(contentsOf: file)).map { RanchCode(text: String(decoding: $0, as: UTF8.self), fileName: name) }
                DispatchQueue.main.async { if let read { code = read } else { failed = true } }
            }
        case .mesh:
            let file = url
            DispatchQueue.global(qos: .userInitiated).async {
                let loaded = try? RanchModelScene.mesh(at: file)
                DispatchQueue.main.async { if let loaded { scene = loaded } else { failed = true } }
            }
        case .wireframe:
            let dark = colorScheme == .dark
            noteIfSlow()
            request = store.modelPreview(source, elementId: focus?.anchor?.elementId) { model in
                if let model, let built = RanchModelScene.wireframe(model, dark: dark) { scene = built } else { failed = true }
            }
        case .plan:
            noteIfSlow()
            request = store.modelPreview(source, elementId: focus?.anchor?.elementId) { model in
                if let model { plan = model } else { failed = true }
            }
        }
    }

    private func noteIfSlow() {
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.slowAfter) {
            if scene == nil && plan == nil && !failed { slow = true }
        }
    }
}

struct RanchDirectorySummary: View {
    @ObservedObject var store: RanchStore
    let directory: RanchDirectory

    var body: some View {
        // Below the header's height, so the window's title bar never blurs over it.
        GeometryReader { geometry in
            ScrollView {
                summary.frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
        }
        .padding(.top, RanchTheme.headerHeight)
    }

    private var summary: some View {
        VStack(spacing: 18) {
            VStack(spacing: 8) {
                Image(systemName: directory.sidebarSymbol)
                    .font(.system(size: 26))
                    .foregroundStyle(directory.color)
                    .frame(width: 60, height: 60)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(directory.color.opacity(0.12)))
                Text(directory.name).font(.system(size: 18, weight: .semibold)).foregroundStyle(RanchTheme.ink)
                Text(directory.rootPath).font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
                    .textSelection(.enabled).multilineTextAlignment(.center)
            }
            VStack(spacing: 0) {
                ForEach(Array(facts.enumerated()), id: \.offset) { index, fact in
                    if index > 0 { RanchHairline().padding(.leading, 14) }
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Text(fact.label).foregroundStyle(RanchTheme.secondaryInk)
                        Spacer(minLength: 8)
                        Text(fact.value).foregroundStyle(fact.warning ? RanchTheme.warning : RanchTheme.ink)
                            .multilineTextAlignment(.trailing).lineLimit(2)
                    }
                    .font(.system(size: 12.5))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                }
            }
            .background {
                let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
                shape.fill(RanchTheme.control).overlay(shape.strokeBorder(RanchTheme.hairline, lineWidth: 1))
            }
            .frame(maxWidth: 440)
            if !directory.isApp && directory.available && !directory.offline {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory.rootPath)])
                } label: {
                    Label("Show in Finder", systemImage: "folder")
                }
                .buttonStyle(RanchPillButtonStyle())
            }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, RanchTheme.headerHeight)
    }

    private var facts: [(label: String, value: String, warning: Bool)] {
        var facts: [(String, String, Bool)] = [
            ("Files", directory.fileCount.formatted(), false),
            ("Last edited", RanchFormat.full(directory.lastEditedAt), false),
            ("Last used", directory.lastUsedAt.map(RanchFormat.full) ?? "Not used yet", false),
            ("Created", RanchFormat.full(directory.createdAt), false),
            ("Added to Lasso", RanchFormat.full(directory.addedAt), false),
        ]
        if !directory.active { facts.append(("Status", "Paused: suggestions are off for this directory", false)) }
        if let issue = directory.issue { facts.append(("Needs attention", issue, true)) }
        return facts
    }
}

/// A small spinner over what is being read.
struct RanchLoading: View {
    let text: String

    var body: some View {
        VStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(text).font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
