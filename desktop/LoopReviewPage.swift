// The Loop's Review Changes page: one card per folder, after the reference
// clip's pull request review. Its head names the folder and who changed what
// since it was last approved, with Approve, which spins, turns into a pale
// "Approved" and slides a banner down ("You approved these changes with 1
// comment", Undo). Below, a tab per changed file with its comment count and
// a tick once looked at, and "1/5 viewed" filling as files are; then the open
// file's changes, drawn for its kind, with its conversations.

import SwiftUI

struct LoopReviewPage: View {
    @ObservedObject var store: LoopStore
    @ObservedObject var model: LoopReviewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                chips
                if let review = model.review, review.state != "empty" || model.tabs(review).count > 0 {
                    LoopReviewCard(store: store, model: model, review: review)
                } else if model.review != nil || model.folders.isEmpty {
                    empty
                }
            }
            .padding(.horizontal, 28).padding(.vertical, 24)
            .frame(maxWidth: 1180, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onAppear { model.serverURL = store.serverURL; model.refresh() }
        .onChange(of: store.overview.history.first?.id) { _ in model.refresh() }
        .overlay(alignment: .bottom) { problem }
        .overlay {
            if let draft = model.draft {
                LoopNewReviewOverlay(store: store, model: model, draft: draft).transition(.opacity)
            }
        }
        .animation(.spring(response: 0.42, dampingFraction: 0.86), value: model.draft)
    }

    /// Reviews asked for by name that are still open, and the one open now.
    private var shownRequests: [LoopReviewRequest] {
        model.requests.filter { $0.state == "open" || $0.id == model.chosenRequest }
    }

    /// Folders with something waiting, and the one open now.
    private var shownFolders: [LoopReviewFolder] {
        model.folders.filter { $0.state != "empty" || $0.id == model.chosenFolder }
    }

    private var chips: some View {
        HStack(spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    if shownFolders.count + shownRequests.count > 1 || !shownRequests.isEmpty {
                        folderChips
                        ForEach(shownRequests) { asked in requestChip(asked) }
                    }
                }
            }
            Spacer(minLength: 0)
            Button { model.startReview(folder: model.chosenFolder) } label: {
                Label("New Review", systemImage: "plus")
                    .font(LoopLook.font(13.5, .medium)).foregroundStyle(LoopLook.onSky)
                    .padding(.horizontal, 14).frame(height: 34)
                    .background(Capsule().fill(LoopLook.sky))
                    .contentShape(Capsule())
            }
            .buttonStyle(LoopDipButtonStyle())
            .help("Ask for a review: choose reviewers and the files to look at")
        }
    }

    private func requestChip(_ asked: LoopReviewRequest) -> some View {
        let chosen = asked.id == model.chosenRequest
        return Button { model.choose(request: asked.id) } label: {
            HStack(spacing: 8) {
                Image(systemName: asked.state == "approved" ? "checkmark.circle" : "person.2")
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(LoopLook.sky)
                Text(asked.title).font(LoopLook.font(13.5, chosen ? .medium : .regular))
                    .foregroundStyle(chosen ? LoopLook.ink : LoopLook.ink2).lineLimit(1)
                Text("\(asked.files)").font(LoopLook.font(12, .medium)).foregroundStyle(LoopLook.ink3)
            }
            .padding(.horizontal, 14).frame(height: 34)
            .background(Capsule().fill(chosen ? LoopLook.raise : .clear))
            .overlay(Capsule().strokeBorder(LoopLook.line, lineWidth: chosen ? 0 : 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var folderChips: some View {
        ForEach(shownFolders) { folder in
                    let chosen = folder.id == model.chosenFolder && model.chosenRequest == nil
                    Button { model.choose(folder: folder.id) } label: {
                        HStack(spacing: 8) {
                            Circle().fill(store.directory(folder.id)?.color ?? LoopLook.ink3).frame(width: 7, height: 7)
                            Text(folder.name).font(LoopLook.font(13.5, chosen ? .medium : .regular))
                                .foregroundStyle(chosen ? LoopLook.ink : LoopLook.ink2)
                            if folder.state == "open" && folder.files > 0 {
                                Text("\(folder.files)").font(LoopLook.font(12, .medium)).foregroundStyle(LoopLook.ink3)
                            }
                        }
                        .padding(.horizontal, 14).frame(height: 34)
                        .background(Capsule().fill(chosen ? LoopLook.raise : .clear))
                        .overlay(Capsule().strokeBorder(LoopLook.line, lineWidth: chosen ? 0 : 1))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Nothing to review").font(LoopLook.font(17, .medium)).foregroundStyle(LoopLook.ink)
            Text("When someone edits a file in a switched-on folder, it waits here until it is approved. To ask people to look at files, choose New Review, or Request Review on a file.")
                .font(LoopLook.font(14)).foregroundStyle(LoopLook.ink2)
        }
        .padding(.top, 40)
    }

    @ViewBuilder private var problem: some View {
        if let message = model.problem {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.circle").foregroundStyle(LoopLook.terracottaSoft)
                Text(message).font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink).lineLimit(3)
                Button { withAnimation(LoopLook.spring) { model.problem = nil } } label: {
                    Image(systemName: "xmark").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(LoopLook.ink3)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16).frame(minHeight: 44)
            .background(Capsule().fill(LoopLook.lift))
            .overlay(Capsule().strokeBorder(LoopLook.line, lineWidth: 1))
            .padding(.bottom, 24)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: message) {
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                withAnimation(LoopLook.spring) { if model.problem == message { model.problem = nil } }
            }
        }
    }
}

struct LoopReviewCard: View {
    @ObservedObject var store: LoopStore
    @ObservedObject var model: LoopReviewModel
    let review: LoopReview

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head.padding(.horizontal, 28).padding(.top, 24)
            if let note = review.note, !note.isEmpty {
                Text(note).font(LoopLook.font(14)).foregroundStyle(LoopLook.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(LoopLook.raise.opacity(0.6)))
                    .padding(.horizontal, 28).padding(.top, 16)
            }
            if let approval = review.approval {
                banner(approval).padding(.horizontal, 28).padding(.top, 16)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            if !model.tabs(review).isEmpty {
                tabs.padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 14)
                LoopLook.line.frame(height: 1)
                if let chosen = model.tabs(review).first(where: { $0.path == model.chosenFile }) {
                    LoopReviewFileArea(store: store, model: model, file: chosen, view: model.files[chosen.path])
                        .id(chosen.path)
                }
            } else {
                Text(review.state == "approved" ? "Everything here has been looked at and approved." : "Nothing here waits for review.")
                    .font(LoopLook.font(14)).foregroundStyle(LoopLook.ink3)
                    .padding(28)
            }
        }
        .background(RoundedRectangle(cornerRadius: LoopLook.cardRadius + 6, style: .continuous).fill(LoopLook.panel))
        .overlay(RoundedRectangle(cornerRadius: LoopLook.cardRadius + 6, style: .continuous).strokeBorder(LoopLook.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: LoopLook.cardRadius + 6, style: .continuous))
        .animation(.spring(response: 0.5, dampingFraction: 0.86), value: review.approval)
    }

    private var head: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                (Text(review.title ?? review.name).foregroundColor(LoopLook.ink)
                    + Text(review.number.map { "  #\($0)" } ?? "  v\(review.current.version)").foregroundColor(LoopLook.ink3))
                    .font(LoopLook.font(21, .medium))
                HStack(spacing: 10) {
                    HStack(spacing: -7) {
                        if let reviewers = review.reviewers, review.requestId != nil {
                            ForEach(reviewers.prefix(4), id: \.email) { reviewer in
                                LoopReviewAvatar(actor: LoopReviewActor(id: "email:\(reviewer.email)", name: reviewer.name, type: "HUMAN_COLLABORATOR"),
                                                  size: 22)
                                    .overlay(Circle().strokeBorder(LoopLook.panel, lineWidth: 2))
                                    .help("\(reviewer.name), \(reviewer.email): asked to review")
                            }
                        } else {
                            ForEach(review.people.prefix(3), id: \.id) { person in
                                LoopReviewAvatar(actor: person, size: 22).overlay(Circle().strokeBorder(LoopLook.panel, lineWidth: 2))
                            }
                        }
                    }
                    Text(LoopReviewWords.headline(review)).font(LoopLook.font(14)).foregroundStyle(LoopLook.ink2).lineLimit(2)
                    if review.saves > 0 && review.requestId == nil {
                        Text(review.saves == 1 ? "1 save" : "\(review.saves.formatted()) saves")
                            .font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink2)
                            .padding(.horizontal, 8).frame(height: 22).background(Capsule().fill(LoopLook.raise))
                    }
                }
            }
            Spacer(minLength: 12)
            if review.requestId == nil {
                Button { model.startReview(folder: review.directoryId) } label: {
                    Image(systemName: "person.badge.plus").font(.system(size: 14)).foregroundStyle(LoopLook.ink2)
                        .frame(width: 40, height: 40).background(Circle().fill(LoopLook.raise))
                }
                .buttonStyle(LoopDipButtonStyle())
                .help("Ask people to review these changes")
            }
            LoopApproveButton(approved: review.approval != nil, working: model.approving,
                               enabled: !model.tabs(review).isEmpty) { model.approve() }
        }
    }

    private func banner(_ approval: LoopReview.Approval) -> some View {
        let words = LoopReviewWords.approved(approval)
        return HStack(spacing: 10) {
            Image(systemName: "checkmark.circle").font(.system(size: 14, weight: .medium)).foregroundStyle(LoopLook.sky)
            (Text(words.lead).foregroundColor(LoopLook.ink).font(LoopLook.font(14, .medium))
                + Text(words.rest.isEmpty ? "" : " \(words.rest)").foregroundColor(LoopLook.ink3).font(LoopLook.font(14)))
            Spacer(minLength: 8)
            LoopReviewQuietButton(title: "Undo") { model.undo() }
        }
        .padding(.leading, 16).padding(.trailing, 6).frame(height: 48)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(LoopLook.sky.opacity(0.1)))
    }

    private var tabs: some View {
        HStack(spacing: 14) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(model.tabs(review)) { file in
                        LoopReviewTab(file: file, chosen: file.path == model.chosenFile) {
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) { model.chosenFile = file.path }
                        }
                    }
                    if review.moreFiles > 0 {
                        Text("and \(review.moreFiles.formatted()) more").font(LoopLook.font(13)).foregroundStyle(LoopLook.ink3)
                            .padding(.horizontal, 8)
                    }
                }
            }
            HStack(spacing: 10) {
                (Text("\(review.viewedCount)").foregroundColor(LoopLook.ink) + Text("/\(review.files.count) viewed").foregroundColor(LoopLook.ink3))
                    .font(LoopLook.font(13)).monospacedDigit().fixedSize()
                ZStack(alignment: .leading) {
                    Capsule().fill(LoopLook.track)
                    Capsule().fill(LoopLook.sky)
                        .frame(width: 72 * CGFloat(review.viewedCount) / CGFloat(max(1, review.files.count)))
                }
                .frame(width: 72, height: 4)
                .animation(.spring(response: 0.5, dampingFraction: 0.85), value: review.viewedCount)
            }
        }
    }
}

