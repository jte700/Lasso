// A new review, put together over the Review Changes page in two steps on
// one card: Add Reviewers (RanchInvitePeople), then the request itself, its
// title, folder, files and a note, as a pull request is written. The card
// grows from one step to the next on the component's soft spring. Create
// Review asks for it and opens it as the review card. Reviewers are recorded
// only; nothing is sent to them.

import SwiftUI

struct RanchNewReviewOverlay: View {
    @ObservedObject var store: RanchStore
    @ObservedObject var model: RanchReviewModel
    let draft: RanchReviewDraft

    enum Step { case reviewers, request }

    @State private var step = Step.reviewers
    @State private var people: [RanchInvitee] = []
    @State private var title = ""
    @State private var note = ""
    @State private var folder: String?
    @State private var chosen: [String] = []
    @State private var search = ""
    @State private var creating = false

    var body: some View {
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea()
                .onTapGesture(perform: cancel)
            card
                .transition(.scale(scale: 0.96).combined(with: .opacity))
        }
        .onAppear {
            folder = draft.folder
            chosen = draft.paths
        }
        .onExitCommand(perform: cancel)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch step {
            case .reviewers:
                RanchInvitePeople(people: $people)
                    .transition(.asymmetric(insertion: .opacity, removal: .opacity.combined(with: .move(edge: .leading))))
                footer(back: ("Cancel", cancel), next: ("Next", { go(.request) }), enabled: true)
                    .padding(.top, 18)
            case .request:
                request
                    .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .trailing)), removal: .opacity))
            }
        }
        .padding(20)
        .frame(width: step == .reviewers ? 400 : 600)
        .background(RoundedRectangle(cornerRadius: RanchLook.cardRadius + 4, style: .continuous).fill(RanchLook.panel))
        .overlay(RoundedRectangle(cornerRadius: RanchLook.cardRadius + 4, style: .continuous).strokeBorder(RanchLook.line, lineWidth: 1))
        .shadow(color: .black.opacity(0.45), radius: 40, y: 18)
        .animation(RanchInviteSprings.soft, value: step)
    }

    private func go(_ next: Step) {
        withAnimation(RanchInviteSprings.soft) { step = next }
    }

    private func cancel() {
        withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { model.draft = nil }
    }

    private func footer(back: (String, () -> Void), next: (String, () -> Void), enabled: Bool) -> some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            RanchReviewQuietButton(title: back.0, action: back.1)
            RanchReviewFilledButton(title: next.0, enabled: enabled, action: next.1)
        }
    }

    // MARK: The request

    private var folders: [RanchDirectory] {
        store.overview.directories.filter { $0.active && $0.kind != "app" }
    }

    private var files: [RanchSource] {
        guard let folder else { return [] }
        let all = store.overview.sources.filter { $0.directoryId == folder }
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        let matched = query.isEmpty ? all : all.filter { $0.path.lowercased().contains(query) }
        // Chosen files first, then the most recently changed.
        return matched.sorted { left, right in
            let (l, r) = (chosen.contains(left.path), chosen.contains(right.path))
            if l != r { return l }
            return (left.modifiedAt ?? .distantPast) > (right.modifiedAt ?? .distantPast)
        }
    }

    private var request: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("New Review").font(RanchLook.font(18, .semibold)).foregroundStyle(RanchLook.ink)
                RanchRollText(text: chosen.count == 1 ? "1 file" : "\(chosen.count) files")
                    .font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3).monospacedDigit()
            }
            reviewersLine
            field("Title", text: $title, prompt: "What should be looked at, e.g. Check the Q3 figures")
            if folders.count > 1 { folderPicker }
            filePicker
            field("Note", text: $note, prompt: "Anything reviewers should know (optional)", lines: 2...5)
            footer(back: ("Back", { go(.reviewers) }), next: (creating ? "Creating\u{2026}" : "Create Review", create),
                   enabled: !chosen.isEmpty && !creating)
        }
    }

    private var reviewersLine: some View {
        Button { go(.reviewers) } label: {
            HStack(spacing: 10) {
                if people.isEmpty {
                    Image(systemName: "person.badge.plus").font(.system(size: 12)).foregroundStyle(RanchLook.ink3)
                } else {
                    HStack(spacing: -7) {
                        ForEach(people.prefix(4)) { person in
                            RanchReviewAvatar(actor: RanchReviewActor(id: "email:\(person.email)", name: person.name, type: "HUMAN_COLLABORATOR"),
                                              size: 22)
                                .overlay(Circle().strokeBorder(RanchLook.panel, lineWidth: 2))
                        }
                    }
                }
                Text(people.isEmpty ? "No reviewers. Add some" : "Reviewers: \(RanchReviewWords.reviewerNames(people.map { RanchReviewer(name: $0.name, email: $0.email) }))")
                    .font(RanchLook.font(13.5)).foregroundStyle(RanchLook.ink2).lineLimit(1)
                Spacer(minLength: 0)
                Text("Edit").font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3)
            }
            .padding(.horizontal, 14).frame(height: 40)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(RanchLook.raise.opacity(0.6)))
            .contentShape(Rectangle())
        }
        .buttonStyle(RanchDipButtonStyle())
    }

    private func field(_ label: String, text: Binding<String>, prompt: String, lines: ClosedRange<Int> = 1...1) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
            TextField(prompt, text: text, axis: .vertical)
                .textFieldStyle(.plain).lineLimit(lines)
                .font(RanchLook.font(14.5)).foregroundStyle(RanchLook.ink)
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(RanchLook.raise))
        }
    }

    private var folderPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Folder").font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
            Menu {
                ForEach(folders) { directory in
                    Button(directory.name) {
                        guard folder != directory.id else { return }
                        folder = directory.id
                        chosen = []
                    }
                }
            } label: {
                HStack {
                    Circle().fill(store.directory(folder ?? "")?.color ?? RanchLook.ink3).frame(width: 7, height: 7)
                    Text(store.directoryName(folder ?? "")).font(RanchLook.font(14.5)).foregroundStyle(RanchLook.ink)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(RanchLook.ink3)
                }
                .padding(.horizontal, 14).frame(height: 40)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(RanchLook.raise))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
        }
    }

    private var filePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Files").font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3)
                Spacer()
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(RanchLook.ink3)
                    TextField("Find a file", text: $search).textFieldStyle(.plain).font(RanchLook.font(13)).frame(width: 150)
                }
            }
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(files.prefix(200)) { source in
                        fileRow(source)
                    }
                    if files.isEmpty {
                        Text(search.isEmpty ? "This folder has no files Lasso has read yet." : "No file is called that.")
                            .font(RanchLook.font(13)).foregroundStyle(RanchLook.ink3)
                            .frame(maxWidth: .infinity, minHeight: 60)
                    }
                }
            }
            .frame(height: 200)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(RanchLook.raise.opacity(0.5)))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func fileRow(_ source: RanchSource) -> some View {
        let on = chosen.contains(source.path)
        return RanchHover { hovering in
            Button {
                withAnimation(RanchInviteSprings.fade) {
                    if on { chosen.removeAll { $0 == source.path } } else { chosen.append(source.path) }
                }
            } label: {
                HStack(spacing: 10) {
                    RanchReviewCheckbox(on: on)
                    Text(source.name).font(RanchLook.font(14)).foregroundStyle(RanchLook.ink).lineLimit(1)
                    let folderPath = (source.path as NSString).deletingLastPathComponent
                    if !folderPath.isEmpty {
                        Text(folderPath).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.ink3).lineLimit(1).truncationMode(.head)
                    }
                    Spacer(minLength: 8)
                    if let modified = source.modifiedAt {
                        Text(RanchReviewWords.ago(modified)).font(RanchLook.font(12)).foregroundStyle(RanchLook.ink3)
                    }
                }
                .padding(.horizontal, 12).frame(height: 36)
                .background(hovering ? RanchLook.raise : .clear)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func create() {
        guard let folder, !chosen.isEmpty, !creating else { return }
        creating = true
        model.createRequest(folder: folder, title: title, note: note, paths: chosen, reviewers: people) { _ in
            creating = false
        }
    }
}
