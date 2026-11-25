// The controls a page of The Loop is built from: the breadcrumb and bell at
// its top, capsule choices, the search field, pills and status dots, and the
// way rows and cards rise into place.

import Cocoa
import SwiftUI

/// Where the page is, in a capsule: "The Loop / Sources". Earlier steps go back.
struct LoopBreadcrumb: View {
    struct Step: Identifiable {
        let title: String
        var action: (() -> Void)? = nil
        var id: String { title }
    }

    let steps: [Step]

    var body: some View {
        HStack(spacing: 9) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                if index > 0 { Text("/").foregroundStyle(LoopLook.ink3.opacity(0.7)) }
                if let action = step.action {
                    Button(step.title, action: action).buttonStyle(LoopCrumbStyle())
                } else {
                    Text(step.title).foregroundStyle(LoopLook.ink).lineLimit(1).truncationMode(.middle)
                }
            }
        }
        .font(LoopLook.font(13.5, .medium))
        .padding(.horizontal, 15)
        .frame(height: 36)
        .background(Capsule().fill(LoopLook.panel))
        .overlay(Capsule().strokeBorder(LoopLook.line2, lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
}

private struct LoopCrumbStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        LoopHover { hovering in
            configuration.label.foregroundStyle(hovering ? LoopLook.ink : LoopLook.ink3)
        }
    }
}

/// Tells its content whether the pointer is on it.
struct LoopHover<Content: View>: View {
    @ViewBuilder var content: (Bool) -> Content
    @State private var hovering = false

    var body: some View {
        content(hovering).onHover { hovering = $0 }
    }
}

/// The bell at the top right, with how many notifications are waiting.
struct LoopBell: View {
    let count: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            LoopHover { hovering in
                Image(systemName: "bell.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(hovering ? LoopLook.ink : LoopLook.ink2)
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(hovering ? LoopLook.raise : LoopLook.panel))
                    .overlay(Circle().strokeBorder(LoopLook.line2, lineWidth: 1))
                    .contentShape(Circle())
            }
        }
        .buttonStyle(.plain)
        .overlay(alignment: .topTrailing) {
            if count > 0 {
                Text(count > 99 ? "99+" : "\(count)")
                    .font(LoopLook.font(10.5, .bold)).monospacedDigit()
                    .foregroundStyle(LoopLook.onInk)
                    .padding(.horizontal, 5)
                    .frame(minWidth: 18, minHeight: 18)
                    .background(Capsule().fill(LoopTheme.warning))
                    .overlay(Capsule().strokeBorder(LoopLook.page, lineWidth: 2))
                    .offset(x: 5, y: -4)
                    .allowsHitTesting(false)
            }
        }
        .help(count == 0 ? "No notifications" : count == 1 ? "1 notification" : "\(count) notifications")
        .accessibilityLabel("Notifications")
        .accessibilityValue("\(count)")
    }
}

/// Choices in a capsule; the chosen one sits on a lighter capsule that slides between them.
struct LoopSegments<Value: Hashable>: View {
    struct Option {
        let value: Value
        let title: String
        var symbol: String? = nil
    }

    @Binding var selection: Value
    let options: [Option]
    @Namespace private var space

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.value) { option in
                let chosen = option.value == selection
                Button {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.8)) { selection = option.value }
                } label: {
                    HStack(spacing: 6) {
                        if let symbol = option.symbol {
                            Image(systemName: symbol).font(.system(size: 10.5, weight: .bold))
                        }
                        Text(option.title).lineLimit(1)
                    }
                    .font(LoopLook.font(13, .medium))
                    .foregroundStyle(chosen ? LoopLook.ink : LoopLook.ink2)
                    .padding(.horizontal, 13)
                    .frame(height: 30)
                    .background {
                        if chosen { Capsule().fill(LoopLook.lift).matchedGeometryEffect(id: "chosen", in: space) }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(chosen ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Capsule().fill(LoopLook.panel))
        .overlay(Capsule().strokeBorder(LoopLook.line2, lineWidth: 1))
        .fixedSize()
    }
}

/// A capsule button on the page: an outline on the panel, or filled with the page's ink.
struct LoopPageButtonStyle: ButtonStyle {
    var filled = false
    var height: CGFloat = 36