/// Approve: spins while it is sent, then reads "Approved" in a pale capsule.
struct LoopApproveButton: View {
    let approved: Bool
    let working: Bool
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if working {
                    TimelineView(.animation) { context in
                        Circle().trim(from: 0, to: 0.72)
                            .stroke(LoopLook.onSky, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                            .frame(width: 15, height: 15)
                            .rotationEffect(.degrees(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.8) / 0.8 * 360))
                    }
                    .transition(.scale(scale: 0.5).combined(with: .opacity))
                } else if approved {
                    Label("Approved", systemImage: "checkmark").transition(.opacity.combined(with: .scale(scale: 0.9)))
                } else {
                    Text("Approve").transition(.opacity)
                }
            }
            .font(LoopLook.font(14.5, .medium))
            .foregroundStyle(approved && !working ? LoopLook.sky : LoopLook.onSky)
            .frame(minWidth: 70)
            .padding(.horizontal, 20).frame(height: 40)
            .background(Capsule().fill(approved && !working ? LoopLook.sky.opacity(0.16) : LoopLook.sky.opacity(enabled ? 1 : 0.35)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(working || approved || !enabled)
        .animation(.spring(response: 0.42, dampingFraction: 0.8), value: approved)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: working)
        .help(approved ? "Approved. A new save starts the next review." : "Approve everything changed here since it was last approved")
    }
}

