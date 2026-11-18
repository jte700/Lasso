// Sharing a source from its Share button in The Ranch: a dialog in the style
// of an invite card the person chose. First the three ways Lasso shares a
// whole file: whole, redacted, or marked up. Next shows the send step: Lasso's
// mascots on two phones (RanchShareScene.swift), what the recipient will get,
// and their addresses. Send makes the link, copies it, and opens a Mail message
// to them with it; with no address, the button only copies the link. Redacting
// and marking up are done first in Lasso's share editor, opened on that way.

import Cocoa
import SwiftUI

extension RanchShareWay {
    var icon: RanchLucide {
        switch self {
        case .whole: return .fileText
        case .redacted: return .eyeOff
        case .marked: return .highlighter
        }
    }
}

struct RanchShareFlow: View {
    @ObservedObject var store: RanchStore
    let source: RanchSource

    private enum Step { case choose, send }
    private enum Phase: Equatable { case idle, working, done(String), failed(String) }

    @State private var step = Step.choose
    @State private var way = RanchShareWay.whole
    /// What the share editor returned, for a redacted or marked-up share.
    @State private var configuration: ShareConfiguration?
    @State private var recipients: [String] = []
    @State private var draft = ""
    @State private var phase = Phase.idle
    @State private var target: RanchShareTarget?
    @State private var shown = false
    @FocusState private var addressFocused: Bool

    private static let width: CGFloat = 440

    init(store: RanchStore, source: RanchSource) {
        self.store = store
        self.source = source
        // It opens on the first way this file can be shared.
        _way = State(initialValue: RanchShareWay.allCases.first { $0.unavailable(for: source.name) == nil } ?? .whole)
    }

