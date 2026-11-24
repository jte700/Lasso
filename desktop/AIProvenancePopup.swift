// The small glass card shown while the pointer rests on AI-written text:
// the AI's logo, which AI wrote it and through what, the prompt that asked
// for it and who asked, whether people have edited it since (once they have,
// a bar of what is still as written, in the AI's colour, against what was
// edited, in Lasso's blue), and how Lasso knows. It never takes a click, so
// links inside the text stay one click away.

import Cocoa
import SwiftUI

struct AIProvenanceCard: View {
    let info: AIMarkInfo
    /// Linked sources drawn inside the part.
    let linked: Int
    var now = Date()

    static let width: CGFloat = 300

    private var accent: Color { Color(nsColor: info.style.color) }
    private var person: Color { Color(nsColor: AIAgentStyle.person) }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            header
            if let prompt = info.prompt { asked(prompt) }
            kept
            Rectangle().fill(Color.primary.opacity(0.08)).frame(height: 1)
            row(symbol: "checkmark.seal.fill", tint: accent, text: Self.evidence(info))
            if let by = info.recordedElsewhereBy {
                row(symbol: "signature", tint: .secondary, text: "Carried in the document, signed by \(by)\u{2019}s Lasso.")
            }
            if linked > 0 {
                row(symbol: "link", tint: .secondary,
                    text: "\(linked) linked source\(linked == 1 ? "" : "s") inside. Click a link to open it.")
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 12)
        .frame(width: Self.width, alignment: .leading)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            AIAgentBadge(style: info.style)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Self.headline(info))
                        .font(RanchLook.font(13.5, .semibold))
                        .foregroundStyle(accent)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if let at = info.at {
                        Text(Self.when(at, now: now)).font(RanchLook.font(11)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                if let detail = Self.detail(info) {
                    Text(detail).font(RanchLook.font(11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
        }
    }

    private func asked(_ prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(info.askedBy.map { "Asked by \($0 == "You" ? "you" : $0)" } ?? "Asked")
                .font(RanchLook.font(10.5, .semibold))
                .foregroundStyle(.secondary)
            Text("\u{201C}\(prompt)\u{201D}")
                .font(RanchLook.font(12))
                .foregroundStyle(.primary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(accent.opacity(0.13)))
    }

    /// Untouched words need no bar; once people have edited some, the bar shows how much.
    @ViewBuilder private var kept: some View {
        if Self.edited(info) {
            VStack(alignment: .leading, spacing: 5) {
                // Side by side when they fit, one above the other when names make them long.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { keptLegends }
                    VStack(alignment: .leading, spacing: 3) { keptLegends }
                }
                AIKeptBar(share: info.keptShare, accent: accent, person: person)
            }
        } else {
            row(symbol: "text.badge.checkmark", tint: .secondary, text: Self.untouched(info))
        }
    }

    @ViewBuilder private var keptLegends: some View {
        legend(color: accent, text: "\(Self.percent(info.keptShare))% as \(info.agentName) wrote it")
        legend(color: person, text: Self.editedWords(info))
    }

    private func legend(color: Color, text: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(RanchLook.font(11)).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    private func row(symbol: String, tint: Color, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).foregroundStyle(tint)
                .frame(width: 14, alignment: .center)
            Text(text).font(RanchLook.font(11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Words

    static func headline(_ info: AIMarkInfo) -> String {
        info.kind == "paste" ? "Pasted from \(info.agentName)" : "Written by \(info.agentName)"
    }

    static func detail(_ info: AIMarkInfo) -> String? {
        let through: String? = switch info.kind {
        case "edit", "command": info.tool ?? "Claude Code"
        case "writer": "Lasso\u{2019}s writer"
        case "agent": "Review Changes"
        default: info.tool
        }
        let parts = [info.model, through].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    /// How Lasso knows, and on whose Mac when the record came in the document.
    static func evidence(_ info: AIMarkInfo) -> String {
        let said = recorded(info)
        guard let by = info.recordedElsewhereBy, said.hasSuffix(".") else { return said }
        return "\(said.dropLast()) on \(by)\u{2019}s Mac."
    }

    private static func recorded(_ info: AIMarkInfo) -> String {
        switch info.kind {
        case "edit": return "Recorded by \(info.tool ?? "Claude Code")\u{2019}s hook as it edited the file."
        case "command":
            let command = info.command.map { " \u{201C}\(String($0.prefix(60)))\u{201D}" } ?? " a command"
            return "Written while \(info.tool ?? "Claude Code") ran\(command)."
        case "writer": return "Typed in by Lasso\u{2019}s writer\(info.hostApp.map { " in \($0)" } ?? "")."
        case "paste":
            let from = info.tool ?? info.agentName
            return "Copied from \(from) and pasted\(info.hostApp.map { " in \($0)" } ?? "")."
        case "agent": return "Made through Review Changes in Lasso."
        default: return "Recorded when it was written."
        }
    }

    /// Whether people have changed some of what the AI wrote. Words still
    /// found here exactly as written, before a save, are unedited.
    static func edited(_ info: AIMarkInfo) -> Bool { !info.unsaved && info.keptShare < 0.995 }

    /// "15% edited by you and Sam"; with no one recorded, "15% edited since".
    static func editedWords(_ info: AIMarkInfo) -> String {
        let share = "\(100 - percent(info.keptShare))% edited"
        var names: [String] = info.editors.contains(where: \.you) ? ["you"] : []
        for editor in info.editors where !editor.you && !names.contains(editor.name) { names.append(editor.name) }
        guard let last = names.last else { return "\(share) since" }
        let listed = names.count == 1 ? last : "\(names.dropLast().joined(separator: ", ")) and \(last)"
        return "\(share) by \(listed)"
    }

    static func untouched(_ info: AIMarkInfo) -> String {
        info.kind == "paste" ? "Not edited since it was pasted." : "Not edited since \(info.agentName) wrote it."
    }

    static func percent(_ share: Double) -> Int { max(0, min(100, Int((share * 100).rounded()))) }

    static func when(_ date: Date, now: Date) -> String {
        if now.timeIntervalSince(date) < 60 { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }
}

/// The AI's logo, from its app; Gemini's star, drawn, since it has no Mac
/// app to take it from; any other AI without its app, its initial on its colour.
struct AIAgentBadge: View {
    let style: AIAgentStyle

    var body: some View {
        if let logo = AIAgentLogo.image(for: style.key) {
            // An app icon's tile fills about four fifths of its picture.
            Image(nsImage: logo).resizable().interpolation(.high).frame(width: 34, height: 34)
        } else if style.key == "gemini" {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color.white)
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(Color.black.opacity(0.08), lineWidth: 0.5))
                .overlay(GeminiStar().fill(LinearGradient(colors: GeminiStar.colors, startPoint: .bottomLeading,
                                                          endPoint: .topTrailing)).padding(3.5))
                .frame(width: 27, height: 27)
                .shadow(color: .black.opacity(0.14), radius: 0.8, y: 0.5)
                .padding(3.5)
        } else {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color(nsColor: style.color))
                .overlay(Text(String(style.name.prefix(1)).uppercased())
                    .font(RanchLook.font(14, .bold)).foregroundStyle(.white))
                .frame(width: 27, height: 27)
                .padding(3.5)
        }
    }
}

/// Gemini's four-pointed star: each side a quarter circle about a corner of
/// its square, so the points are sharp and the waist is narrow.
struct GeminiStar: Shape {
    static let colors = [AIAgentStyle.rgb(0x4796E3), AIAgentStyle.rgb(0x7A8BDC), AIAgentStyle.rgb(0x9B7CCB)]
        .map { Color(nsColor: $0) }

    func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let square = CGRect(x: rect.midX - side / 2, y: rect.midY - side / 2, width: side, height: side)
        // A cubic's handle for a quarter circle of radius half the side.
        let handle = 0.5523 * side / 2
        let top = CGPoint(x: square.midX, y: square.minY)
        let right = CGPoint(x: square.maxX, y: square.midY)
        let bottom = CGPoint(x: square.midX, y: square.maxY)
        let left = CGPoint(x: square.minX, y: square.midY)
        var path = Path()
        path.move(to: top)
        path.addCurve(to: right, control1: CGPoint(x: top.x, y: top.y + handle), control2: CGPoint(x: right.x - handle, y: right.y))
        path.addCurve(to: bottom, control1: CGPoint(x: right.x - handle, y: right.y), control2: CGPoint(x: bottom.x, y: bottom.y - handle))
        path.addCurve(to: left, control1: CGPoint(x: bottom.x, y: bottom.y - handle), control2: CGPoint(x: left.x + handle, y: left.y))
        path.addCurve(to: top, control1: CGPoint(x: left.x + handle, y: left.y), control2: CGPoint(x: top.x, y: top.y + handle))
        path.closeSubpath()
        return path
    }
}

/// What is still as the AI wrote it, in its colour, against what people changed, in Lasso's blue.
struct AIKeptBar: View {
    let share: Double
    let accent: Color
    let person: Color

    var body: some View {
        GeometryReader { proxy in
            let kept = max(0, min(1, share)) * proxy.size.width
            HStack(spacing: share > 0.005 && share < 0.995 ? 2 : 0) {
                Capsule().fill(accent).frame(width: max(0, kept - (share < 0.995 ? 1 : 0)))
                if share < 0.995 { Capsule().fill(person.opacity(0.9)) }
            }
        }
        .frame(height: 5)
    }
}

/// The card's floating panel: glass on macOS 26, the popover material before it.
final class AIProvenancePopupController {
    static let shared = AIProvenancePopupController()

    private var panel: NSPanel?
    private(set) var shownId: String?

    var isShown: Bool { panel?.isVisible == true }

    /// Shows the card for `info` above `anchor` (screen coordinates, the part's first line), or below its last line.
    func show(id: String, info: AIMarkInfo, linked: Int, above first: CGRect, below last: CGRect) {
        let card = AIProvenanceCard(info: info, linked: linked)
        let hosting = NSHostingView(rootView: card)
        hosting.frame.size = hosting.fittingSize
        let size = CGSize(width: AIProvenanceCard.width, height: max(60, hosting.fittingSize.height))
        hosting.frame = CGRect(origin: .zero, size: size)
        let container = NativeMaterial.glassContainer(content: hosting, cornerRadius: 14)
        container.frame = CGRect(origin: .zero, size: size)

        let screen = NSScreen.screens.first { $0.frame.intersects(first) }?.visibleFrame
            ?? NSScreen.main?.visibleFrame ?? .zero
        var origin = CGPoint(x: first.minX - 6, y: first.maxY + 8)
        if origin.y + size.height > screen.maxY { origin.y = last.minY - 8 - size.height }
        origin.x = min(max(screen.minX + 6, origin.x), screen.maxX - size.width - 6)
        origin.y = max(screen.minY + 6, origin.y)

        let panel = self.panel ?? Self.makePanel()
        self.panel = panel
        panel.contentView = container
        let target = CGRect(origin: origin, size: size)
        let fresh = !panel.isVisible || shownId != id
        shownId = id
        if fresh {
            panel.setFrame(target.offsetBy(dx: 0, dy: -4), display: false)
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.14
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = 1
                panel.animator().setFrame(target, display: true)
            }
        } else {
            panel.setFrame(target, display: true)
        }
    }

    func hide() {
        guard let panel, panel.isVisible else { shownId = nil; return }
        shownId = nil
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.1
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard self?.shownId == nil else { return }
            panel.orderOut(nil)
        })
    }

    private static func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        return panel
    }
}
