// A conversation pinned to a line, cell or passage of a file under review,
// drawn as the reference clip draws one: "Line 9", each comment with its
// author's orb, a suggested change as removed and added lines, and Apply
// suggestion, Reply and Resolve. Applying turns the button into "Applied",
// the changed line flashes, and the conversation folds into one line,
// "Suggestion applied · Line 9 · Marcus Johnson", which opens again on a
// click. A comment that starts with a backslash is handed to the AI writer,
// which makes the change; its reply says it made it and who asked.

import SwiftUI

/// One place a comment can be pinned to, as the composer needs it.
struct LoopReviewPlace: Equatable {
    let key: String
    let anchor: [String: Any]
    /// "Line 10", "Accounting!B18", "Page 2"; nil for the file as a whole.
    let label: String?
    /// What the place reads now, to start a suggested change from.
    let current: String?

    static func == (left: LoopReviewPlace, right: LoopReviewPlace) -> Bool { left.key == right.key }

    init(path: String, anchor: [String: Any], label: String?, current: String?) {
        self.key = LoopReviewModel.key(path, anchor)
        self.anchor = anchor
        self.label = label
        self.current = current
    }
}

struct LoopReviewAvatar: View {
    let actor: LoopReviewActor?
    var size: CGFloat = 26

    var body: some View {
        if actor?.isAI == true {
            Image(systemName: "sparkles").font(.system(size: size * 0.42, weight: .medium)).foregroundStyle(LoopLook.ink)
                .frame(width: size, height: size)
                .background(Circle().fill(LinearGradient(colors: [LoopLook.rgb(0x6B8CF0), LoopLook.rgb(0x9A6BE8)],
                                                         startPoint: .topLeading, endPoint: .bottomTrailing)))
        } else {
            let (light, deep) = LoopChangeActor.orb(for: actor?.shownName ?? "Someone")
            Circle()
                .fill(LinearGradient(colors: [light, deep], startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay(Circle().fill(RadialGradient(colors: [Color.white.opacity(0.45), .clear],
                                                      center: .init(x: 0.32, y: 0.28), startRadius: 0, endRadius: size * 0.4)))
                .frame(width: size, height: size)
        }
    }
}

/// Small text buttons beside a primary one: Reply, Resolve, Cancel.
struct LoopReviewQuietButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        LoopHover { hovering in
            Button(action: action) {
                Text(title).font(LoopLook.font(13.5)).foregroundStyle(hovering ? LoopLook.ink : LoopLook.ink2)
                    .padding(.horizontal, 12).frame(height: 32)
                    .background(Capsule().fill(hovering ? LoopLook.raise : .clear))
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }
}

/// The filled sky button: Apply suggestion, Comment, Approve.
struct LoopReviewFilledButton: View {
    let title: String
    var systemImage: String? = nil
    var enabled = true
    var done = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage { Image(systemName: systemImage).font(.system(size: 11.5, weight: .semibold)) }
                Text(title).font(LoopLook.font(13.5, .medium))
            }
            .foregroundStyle(done ? LoopLook.sky : LoopLook.onSky)
            .padding(.horizontal, 14).frame(height: 32)
            .background(Capsule().fill(done ? LoopLook.sky.opacity(0.16) : LoopLook.sky.opacity(enabled ? 1 : 0.35)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled || done)
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: done)
    }
}