    var body: some View {
        ZStack {
            Color.black.opacity(shown ? 0.45 : 0)
                .contentShape(Rectangle())
                .onTapGesture(perform: close)
                .accessibilityHidden(true)
            card
                .frame(width: Self.width)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                .shadow(color: .black.opacity(0.5), radius: 40, y: 20)
                .scaleEffect(shown ? 1 : 0.94)
                .opacity(shown ? 1 : 0)
        }
        .environment(\.colorScheme, .dark)
        .onAppear {
            withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) { shown = true }
            store.shareTarget(for: source) { result in
                if case .success(let found) = result { target = found }
            }
        }
        .onExitCommand(perform: close)
    }

    private var card: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                if step == .send {
                    RanchShareScene()
                        .transition(.opacity.combined(with: .scale(scale: 0.96)))
                } else {
                    chooseHeader.transition(.opacity)
                }
                topControls
            }
            Group {
                if step == .choose { chooseBody } else { sendBody }
            }
            .padding(.horizontal, 26)
            .padding(.bottom, 24)
        }
        .background(LinearGradient(colors: [RanchShareLook.top, RanchShareLook.middle, RanchShareLook.bottom, RanchShareLook.bottom],
                                   startPoint: .top, endPoint: .bottom))
        .animation(.spring(response: 0.5, dampingFraction: 0.86), value: step)
    }

    /// Close at the right, and Back on the send step.
    private var topControls: some View {
        HStack {
            if step == .send {
                Button { withAnimation(.spring(response: 0.5, dampingFraction: 0.86)) { step = .choose; phase = .idle } } label: {
                    RanchLucideIcon(icon: .chevronRight, size: 14, color: RanchShareLook.ink2).rotationEffect(.degrees(180))
                }
                .buttonStyle(RanchShareRoundStyle())
                .help("Back to the ways of sharing")
                .accessibilityLabel("Back")
            }
            Spacer()
            Button(action: close) { RanchLucideIcon(icon: .x, size: 13, color: RanchShareLook.ink2) }
                .buttonStyle(RanchShareRoundStyle())
                .keyboardShortcut(.cancelAction)
                .help("Close")
                .accessibilityLabel("Close")
        }
        .padding(14)
    }

    // MARK: Choosing a way

    private var chooseHeader: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle().fill(Color.white.opacity(0.1)).frame(width: 64, height: 64)
                RanchFileIcon(url: nil, fileExtension: source.fileExtension, size: 34)
            }
            .padding(.top, 34)
            Text("Share \(source.name)")
                .font(RanchLook.font(21, .semibold)).ranchTracking(-0.02, size: 21)
                .foregroundStyle(RanchShareLook.ink)
                .lineLimit(1).truncationMode(.middle)
                .padding(.horizontal, 30)
            Text("Choose how it is shared. Links work for 48 hours, and you can stop one any time.")
                .font(RanchLook.font(13.5)).foregroundStyle(RanchShareLook.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 36)
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 18)
    }

    private var chooseBody: some View {
        VStack(spacing: 10) {
            RanchShareWays(filename: source.name, way: Binding(get: { way }, set: { next in
                if way != next { configuration = nil }
                way = next
            }))
            Button(action: next) {
                Text("Next").frame(maxWidth: .infinity)
            }
            .buttonStyle(RanchShareButtonStyle())
            .keyboardShortcut(.defaultAction)
            .disabled(way.unavailable(for: source.name) != nil)
            .opacity(way.unavailable(for: source.name) == nil ? 1 : 0.5)
            .padding(.top, 8)
        }
    }

    private func next() {
        guard way.unavailable(for: source.name) == nil else { return }
        if way == .whole { configuration = .entireDocument }
        withAnimation(.spring(response: 0.5, dampingFraction: 0.86)) { step = .send }
    }

    // MARK: Sending

    private var sendBody: some View {
        VStack(spacing: 12) {
            Text("Share \(source.name)")
                .font(RanchLook.font(21, .semibold)).ranchTracking(-0.02, size: 21)
                .foregroundStyle(RanchShareLook.ink)
                .lineLimit(1).truncationMode(.middle)
            Text(way.promise)
                .font(RanchLook.font(13.5)).foregroundStyle(RanchShareLook.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 8)
            chip
            addresses.padding(.top, 8)
            Button(action: send) {
                HStack(spacing: 8) {
                    if phase == .working { ProgressView().controlSize(.small) }
                    Text(buttonTitle)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(RanchShareButtonStyle())
            .keyboardShortcut(.defaultAction)
            .disabled(!ready || phase == .working)
            .opacity(ready || phase != .idle ? 1 : 0.5)
            if case .failed(let message) = phase {
                Text(message).font(RanchLook.font(12.5)).foregroundStyle(RanchLook.rgb(0xFFB4A8))
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// For a whole file, how long the link lasts; for the others, the way into the editor, and what was chosen there.
    @ViewBuilder private var chip: some View {
        switch way {
        case .whole:
            RanchShareChip(icon: .clock, text: "Link works for 48 hours")
        case .redacted, .marked:
            Button(action: edit) {
                RanchShareChip(icon: way == .redacted ? .eyeOff : .highlighter, text: editLabel, lit: configuration == nil)
            }
            .buttonStyle(.plain)
            .disabled(target == nil)
            .help(way == .redacted ? "Opens the file to cover what they shouldn\u{2019}t see" : "Opens the file to draw on its pages")
        }
    }

    private var editLabel: String {
        guard let configuration else { return way == .redacted ? "Choose what to cover\u{2026}" : "Draw on its pages\u{2026}" }
        if way == .redacted {
            let count = configuration.redactions.count
            return "\(count == 1 ? "1 part" : "\(count) parts") covered \u{00B7} Change"
        }
        return "Marked up \u{00B7} Change"
    }

    /// Addresses as tokens, and a field for one more.
    private var addresses: some View {
        HStack(spacing: 6) {
            RanchLucideIcon(icon: .mail, size: 15, color: RanchShareLook.ink3).padding(.leading, 4)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(recipients, id: \.self) { address in
                        HStack(spacing: 5) {
                            Text(address).font(RanchLook.font(12.5, .medium)).foregroundStyle(RanchShareLook.ink).lineLimit(1)
                            Button { recipients.removeAll { $0 == address } } label: {
                                RanchLucideIcon(icon: .x, size: 10, color: RanchShareLook.ink2)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(address)")
                        }
                        .padding(.leading, 10).padding(.trailing, 7)
                        .frame(height: 26)
                        .background(Capsule().fill(Color.white.opacity(0.14)))
                    }
                    TextField("", text: $draft, prompt: Text(recipients.isEmpty ? "Add an email" : "Add another email")
                        .foregroundColor(RanchShareLook.ink3))
                        .textFieldStyle(.plain)
                        .font(RanchLook.font(13.5))
                        .foregroundStyle(RanchShareLook.ink)
                        .frame(minWidth: 150)
                        .focused($addressFocused)
                        .onSubmit { _ = takeAddresses(final: true) }
                        .onChange(of: draft) { _ in _ = takeAddresses(final: false) }
                }
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 42)
        .background(Capsule().fill(RanchShareLook.field))
        .overlay(Capsule().strokeBorder(Color.white.opacity(addressFocused ? 0.35 : 0.08), lineWidth: 1))
        .contentShape(Capsule())
        .onTapGesture { addressFocused = true }
    }

    /// Turns what was typed into tokens: at a comma or space, or, when final, whatever is left.
    private func takeAddresses(final: Bool) -> Bool {
        let separators = CharacterSet(charactersIn: ", ;\n")
        guard final || draft.rangeOfCharacter(from: separators) != nil else { return false }
        var leftover = ""
        for part in draft.components(separatedBy: separators) where !part.isEmpty {
            if RanchShareAddress.valid(part) {
                if !recipients.contains(part.lowercased()) { recipients.append(part.lowercased()) }
            } else {
                leftover = part
            }
        }
        draft = leftover
        return true
    }

    private var ready: Bool {
        if case .done = phase { return false }
        return configuration != nil && target != nil
    }

    private var buttonTitle: String {
        switch phase {
        case .working: return "Making the link\u{2026}"
        case .done(let message): return message
        default:
            let pending = RanchShareAddress.valid(draft)
            return recipients.isEmpty && !pending ? "Copy link" : "Send"
        }
    }

    // MARK: Actions

    /// Opens Lasso's share editor on this way, to cover or draw; what it returns is used to send.
    private func edit() {
        guard let target, let serverURL = store.serverURL else { return }
        let frame = NSApp.keyWindow?.frame ?? NSScreen.main?.visibleFrame ?? .zero
        ShareComposerController.shared.show(
            objectId: target.objectId, versionId: target.versionId, label: target.label, sourcePath: target.path,
            near: NSRect(x: frame.midX, y: frame.midY, width: 1, height: 1), serverURL: serverURL,
            actionTitle: "Use This", projectId: target.projectId, scope: way.scope,
            completion: { chosen in configuration = chosen })
    }

    private func send() {
        _ = takeAddresses(final: true)
        guard let configuration, let target, let serverURL = store.serverURL else { return }
        phase = .working
        let addresses = recipients
        ShareClient.createShare(serverURL: serverURL, projectId: target.projectId, objectId: target.objectId,
                                versionId: target.versionId, configuration: configuration) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let share):
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(share.url.absoluteString, forType: .string)
                    if !addresses.isEmpty { RanchShareAddress.compose(to: addresses, file: source.name, link: share.url) }
                    store.reload()
                    phase = .done(addresses.isEmpty ? "Link copied" : "Opened in Mail \u{00B7} link copied")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { close() }
                case .failure(let error):
                    phase = .failed(error.localizedDescription)
                }
            }
        }
    }

    private func close() {
        withAnimation(.easeOut(duration: 0.2)) { shown = false }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            if store.sharing?.id == source.id { store.sharing = nil }
        }
    }
}