    func makeBody(configuration: Configuration) -> some View {
        LoopHover { hovering in
            configuration.label
                .labelStyle(LoopPillLabelStyle())
                .font(LoopLook.font(13, .medium))
                .foregroundStyle(filled ? LoopLook.onInk : LoopLook.ink)
                .padding(.horizontal, 15)
                .frame(height: height)
                .background(Capsule().fill(filled ? LoopLook.ink.opacity(hovering ? 0.88 : 1)
                                           : hovering ? LoopLook.raise : LoopLook.panel))
                .overlay(Capsule().strokeBorder(LoopLook.line2.opacity(filled ? 0 : 1), lineWidth: 1))
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
                .contentShape(Capsule())
        }
    }
}

/// A round icon button on the page, such as the one that tightens the rows.
struct LoopRoundButtonStyle: ButtonStyle {
    var size: CGFloat = 36

    func makeBody(configuration: Configuration) -> some View {
        LoopHover { hovering in
            configuration.label
                .labelStyle(.iconOnly)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(hovering ? LoopLook.ink : LoopLook.ink2)
                .frame(width: size, height: size)
                .background(Circle().fill(hovering ? LoopLook.raise : LoopLook.panel))
                .overlay(Circle().strokeBorder(LoopLook.line2, lineWidth: 1))
                .scaleEffect(configuration.isPressed ? 0.94 : 1)
                .contentShape(Circle())
        }
    }
}

/// A word in a small capsule: a file's kind, a count's caption.
struct LoopPill: View {
    let text: String
    /// Filled with the sky colour, for the one that stands out.
    var bright = false

    var body: some View {
        Text(text)
            .font(LoopLook.font(12, .medium))
            .foregroundStyle(bright ? LoopLook.onSky : LoopLook.ink.opacity(0.86))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .frame(height: 24)
            .background(Capsule().fill(bright ? LoopLook.skySoft : LoopLook.rgb(0xF6F4EC, 0.08)))
    }
}

/// How a file stands: in use, shared, waiting on a review, or not used yet.
enum LoopSourceStatus {
    case review, shared, used, unused

    init(_ source: LoopSource, flagged: Bool) {
        if flagged {
            self = .review
        } else if source.activeShares > 0 {
            self = .shared
        } else if source.counts.total > 0 {
            self = .used
        } else {
            self = .unused
        }
    }

    var title: String {
        switch self {
        case .review: return "Needs review"
        case .shared: return "Shared"
        case .used: return "In use"
        case .unused: return "Not used yet"
        }
    }

    var dot: Color {
        switch self {
        case .review: return LoopTheme.warning
        case .shared: return LoopLook.sky
        case .used: return LoopLook.ink
        case .unused: return LoopLook.ink3
        }
    }

    var ink: Color { self == .unused ? LoopLook.ink3 : LoopLook.ink }
}

struct LoopStatusLabel: View {
    let status: LoopSourceStatus

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(status.dot).frame(width: 7, height: 7)
            Text(status.title).font(LoopLook.font(13.5)).foregroundStyle(status.ink).lineLimit(1)
        }
    }
}

/// How much a file is used beside the busiest one: a bar, filled that far.
struct LoopUsageBar: View {
    let fraction: Double
    var height: CGFloat = 4

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(LoopLook.track)
                Capsule().fill(LoopLook.ink)
                    .frame(width: max(fraction > 0 ? height : 0, geometry.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

extension LoopSource {
    /// "142 uses", or nil for a file nothing has used.
    var usesText: String? {
        let uses = counts.total
        return uses == 0 ? nil : uses == 1 ? "1 use" : "\(uses.formatted()) uses"
    }
}

/// Rows and cards come up into place one after another when a list is first
/// shown or its layout is switched; ones scrolled to later are simply there.
struct LoopRise: ViewModifier {
    let index: Int
    /// When the list was last laid out afresh.
    let since: Date
    @State private var risen = false

    func body(content: Content) -> some View {
        content
            .opacity(risen ? 1 : 0)
            .offset(y: risen ? 0 : 16)
            .scaleEffect(risen ? 1 : 0.975)
            .onAppear {
                guard !risen else { return }
                if Date().timeIntervalSince(since) < 0.45, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                    withAnimation(LoopLook.spring.delay(Double(min(index, 16)) * 0.035)) { risen = true }
                } else {
                    risen = true
                }
            }
    }
}

extension View {
    func loopRise(_ index: Int, since: Date) -> some View { modifier(LoopRise(index: index, since: since)) }

    /// A rounded panel of the dashboard: a card, or the ground a table sits on.
    func loopPanel(_ fill: Color = LoopLook.panel, radius: CGFloat = LoopLook.cardRadius) -> some View {
        background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(fill))
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}