/// Removed and added lines, as a suggestion or an AI's edit reads.
struct LoopReviewSuggestionBox: View {
    let title: String
    let suggestion: LoopReviewThread.Suggestion
    let code: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink2)
                .padding(.horizontal, 14).frame(height: 32, alignment: .leading)
            if let before = suggestion.before, !before.isEmpty {
                row("\u{2212}", before, tint: LoopLook.terracotta.opacity(0.16), sign: LoopLook.terracottaSoft)
            }
            row("+", suggestion.after, tint: LoopLook.lime.opacity(0.1), sign: LoopLook.lime)
        }
        .frame(maxWidth: 620, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(LoopLook.page.opacity(0.5)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(LoopLook.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func row(_ mark: String, _ text: String, tint: Color, sign: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(mark).foregroundStyle(sign).frame(width: 10)
            Text(text).foregroundStyle(LoopLook.ink).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
        }
        .font(code ? .system(size: 12.5, design: .monospaced) : LoopLook.font(13.5))
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(tint)
    }
}

/// A line of a review shimmering while the AI writer works: "ChatGPT is making the change…".
struct LoopReviewWorking: View {
    let words: String

    var body: some View {
        HStack(spacing: 12) {
            LoopReviewAvatar(actor: LoopReviewActor(id: "agent:chatgpt", name: "ChatGPT", type: "AI_AGENT"))
            TimelineView(.animation) { context in
                let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                Text(words).font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink2)
                    .opacity(0.5 + 0.5 * (0.5 + 0.5 * cos(phase * 2 * .pi)))
            }
        }
        .padding(.horizontal, 32).padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
    }
}

/// Where a comment is written: the place, the field, Suggest a change, Cancel and Comment.
/// Starting with a backslash hands the words to the AI writer instead.
struct LoopReviewComposer: View {
    let place: LoopReviewPlace?
    var code = false
    var canSuggest = true
    var replying = false
    /// The words, and the suggested change when there is one.
    let send: (String, String?) -> Void
    let cancel: () -> Void

    @State private var text = ""
    @State private var suggesting = false
    @State private var suggestion = ""
    @FocusState private var focused: Bool