struct LoopReviewTab: View {
    let file: LoopReview.File
    let chosen: Bool
    let action: () -> Void

    var body: some View {
        LoopHover { hovering in
            Button(action: action) {
                HStack(spacing: 7) {
                    ZStack {
                        if file.viewed {
                            Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(LoopLook.sky)
                                .transition(.scale(scale: 0.4).combined(with: .opacity))
                        } else {
                            Image(systemName: Self.symbol(file.kind)).font(.system(size: 11.5)).foregroundStyle(LoopLook.ink3)
                                .transition(.opacity)
                        }
                    }
                    .frame(width: 14)
                    Text(file.name).font(LoopLook.font(14, chosen ? .medium : .regular))
                        .foregroundStyle(chosen ? LoopLook.ink : LoopLook.ink2).lineLimit(1)
                    if file.comments > 0 {
                        HStack(spacing: 3) {
                            Image(systemName: "bubble.left").font(.system(size: 10.5))
                            Text("\(file.comments)").font(LoopLook.font(12.5)).monospacedDigit()
                        }
                        .foregroundStyle(LoopLook.ink3)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                }
                .padding(.horizontal, 12).frame(height: 34)
                .background(RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(chosen ? LoopLook.raise : hovering ? LoopLook.raise.opacity(0.5) : .clear))
                .contentShape(Rectangle())
                .animation(.spring(response: 0.35, dampingFraction: 0.75), value: file.viewed)
                .animation(.spring(response: 0.35, dampingFraction: 0.75), value: file.comments)
            }
            .buttonStyle(.plain)
        }
    }

    static func symbol(_ kind: String) -> String {
        switch kind {
        case "sheet": return "tablecells"
        case "lines": return "doc.text"
        case "values": return "doc.richtext"
        default: return "doc"
        }
    }
}

/// The open file: its path, what kind of change, its counts and Viewed; then its changes and conversations.
struct LoopReviewFileArea: View {
    @ObservedObject var store: LoopStore
    @ObservedObject var model: LoopReviewModel
    let file: LoopReview.File
    let view: LoopReviewFileView?
    @State private var composing: LoopReviewPlace?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.padding(.horizontal, 28).frame(height: 54)
            LoopLook.line2.frame(height: 1)
            if let view {
                content(view)
            } else {
                Text("Reading the changes\u{2026}").font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink3)
                    .padding(28).frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
            }
        }
        .animation(.spring(response: 0.42, dampingFraction: 0.88), value: view)
        .animation(.spring(response: 0.42, dampingFraction: 0.88), value: composing)
        .onAppear(perform: openIfAsked)
        .onChange(of: view?.path) { _ in openIfAsked() }
        .onChange(of: model.composeFor) { _ in openIfAsked() }
    }

    /// Opens the comment box on the file someone chose Request a Change for. It reads the
    /// file from the model: on macOS 13 a change handler still sees this view's earlier values.
    private func openIfAsked() {
        guard model.composeFor == file.path, let view = model.files[file.path] else { return }
        model.composeFor = nil
        withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { composing = filePlace(view) }
    }

    private var header: some View {
        let folder = (file.path as NSString).deletingLastPathComponent
        return HStack(spacing: 12) {
            (Text(folder.isEmpty ? "" : "\(folder)/").foregroundColor(LoopLook.ink3) + Text(file.name).foregroundColor(LoopLook.ink))
                .font(view?.code == true ? .system(size: 13, design: .monospaced) : LoopLook.font(14, .medium)).lineLimit(1).truncationMode(.head)
            Text(LoopReviewWords.change(file.change)).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink2)
                .padding(.horizontal, 8).frame(height: 22).background(Capsule().fill(LoopLook.raise))
            counts
            if let previous = file.previousPath {
                Text("was \(previous)").font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3).lineLimit(1)
            }
            Spacer(minLength: 8)
            if file.change != "removed" {
                LoopHover { hovering in
                    Button { model.setViewed(file, !file.viewed) } label: {
                        HStack(spacing: 8) {
                            LoopReviewCheckbox(on: file.viewed)
                            Text("Viewed").font(LoopLook.font(13.5)).foregroundStyle(hovering ? LoopLook.ink : LoopLook.ink2)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder private var counts: some View {
        if file.change == "unchanged" || file.change == "review" {
            EmptyView()
        } else if let lines = view?.lines {
            HStack(spacing: 6) {
                Text("+\(lines.added.formatted())").foregroundStyle(LoopLook.lime)
                Text("\u{2212}\(lines.removed.formatted())").foregroundStyle(LoopLook.terracottaSoft)
            }
            .font(LoopLook.font(13, .medium)).monospacedDigit()
        } else if let grid = view?.sheet {
            Text(LoopReviewWords.sheetCounts(grid.counts)).font(LoopLook.font(13)).foregroundStyle(LoopLook.ink2)
        } else if let values = view?.values, view?.valueCount ?? 0 > 0 {
            Text(values.count == 1 ? "1 passage or value" : "\((view?.valueCount ?? values.count).formatted()) passages and values")
                .font(LoopLook.font(13)).foregroundStyle(LoopLook.ink2)
        }
    }

    @ViewBuilder private func content(_ view: LoopReviewFileView) -> some View {
        let loose = view.threads.filter { $0.position == nil }
        VStack(spacing: 0) {
            if !loose.isEmpty {
                LoopReviewPinned(model: model, store: store, file: view, threads: loose, place: nil, composing: $composing, send: send)
            }
            switch view.kind {
            case "lines" where view.lines != nil:
                LoopReviewLinesBody(model: model, store: store, file: view, lines: view.lines!, composing: $composing, send: send)
            case "sheet" where view.sheet != nil:
                LoopReviewSheetBody(model: model, store: store, file: view, grid: view.sheet!, composing: $composing, send: send)
            case "values" where view.values?.isEmpty == false:
                LoopReviewValuesBody(model: model, store: store, file: view, values: view.values!, composing: $composing, send: send)
            default:
                Text(nothingShown(view)).font(LoopLook.font(14)).foregroundStyle(LoopLook.ink2)
                    .padding(.horizontal, 28).padding(.vertical, 22).frame(maxWidth: .infinity, alignment: .leading)
            }
            LoopReviewPinned(model: model, store: store, file: view, threads: [], place: filePlace(view), composing: $composing, send: send)
            footer(view)
        }
    }

    private func filePlace(_ view: LoopReviewFileView) -> LoopReviewPlace {
        LoopReviewPlace(path: view.path, anchor: ["kind": "file"], label: nil, current: nil)
    }

    private func footer(_ view: LoopReviewFileView) -> some View {
        HStack(spacing: 10) {
            if composing != filePlace(view) {
                Button { withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { composing = filePlace(view) } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus.bubble").font(.system(size: 12))
                        Text("Comment on this file").font(LoopLook.font(13.5))
                    }
                    .foregroundStyle(LoopLook.ink2)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
            if !view.writable && view.kind != "file" {
                Text("Lasso doesn\u{2019}t write this kind of file. A suggestion here is made in its own app.")
                    .font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
            }
        }
        .padding(.horizontal, 28).frame(minHeight: 50)
        .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
    }

    private func nothingShown(_ view: LoopReviewFileView) -> String {
        switch view.change {
        case "unchanged": return "No one has edited this file. Comment on it to ask for a change."
        case "removed": return "Removed from the folder. Lasso keeps its last version."
        case "renamed", "moved": return "Only its name or place changed."
        default:
            return view.kind == "file" ? "Lasso doesn\u{2019}t read inside this kind of file, so there is nothing to show line by line."
                : "Nothing Lasso reads in this file changed."
        }
    }

    private func send(_ place: LoopReviewPlace, _ text: String, _ suggestion: String?) {
        withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { composing = nil }
        if LoopReviewWords.isPrompt(text) {
            model.ask(path: file.path, anchor: place.anchor, prompt: text) { _ in }
            return
        }
        let suggested: [String: Any]? = suggestion.map { ["before": place.current ?? NSNull(), "after": $0] }
        model.comment(path: file.path, anchor: place.anchor, body: text, suggestion: suggested) { _ in }
    }
}
