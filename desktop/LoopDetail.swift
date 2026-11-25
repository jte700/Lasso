// The right side of The Loop: the selected file, shown read-only, with the
// way out to the app that edits it, and ways to share it.

import Cocoa
import SceneKit
import SwiftUI

struct LoopDetail: View {
    @ObservedObject var store: LoopStore
    let actions: LoopActions

    var body: some View {
        Group {
            if let source = store.source(store.selectedSourceID) {
                // A new version of the file shows afresh rather than as Quick Look cached it.
                LoopSourceDetail(store: store, source: source, actions: actions).id(source.id + (source.contentHash ?? ""))
            } else if let item = store.reviewFocus {
                LoopReviewOnly(store: store, item: item)
            } else if let note = store.selectionNote, store.section == .changes {
                LoopEmptyState(symbol: "clock.arrow.circlepath", title: note.title, message: note.message)
            } else if case .directory(let id) = store.section, let directory = store.directory(id) {
                LoopDirectorySummary(store: store, directory: directory)
            } else {
                LoopEmptyState(symbol: "doc.text.magnifyingglass", title: "No File Selected",
                                message: "Choose a file to look through it here. To change it, use Edit, which opens it in its own app.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LoopTheme.surface)
        // With no file, the top of the column still moves the window.
        .background(alignment: .top) { LoopWindowDragArea().frame(height: LoopTheme.headerHeight) }
    }
}

struct LoopSourceDetail: View {
    @ObservedObject var store: LoopStore
    let source: LoopSource
    let actions: LoopActions
    @State private var file: Result<URL, Error>?
    @State private var editors = LoopEditorChoice.none
    @State private var shareError: String?
    @State private var citedCell: LoopCellPlace?

    /// The Needs Review item this file is shown for, if it is.
    private var review: LoopReviewItem? { store.reviewFocus.flatMap { $0.fileId == source.id ? $0 : nil } }

    var body: some View {
        VStack(spacing: 0) {
            header
            details
            if let review {
                LoopReviewPanel(store: store, item: review, cell: citedCell?.name,
                                 openAtCell: openAtCell, shareAgain: source.canShareLink ? createShareLink : nil)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .overlay(alignment: .bottom) { LoopHairline() }
            }
            switch file {
            case .none:
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failure(let error):
                LoopEmptyState(symbol: "externaldrive.badge.xmark", title: "Can\u{2019}t Show This File",
                                message: error.localizedDescription)
            case .success(let url):
                LoopFileViewer(store: store, source: source, url: url, focus: review == nil ? nil : store.focusedLink,
                                citedCell: $citedCell)
            }
        }
        .background(LoopTheme.surface)
        .onAppear {
            store.resolveFile(source) { file = $0 }
            // Asking macOS which apps open a file reads the disk, so it is done once per file.
            editors = LoopEditorChoice(url: localURL)
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
        .frame(height: LoopTheme.headerHeight)
        .background(LoopWindowDragArea())
        .overlay(alignment: .bottom) { LoopHairline() }
        .background { shortcuts }
    }

    private func headerRow(compact: Bool) -> some View {
        HStack(spacing: 10) {
            LoopFileIcon(url: localURL, fileExtension: source.fileExtension, size: 22)
            Text(source.name).font(LoopTheme.titleFont).foregroundStyle(LoopTheme.ink)
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
                LoopHiddenShortcut(key: "e") { editor.open(url) }
            }
            if source.canShareLink {
                LoopHiddenShortcut(key: "l", modifiers: [.command, .option], action: createShareLink)
            }
            // ⌥⌘L above and ⌥⌘R here: Lasso holds ⇧⌘L in every app, for opening The Loop.
            if let localURL {
                LoopHiddenShortcut(key: "r", modifiers: [.command, .option]) {
                    NSWorkspace.shared.activateFileViewerSelecting([localURL])
                }
            }
        }
    }

    /// Where the file is, when it changed, how big it is and how much it is used.
    private var details: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: "folder").imageScale(.small).foregroundStyle(LoopTheme.tertiaryInk)
                Text(([store.directoryName(source.directoryId)] + source.folder.split(separator: "/").map(String.init))
                    .joined(separator: " \u{203A} "))
                    .lineLimit(1).truncationMode(.middle)
                Text("\u{00B7} Edited \(LoopFormat.full(source.modifiedAt)) \u{00B7} \(LoopFormat.size(source.size))")
                    .lineLimit(1).layoutPriority(1)
            }
            HStack(spacing: 6) {
                if source.activity > 0 { LoopActivityDot(activity: source.activity) }
                Text(source.counts.summary).lineLimit(1).truncationMode(.tail)
            }
            if localURL == nil, case .success = file {
                LoopBanner(symbol: "externaldrive.badge.minus", tint: LoopTheme.warning,
                            text: "The drive this file is on isn\u{2019}t connected. This is the copy Lasso saved.")
            } else if let url = localURL, editors.primary == nil {
                LoopBanner(symbol: "info.circle", tint: LoopTheme.secondaryInk, text: LoopEditors.missingEditorHint(for: url))
            }
        }
        .font(LoopTheme.captionFont)
        .foregroundStyle(LoopTheme.secondaryInk)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { LoopHairline() }
    }

    @ViewBuilder
    private func fileActions(compact: Bool) -> some View {
        LoopEditButton(url: localURL, choice: editors, compact: compact)
        HStack(spacing: 2) {
            if case .success(let url) = file {
                ShareLink(item: url) { Label("Send a Copy", systemImage: "square.and.arrow.up") }
                    .buttonStyle(LoopIconButtonStyle())
                    .help("Send a copy with AirDrop, Mail, Messages and more")
            }
            // Code is sent as a copy of the file; Lasso makes no share links for it.
            if source.canShareLink {
                Button(action: createShareLink) { Label("Share Link", systemImage: "link") }
                    .buttonStyle(LoopIconButtonStyle())
                    .help("Copy a Lasso share link to this file. Links stop working after 48 hours. (\u{21E7}\u{2318}L)")
            }
            if let localURL {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([localURL])
                } label: {
                    Label("Show in Finder", systemImage: "folder")
                }
                .buttonStyle(LoopIconButtonStyle())
                .help("Show in Finder (\u{2325}\u{2318}R)")
            }
            Button { store.requestReview(source) } label: { Label("Request Review", systemImage: "person.badge.plus") }
                .buttonStyle(LoopIconButtonStyle())
                .help("Ask people to review this file")
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
struct LoopEditorChoice {
    let primary: LoopEditor?
    let others: [LoopEditor]

    static let none = LoopEditorChoice(primary: nil, others: [])

    init(primary: LoopEditor?, others: [LoopEditor]) {
        self.primary = primary
        self.others = others
    }

    init(url: URL?) {
        guard let url else { self = .none; return }
        let primary = LoopEditors.primary(for: url)
        self.init(primary: primary, others: LoopEditors.alternatives(for: url, excluding: primary))
    }
}

/// A short note about the file, on a wash of its colour.
struct LoopBanner: View {
    let symbol: String
    let tint: Color
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(text).foregroundStyle(LoopTheme.ink.opacity(0.8)).fixedSize(horizontal: false, vertical: true)
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
struct LoopEditButton: View {
    let url: URL?
    let choice: LoopEditorChoice
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
                    LoopTheme.controlEdge.frame(width: 1, height: 16)
                    Menu {
                        Section("Open With") {
                            ForEach(choice.others) { other in
                                Button { other.open(url) } label: { menuLabel(other) }
                            }
                        }
                    } label: {
                        Image(systemName: "chevron.down").font(.system(size: 8.5, weight: .semibold))
                            .foregroundStyle(LoopTheme.secondaryInk)
                            .frame(width: 26, height: 28)
                            .contentShape(Rectangle())
                    }
                    .modifier(LoopPlainMenuStyle())
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Open in another app")
                }
            }
            .font(LoopTheme.controlFont)
            .foregroundStyle(LoopTheme.ink)
            .background(LoopPillShape(hovering: hovering))
            .onHover { hovering = $0 }
            .fixedSize()
        } else if let url, !choice.others.isEmpty {
            LoopPillMenu(title: compact ? "Open" : "Open With", symbol: "arrow.up.forward.app",
                          help: "No app on this Mac edits this file; open it in one that can show it") {
                ForEach(choice.others) { app in Button { app.open(url) } label: { menuLabel(app, verb: "Open in") } }
            }
        } else if url == nil {
            Button {} label: { Label("Edit", systemImage: "pencil") }
                .buttonStyle(LoopPillButtonStyle())
                .disabled(true)
                .help("Connect the drive this file is on to edit it")
        }
    }

    private func pillLabel(_ editor: LoopEditor) -> some View {
        HStack(spacing: 6) {
            if let icon = editor.icon {
                Image(nsImage: icon).resizable().interpolation(.high).frame(width: 16, height: 16)
            } else {
                Image(systemName: "pencil").imageScale(.small)
            }
            Text(compact ? "Edit" : "Edit in \(editor.name)").lineLimit(1)
        }
    }

    private func menuLabel(_ editor: LoopEditor, verb: String = "Edit in") -> some View {
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
struct LoopFileViewer: View {
    @ObservedObject var store: LoopStore
    let source: LoopSource
    let url: URL
    var focus: LoopReviewLink? = nil
    /// The cell `focus` cites, once the sheet view has found it.
    @Binding var citedCell: LoopCellPlace?
    @State private var scene: SCNScene?
    @State private var plan: AssistModelPreview?
    @State private var workbook: LoopWorkbook?
    @State private var slides: SlideDeckDocument?
    @State private var failed = false
    @State private var reset = 0
    @State private var code: LoopCode?
    @State private var selectedLines: ClosedRange<Int>?
    /// Passages of a text or PDF file its latest version changed, and the note of the one pointed at or selected.
    @State private var passageChanges: [LoopPassageChange] = []
    @State private var changeNote: String?
    @State private var passageRequest: URLSessionDataTask?
    @State private var request: URLSessionDataTask?
    /// A model or drawing still being read after a few seconds.
    @State private var slow = false
    /// Quick Look's rendering of a workbook's own layout, instead of its cells.
    @AppStorage("LoopSheetLayout") private var originalLayout = false
    @Environment(\.colorScheme) private var colorScheme

    private static let slowAfter: TimeInterval = 4

    private var kind: LoopViewerKind { failed ? .quickLook : LoopViewerKind.choose(for: source) }

    var body: some View {
        VStack(spacing: 0) {
            if LoopViewerKind.choose(for: source) == .sheet && !failed {
                LoopFilterBar {
                    LoopSegmented(selection: $originalLayout, options: [(false, "Cells"), (true, "Original Layout")])
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
                LoopPDFView(url: url, page: focus.map { $0.anchor?.pageNumber ?? 1 }, find: focus?.linkedValue,
                             changes: passageChanges, onChangeNote: { changeNote = $0 })
            } else {
                LoopQuickLookView(url: url)
            }
        case .sheet:
            if originalLayout {
                LoopQuickLookView(url: url)
            } else if let workbook {
                LoopSheetViewer(workbook: workbook, place: citedCell, onVersion: { showVersion($0) })
            } else {
                LoopLoading(text: "Reading the cells\u{2026}")
            }
        case .slides:
            if let slides {
                LoopSlidesView(slides: slides, slide: focus?.anchor?.slideNumber ?? 1)
            } else {
                LoopLoading(text: "Reading the slides\u{2026}")
            }
        case .code, .text:
            if let code {
                // Only code lines can be written by number to insert them.
                LoopCodeView(code: code, focusLine: focus?.anchor?.line, changes: passageChanges,
                              onChangeNote: { changeNote = $0 }) { lines in selectedLines = kind == .code ? lines : nil }
            } else {
                LoopLoading(text: "Reading the file\u{2026}")
            }
        case .mesh, .wireframe:
            if let scene {
                LoopSceneView(scene: scene, resetToken: reset)
                    .background(LoopTheme.card)
            } else {
                loading(kind == .mesh ? "Loading the model\u{2026}" : "Reading the model\u{2026}")
            }
        case .plan:
            if let plan {
                LoopPlanView(model: plan, resetToken: reset).background(LoopTheme.card)
            } else {
                loading("Reading the drawing\u{2026}")
            }
        }
    }

    @ViewBuilder
    private var notes: some View {
        if let changeNote {
            Text(changeNote)
                .font(LoopTheme.captionFont)
                .lineLimit(3)
                .frame(maxWidth: 520)
                .loopTooltip()
                .padding(.bottom, 14)
        } else if kind == .code, let selectedLines {
            // What to write to insert these lines while typing elsewhere.
            HStack(spacing: 6) {
                Text(LoopCodeLines.label(selectedLines)).fontWeight(.semibold)
                Text("Write \u{201C}\(source.name) \(LoopCodeLines.label(selectedLines).lowercased())\u{201D} to insert \(selectedLines.count == 1 ? "it" : "them")")
                    .foregroundStyle(LoopTheme.onTooltipSecondary)
            }
            .font(LoopTheme.captionFont)
            .loopTooltip()
            .padding(.bottom, 14)
        }
        if let hint = kind.hint, scene != nil || plan != nil {
            HStack(spacing: 10) {
                Text(hint).foregroundStyle(LoopTheme.onTooltipSecondary)
                Button { reset += 1 } label: {
                    Text("Reset View").fontWeight(.semibold)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Color.white.opacity(0.16)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            .font(LoopTheme.captionFont)
            .loopTooltip()
            .padding(.bottom, 14)
        }
    }

    /// The spinner, and after a few seconds a word on why and a way past it.
    private func loading(_ text: String) -> some View {
        VStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(text).font(LoopTheme.captionFont).foregroundStyle(LoopTheme.secondaryInk)
            if slow {
                Text("A detailed model takes a while the first time. After that it opens at once.")
                    .font(LoopTheme.captionFont).foregroundStyle(LoopTheme.tertiaryInk)
                    .multilineTextAlignment(.center).frame(maxWidth: 280)
                Button { request?.cancel(); failed = true } label: { Label("Show in Quick Look", systemImage: "eye") }
                    .buttonStyle(LoopPillButtonStyle())
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
        guard source.fileExtension == "pdf" || LoopViewerKind.choose(for: source) == .text else { return }
        passageRequest = store.passageChanges(source) { passageChanges = $0 }
    }

    private func load() {
        request?.cancel()
        slow = false
        loadPassageChanges()
        switch LoopViewerKind.choose(for: source) {
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
                let read = (try? Data(contentsOf: file)).map { LoopCode(text: String(decoding: $0, as: UTF8.self), fileName: name) }
                DispatchQueue.main.async { if let read { code = read } else { failed = true } }
            }
        case .mesh:
            let file = url
            DispatchQueue.global(qos: .userInitiated).async {
                let loaded = try? LoopModelScene.mesh(at: file)
                DispatchQueue.main.async { if let loaded { scene = loaded } else { failed = true } }
            }
        case .wireframe:
            let dark = colorScheme == .dark
            noteIfSlow()
            request = store.modelPreview(source, elementId: focus?.anchor?.elementId) { model in
                if let model, let built = LoopModelScene.wireframe(model, dark: dark) { scene = built } else { failed = true }
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

struct LoopDirectorySummary: View {
    @ObservedObject var store: LoopStore
    let directory: LoopDirectory

    var body: some View {
        // Below the header's height, so the window's title bar never blurs over it.
        GeometryReader { geometry in
            ScrollView {
                summary.frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
        }
        .padding(.top, LoopTheme.headerHeight)
    }

    private var summary: some View {
        VStack(spacing: 18) {
            VStack(spacing: 8) {
                Image(systemName: directory.sidebarSymbol)
                    .font(.system(size: 26))
                    .foregroundStyle(directory.color)
                    .frame(width: 60, height: 60)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(directory.color.opacity(0.12)))
                Text(directory.name).font(.system(size: 18, weight: .semibold)).foregroundStyle(LoopTheme.ink)
                Text(directory.rootPath).font(LoopTheme.captionFont).foregroundStyle(LoopTheme.secondaryInk)
                    .textSelection(.enabled).multilineTextAlignment(.center)
            }
            VStack(spacing: 0) {
                ForEach(Array(facts.enumerated()), id: \.offset) { index, fact in
                    if index > 0 { LoopHairline().padding(.leading, 14) }
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Text(fact.label).foregroundStyle(LoopTheme.secondaryInk)
                        Spacer(minLength: 8)
                        Text(fact.value).foregroundStyle(fact.warning ? LoopTheme.warning : LoopTheme.ink)
                            .multilineTextAlignment(.trailing).lineLimit(2)
                    }
                    .font(.system(size: 12.5))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                }
            }
            .background {
                let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
                shape.fill(LoopTheme.control).overlay(shape.strokeBorder(LoopTheme.hairline, lineWidth: 1))
            }
            .frame(maxWidth: 440)
            if !directory.isApp && directory.available && !directory.offline {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory.rootPath)])
                } label: {
                    Label("Show in Finder", systemImage: "folder")
                }
                .buttonStyle(LoopPillButtonStyle())
            }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, LoopTheme.headerHeight)
    }

    private var facts: [(label: String, value: String, warning: Bool)] {
        var facts: [(String, String, Bool)] = [
            ("Files", directory.fileCount.formatted(), false),
            ("Last edited", LoopFormat.full(directory.lastEditedAt), false),
            ("Last used", directory.lastUsedAt.map(LoopFormat.full) ?? "Not used yet", false),
            ("Created", LoopFormat.full(directory.createdAt), false),
            ("Added to Lasso", LoopFormat.full(directory.addedAt), false),
        ]
        if !directory.active { facts.append(("Status", "Paused: suggestions are off for this directory", false)) }
        if let issue = directory.issue { facts.append(("Needs attention", issue, true)) }
        return facts
    }
}

/// A small spinner over what is being read.
struct LoopLoading: View {
    let text: String

    var body: some View {
        VStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(text).font(LoopTheme.captionFont).foregroundStyle(LoopTheme.secondaryInk)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