    private var prompt: Bool { LoopReviewWords.isPrompt(text) }
    private var ready: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).filter { $0 != "\\" }.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let label = place?.label, !replying {
                Text(label).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink2)
            }
            HStack(alignment: .top, spacing: 12) {
                LoopReviewAvatar(actor: LoopReviewActor(id: LoopReviewActor.meID, name: nil, type: "HUMAN_SELF"))
                VStack(alignment: .leading, spacing: 10) {
                    field
                    if suggesting && !prompt { suggestionField.transition(.opacity.combined(with: .move(edge: .top))) }
                    HStack(spacing: 8) {
                        if canSuggest && !prompt { suggestToggle }
                        if prompt {
                            Text("ChatGPT makes this change and says so here").font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
                        }
                        Spacer(minLength: 8)
                        LoopReviewQuietButton(title: "Cancel", action: cancel)
                        LoopReviewFilledButton(title: prompt ? "Ask ChatGPT" : replying ? "Reply" : "Comment",
                                                systemImage: prompt ? "sparkles" : nil, enabled: ready, action: submit)
                    }
                }
                .frame(maxWidth: 680)
            }
        }
        .padding(.horizontal, 32).padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: suggesting)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: prompt)
        .onAppear { DispatchQueue.main.async { focused = true } }
    }

    private var field: some View {
        HStack(alignment: .top, spacing: 8) {
            if prompt {
                Image(systemName: "sparkles").font(.system(size: 12, weight: .medium)).foregroundStyle(LoopLook.sky)
                    .padding(.top, 2).transition(.scale.combined(with: .opacity))
            }
            TextField(prompt ? "" : "Leave a comment, or start with \\ to ask ChatGPT", text: $text, axis: .vertical)
                .textFieldStyle(.plain).font(LoopLook.font(14)).foregroundStyle(LoopLook.ink)
                .lineLimit(2...8)
                .focused($focused)
                .onSubmit(submit)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(minHeight: 64, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(LoopLook.page.opacity(0.55)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(focused ? LoopLook.sky.opacity(0.7) : LoopLook.line, lineWidth: focused ? 1.5 : 1))
        .animation(.easeOut(duration: 0.15), value: focused)
    }

    private var suggestionField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Should read").font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
            TextField("", text: $suggestion, axis: .vertical)
                .textFieldStyle(.plain)
                .font(code ? .system(size: 12.5, design: .monospaced) : LoopLook.font(13.5)).foregroundStyle(LoopLook.ink)
                .lineLimit(1...8)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(LoopLook.lime.opacity(0.08)))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(LoopLook.line, lineWidth: 1))
        }
    }

    private var suggestToggle: some View {
        Button {
            if !suggesting && suggestion.isEmpty { suggestion = place?.current ?? "" }
            suggesting.toggle()
        } label: {
            HStack(spacing: 8) {
                LoopReviewCheckbox(on: suggesting)
                Text("Suggest a change").font(LoopLook.font(13)).foregroundStyle(LoopLook.ink2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func submit() {
        guard ready else { return }
        send(text.trimmingCharacters(in: .whitespacesAndNewlines), suggesting && !prompt ? suggestion : nil)
    }
}

struct LoopReviewCheckbox: View {
    let on: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(on ? LoopLook.sky : LoopLook.track)
            .frame(width: 15, height: 15)
            .overlay {
                if on {
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(LoopLook.onSky)
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: on)
    }
}

/// One comment: who, when, and what they wrote, asked or changed.
private struct LoopReviewCommentRow: View {
    let comment: LoopReviewComment
    let code: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            LoopReviewAvatar(actor: comment.author)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(comment.author.shownName).font(LoopLook.font(14, .medium)).foregroundStyle(LoopLook.ink)
                    if let asker = comment.initiatedBy {
                        Text("asked by \(asker.shownName)").font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
                    }
                    Text(LoopReviewWords.ago(comment.at)).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
                }
                if comment.prompt != nil {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "sparkles").font(.system(size: 11, weight: .medium)).foregroundStyle(LoopLook.sky)
                        Text("Asked ChatGPT:").font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink3)
                        Text(comment.body).font(LoopLook.font(14)).foregroundStyle(LoopLook.ink).textSelection(.enabled)
                    }
                } else {
                    Text(comment.body).font(LoopLook.font(14)).foregroundStyle(LoopLook.ink).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let suggestion = comment.suggestion {
                    LoopReviewSuggestionBox(title: comment.executionId != nil ? "\(comment.author.shownName)\u{2019}s edit"
                                                : comment.author.isAI ? "\(comment.author.shownName)\u{2019}s suggestion" : "Suggested change",
                                             suggestion: suggestion, code: code)
                        .padding(.top, 4)
                }
            }
        }
    }
}

struct LoopReviewThreadView: View {
    @ObservedObject var model: LoopReviewModel
    let store: LoopStore
    let file: LoopReviewFileView
    let thread: LoopReviewThread

    @State private var expanded = false
    @State private var replying = false
    @State private var applying = false
    /// Shows "Applied" for a moment before the conversation folds.
    @State private var holdingApplied = false

    private var folded: Bool { thread.isClosed && !expanded && !holdingApplied }
    /// The place a reply's backslash prompt asks about: this thread's.
    private var askAnchor: [String: Any] {
        var anchor: [String: Any] = ["kind": thread.anchor.kind, "thread": thread.id]
        if let line = thread.position?.line { anchor["line"] = line }
        return anchor
    }
    private var askingKey: String { LoopReviewModel.key(thread.path, askAnchor) }

    var body: some View {
        VStack(spacing: 0) {
            if folded {
                summary.transition(.opacity)
            } else {
                full.transition(.opacity)
            }
        }
        .background(LoopLook.panel)
        .overlay(alignment: .top) { LoopLook.line2.frame(height: 1) }
        .overlay(alignment: .bottom) { LoopLook.line2.frame(height: 1) }
        .clipped()
        .animation(.spring(response: 0.5, dampingFraction: 0.9), value: folded)
    }