extension RanchShareAddress {
    /// Opens a new Mail message to them with the link in it; the person sends it themselves.
    static func compose(to recipients: [String], file: String, link: URL) {
        let body = "\(file), shared from Lasso:\n\(link.absoluteString)\n\nThe link works for 48 hours."
        if let service = NSSharingService(named: .composeEmail) {
            service.recipients = recipients
            service.subject = file
            if service.canPerform(withItems: [body]) {
                service.perform(withItems: [body])
                return
            }
        }
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = recipients.joined(separator: ",")
        components.queryItems = [URLQueryItem(name: "subject", value: file), URLQueryItem(name: "body", value: body)]
        if let url = components.url { NSWorkspace.shared.open(url) }
    }
}

/// The three ways, as the Spring Dropdown's rows without the dropdown: one
/// panel of rows that fall in one after another, a highlight that stretches
/// from row to row after the pointer and rests on the chosen one, and a check
/// that draws itself as a row is chosen. ↑ and ↓ choose too.
private struct RanchShareWays: View {
    let filename: String
    @Binding var way: RanchShareWay
    @StateObject private var clock = RanchSpringRowsClock(count: RanchShareWay.allCases.count, row: Self.row, pad: Self.pad)

    private static let row: Double = 58
    private static let pad: Double = 6
    private static let ways = RanchShareWay.allCases