    private var summary: some View {
        let words = LoopReviewWords.summary(thread)
        return Button { expanded = true } label: {
            HStack(spacing: 10) {
                Image(systemName: thread.editedByAI ? "sparkles" : "checkmark.circle")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(LoopLook.sky)
                (Text(words.lead).foregroundColor(LoopLook.ink2) + Text(words.rest.isEmpty ? "" : " \u{00B7} \(words.rest)").foregroundColor(LoopLook.ink3))
                    .font(LoopLook.font(14)).lineLimit(1)
                Spacer(minLength: 8)
                HStack(spacing: -7) {
                    ForEach(thread.people.prefix(3), id: \.id) { person in
                        LoopReviewAvatar(actor: person, size: 22).overlay(Circle().strokeBorder(LoopLook.panel, lineWidth: 2))
                    }
                }
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(LoopLook.ink3)
            }
            .padding(.horizontal, 32).frame(height: 54)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var full: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                if let place = thread.place { Text(place).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink2) }
                if thread.state == "outdated" { chip("Outdated") }
                if thread.pending { chip("Pending") }
                Spacer(minLength: 8)
                if thread.isClosed && expanded {
                    Button { expanded = false } label: {
                        Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(LoopLook.ink3)
                    }
                    .buttonStyle(.plain)
                }
            }
            ForEach(thread.comments) { comment in LoopReviewCommentRow(comment: comment, code: file.code) }
            actions.padding(.leading, 38)
            if model.asking.contains(askingKey) { LoopReviewWorking(words: "ChatGPT is making the change\u{2026}") }
            if replying {
                LoopReviewComposer(place: nil, code: file.code, canSuggest: false, replying: true, send: reply,
                                    cancel: { withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { replying = false } })
                    .padding(.horizontal, -32)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 32).padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func chip(_ text: String) -> some View {
        Text(text).font(LoopLook.font(12)).foregroundStyle(LoopLook.ink2)
            .padding(.horizontal, 8).frame(height: 22)
            .background(Capsule().fill(LoopLook.raise))
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 6) {
            if let suggestion = thread.suggestion, thread.state == "open" || holdingApplied {
                if file.writable && thread.anchor.kind != "file" {
                    LoopReviewFilledButton(title: holdingApplied ? "Applied" : "Apply suggestion",
                                            systemImage: holdingApplied ? "checkmark" : nil, enabled: !applying,
                                            done: holdingApplied, action: apply)
                } else if let open = opener {
                    LoopReviewFilledButton(title: "Open in \(open.name)", systemImage: "arrow.up.forward.app", action: open.action)
                        .help("Make the change there: \u{201C}\(suggestion.after.prefix(80))\u{201D}. It shows as applied once the file is saved.")
                }
            }
            if !thread.isClosed || holdingApplied {
                LoopReviewQuietButton(title: "Reply") { withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { replying = true } }
                LoopReviewQuietButton(title: "Resolve") { model.resolve(thread, true) }
            } else if thread.state == "resolved" {
                LoopReviewQuietButton(title: "Reopen") { expanded = false; model.resolve(thread, false) }
            }
        }
    }

    private var opener: (name: String, action: () -> Void)? {
        guard let source = store.source(file.fileId), let url = store.localURL(for: source),
              let editor = LoopEditors.primary(for: url) else { return nil }
        return (editor.name, { _ = editor.open(url) })
    }

    private func apply() {
        applying = true
        model.apply(thread) { succeeded in
            applying = false
            guard succeeded else { return }
            holdingApplied = true
            model.flash(thread)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { holdingApplied = false }
        }
    }

    private func reply(_ text: String, _ suggestion: String?) {
        withAnimation(.spring(response: 0.4, dampingFraction: 0.88)) { replying = false }
        if LoopReviewWords.isPrompt(text) {
            model.ask(path: thread.path, anchor: askAnchor, prompt: text, thread: thread) { _ in }
            return
        }
        model.reply(thread, body: text, suggestion: nil) { _ in }
    }
}