    var body: some View {
        let rows = clock.rows
        let light = rows.highlight
        VStack(spacing: 0) {
            ForEach(Array(Self.ways.enumerated()), id: \.element) { index, option in
                row(option, index: index, rows: rows)
            }
        }
        .padding(CGFloat(Self.pad))
        .background(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.11))
                .frame(height: CGFloat(light.height))
                .padding(.horizontal, CGFloat(Self.pad))
                .offset(y: CGFloat(light.top))
                .opacity(min(1, max(0, rows.glow.x)))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.white.opacity(0.07)))
        // Away from the rows, the highlight goes back to the chosen one.
        .onHover { inside in if !inside { clock.update { $0.hover(chosen) } } }
        .onAppear {
            clock.update { rows in
                rows.settle(on: chosen)
                rows.hover(chosen)
            }
            for index in Self.ways.indices {
                DispatchQueue.main.asyncAfter(deadline: .now() + RanchSpringRows.delay(index)) {
                    clock.update { $0.show(index) }
                }
            }
        }
        .background { keys }
    }

    private var chosen: Int { Self.ways.firstIndex(of: way) ?? 0 }

    private func row(_ option: RanchShareWay, index: Int, rows: RanchSpringRows) -> some View {
        let unavailable = option.unavailable(for: filename)
        let shown = rows.shown[index].x
        return Button { choose(index) } label: {
            HStack(spacing: 12) {
                Circle().fill(option.dot).frame(width: 10, height: 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.title).font(RanchLook.font(15, .medium)).ranchTracking(-0.01, size: 15)
                        .foregroundStyle(RanchShareLook.ink)
                    Text(unavailable ?? option.detail).font(RanchLook.font(12.5)).foregroundStyle(RanchShareLook.ink2)
                        .lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 8)
                RanchCheckShape()
                    .trim(from: 0, to: CGFloat(min(1, max(0, rows.ticks[index].x))))
                    .stroke(RanchShareLook.ink, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                    .frame(width: 18, height: 18)
                    // A round cap would leave a dot where a check has all but gone.
                    .opacity(rows.ticks[index].x > 0.02 ? 1 : 0)
            }
            .padding(.leading, 14)
            .padding(.trailing, 12)
            .frame(height: CGFloat(Self.row))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(unavailable != nil)
        .opacity(min(1, max(0, shown)) * (unavailable == nil ? 1 : 0.4))
        .offset(y: CGFloat(shown - 1) * 14)
        .scaleEffect(CGFloat(rows.presses[index].x))
        .onHover { inside in
            if inside && unavailable == nil { clock.update { $0.hover(index) } }
        }
        .accessibilityLabel("\(option.title). \(unavailable ?? option.detail)")
        .accessibilityAddTraits(way == option ? .isSelected : [])
    }

    private func choose(_ index: Int) {
        guard Self.ways[index].unavailable(for: filename) == nil else { return }
        way = Self.ways[index]
        clock.update { rows in
            rows.choose(index)
            rows.hover(index)
        }
    }

    /// ↑ and ↓ choose the way above or below, passing over ones this file cannot use.
    private var keys: some View {
        ZStack {
            Button("") { step(-1) }.keyboardShortcut(.upArrow, modifiers: [])
            Button("") { step(1) }.keyboardShortcut(.downArrow, modifiers: [])
        }
        .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }

    private func step(_ direction: Int) {
        var index = chosen + direction
        while Self.ways.indices.contains(index) {
            if Self.ways[index].unavailable(for: filename) == nil { return choose(index) }
            index += direction
        }
    }
}

extension RanchShareWay {
    /// The dot each way wears, as the component's statuses wear theirs.
    var dot: Color {
        switch self {
        case .whole: return RanchLook.rgb(0x34D17A)
        case .redacted: return RanchLook.rgb(0xFF9F0A)
        case .marked: return RanchLook.rgb(0x8F9BFF)
        }
    }
}

/// The component's check: a short stroke down and a long one up.
private struct RanchCheckShape: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 24
        var path = Path()
        path.move(to: CGPoint(x: 5 * scale, y: 12.5 * scale))
        path.addLine(to: CGPoint(x: 9.5 * scale, y: 17 * scale))
        path.addLine(to: CGPoint(x: 19 * scale, y: 7.5 * scale))
        return path.offsetBy(dx: rect.minX, dy: rect.minY)
    }
}

/// Steps `RanchSpringRows` each frame while anything is still moving.
private final class RanchSpringRowsClock: ObservableObject {
    @Published private(set) var rows: RanchSpringRows
    private var timer: Timer?
    private var last = CACurrentMediaTime()

    init(count: Int, row: Double, pad: Double) {
        rows = RanchSpringRows(count: count, row: row, pad: pad,
                               reduce: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
    }

    deinit { timer?.invalidate() }

    func update(_ change: (inout RanchSpringRows) -> Void) {
        change(&rows)
        guard timer == nil else { return }
        last = CACurrentMediaTime()
        let clock = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(clock, forMode: .common)
        timer = clock
    }

    private func tick() {
        let now = CACurrentMediaTime()
        let dt = min(now - last, 1.0 / 30)
        last = now
        // Four small steps a frame, as the motion studies take them.
        for _ in 0..<4 { rows.step(dt / 4) }
        if rows.settled {
            timer?.invalidate()
            timer = nil
        }
    }
}

/// A small note in a pill under the description, as the invite card's gift line.
private struct RanchShareChip: View {
    let icon: RanchLucide
    let text: String
    var lit = false

    var body: some View {
        HStack(spacing: 7) {
            RanchLucideIcon(icon: icon, size: 13, color: lit ? RanchShareLook.onButton : RanchShareLook.ink2)
            Text(text).font(RanchLook.font(12.5, .medium)).foregroundStyle(lit ? RanchShareLook.onButton : RanchShareLook.ink2)
        }
        .padding(.horizontal, 12)
        .frame(height: 28)
        .background(Capsule().fill(lit ? RanchShareLook.button : RanchShareLook.chip))
    }
}

/// The dialog's main button: a light pill across the card.
private struct RanchShareButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RanchHover { hovering in
            configuration.label
                .font(RanchLook.font(14.5, .semibold))
                .foregroundStyle(RanchShareLook.onButton)
                .frame(height: 42)
                .background(Capsule().fill(RanchShareLook.button.opacity(hovering ? 0.9 : 1)))
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
                .contentShape(Capsule())
        }
    }
}

private struct RanchShareRoundStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RanchHover { hovering in
            configuration.label
                .frame(width: 28, height: 28)
                .background(Circle().fill(Color.white.opacity(hovering ? 0.18 : 0.1)))
                .contentShape(Circle())
        }
    }
}
