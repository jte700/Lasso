// The overview at the top of a sources page: the most used files as bubbles
// on a sky card, the kinds of file as circles sized by how many there are,
// and two counts, what changed this week and the links that are shared.
// Everything in it is counted from what The Loop already holds.

import Cocoa
import SwiftUI

struct LoopOverviewCards: View {
    @ObservedObject var store: LoopStore
    let directoryId: String?
    /// The room the row of cards has.
    let width: CGFloat

    private static let month: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMMyyyy")
        return formatter
    }()

    var body: some View {
        let summary = LoopLibrarySummary(sources: store.overview.sources, history: store.overview.history,
                                           links: store.overview.links.outgoing, directoryId: directoryId)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("Overview").font(LoopLook.font(16, .medium)).foregroundStyle(LoopLook.ink)
                Text("\(Self.month.string(from: Date())) \u{00B7} use to date")
                    .font(LoopLook.font(13.5)).foregroundStyle(LoopLook.ink3)
                Spacer(minLength: 8)
                Button("View changes") { store.section = .changes }
                    .buttonStyle(LoopQuietLinkStyle())
            }
            HStack(spacing: 12) {
                LoopUsedCard(summary: summary) { store.selectedSourceID = $0.id }
                if width >= 600 {
                    LoopKindsCard(kinds: summary.kinds, total: summary.total, chosen: store.kindFilter) { kind in
                        let filter = LoopKindFilter.keeping(kind) ?? .all
                        store.kindFilter = store.kindFilter == filter ? .all : filter
                    }
                    .frame(width: min(320, max(230, width * 0.27)))
                }
                if width >= 860 {
                    VStack(spacing: 12) {
                        LoopStatCard(title: "Changed this week", value: summary.changedThisWeek.formatted(),
                                      suffix: summary.changedThisWeek == 1 ? "file" : "files",
                                      help: "Show recent changes") { store.section = .changes } trailing: {
                            LoopIconStack(sources: summary.changedFiles, more: summary.changedThisWeek - summary.changedFiles.count)
                        }
                        LoopStatCard(title: "Shared links", value: summary.activeLinks.formatted(),
                                      suffix: summary.allLinks > summary.activeLinks ? "of \(summary.allLinks.formatted())" : "working",
                                      help: "Show links") { store.section = .links } trailing: {
                            if summary.driftedLinks > 0 {
                                LoopNotePill(text: "\(summary.driftedLinks) drifted")
                            } else if summary.expiringLinks > 0 {
                                LoopNotePill(text: summary.expiringLinks == 1 ? "1 expires soon" : "\(summary.expiringLinks) expire soon")
                            }
                        }
                    }
                    .frame(width: min(240, max(190, width * 0.22)))
                }
            }
            .frame(height: 250)
        }
    }
}

private struct LoopQuietLinkStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        LoopHover { hovering in
            configuration.label.font(LoopLook.font(13)).foregroundStyle(hovering ? LoopLook.ink : LoopLook.ink2)
        }
    }
}

// MARK: Most used

/// The sky card: how much the library is used, and its busiest files as bubbles.
private struct LoopUsedCard: View {
    let summary: LoopLibrarySummary
    let select: (LoopSource) -> Void

    var body: some View {
        GeometryReader { geometry in
            let roomy = geometry.size.width >= 420
            ZStack(alignment: .topLeading) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top) {
                        Text(summary.anyUsed ? "Most used sources" : "Newest sources")
                            .font(LoopLook.font(14)).foregroundStyle(LoopLook.onSky.opacity(0.78))
                        Spacer(minLength: 8)
                        badge
                    }
                    Spacer(minLength: 0)
                    Text((summary.anyUsed ? summary.totalUses : summary.total).formatted())
                        .font(LoopLook.font(60, .regular)).loopTracking(-0.05, size: 60)
                        .foregroundStyle(LoopLook.onSky)
                        .lineLimit(1).minimumScaleFactor(0.6)
                    Text(caption)
                        .font(LoopLook.font(13.5)).foregroundStyle(LoopLook.onSky.opacity(0.72))
                        .lineLimit(2).truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                        // Clear of the bubbles on its right.
                        .frame(maxWidth: geometry.size.width >= 330
                               ? geometry.size.width - LoopBubbleCluster.size.width * (roomy ? 1 : 0.8) - 44 : nil, alignment: .leading)
                }
                .padding(18)
                .allowsHitTesting(false)
                // Over the words, so a name a bubble shows is never under the badge.
                if geometry.size.width >= 330 {
                    LoopBubbleCluster(sources: summary.top, more: more, select: select)
                        .scaleEffect(roomy ? 1 : 0.8, anchor: .bottomTrailing)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(.trailing, 14)
                        .padding(.bottom, 12)
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: LoopLook.cardRadius, style: .continuous).fill(LoopLook.skySoft))
    }

    /// Files in use that have no bubble of their own.
    private var more: Int { summary.anyUsed ? max(0, summary.usedCount - summary.top.count) : max(0, summary.total - summary.top.count) }

    private var badge: some View {
        HStack(spacing: 6) {
            Circle().fill(summary.anyUsed ? LoopLook.lime : LoopLook.ink3).frame(width: 6, height: 6)
            Text(summary.anyUsed ? "\(summary.usedCount.formatted()) in use" : "None used yet")
        }
        .font(LoopLook.font(12, .medium))
        .foregroundStyle(LoopLook.ink)
        .padding(.horizontal, 11)
        .frame(height: 26)
        .background(Capsule().fill(LoopLook.onInk))
    }

    private var caption: String {
        guard summary.anyUsed else {
            return summary.total == 1 ? "file read \u{00B7} not used yet" : "files read \u{00B7} none used yet"
        }
        let share = summary.total > 0 ? Int((Double(summary.usedCount) / Double(summary.total) * 100).rounded()) : 0
        var parts = ["\(summary.totalUses == 1 ? "use" : "uses") \u{00B7} \(share)% of \(summary.total.formatted()) sources"]
        if summary.sharedCount > 0 { parts.append("\(summary.sharedCount.formatted()) shared") }
        return parts.joined(separator: " \u{00B7} ")
    }
}

/// A handful of files as circles packed together; the one under the pointer
/// swells and says its name, and a click opens it.
private struct LoopBubbleCluster: View {
    let sources: [LoopSource]
    let more: Int
    let select: (LoopSource) -> Void
    @State private var hovered: String?
    @State private var shown = false

    /// Where each bubble sits in the cluster's box and how wide it is, busiest first.
    private static let spots: [(x: CGFloat, y: CGFloat, d: CGFloat)] = [
        (158, 70, 80), (72, 58, 62), (112, 132, 58), (112, 24, 44), (52, 124, 42), (204, 134, 48), (210, 26, 36),
    ]
    private static let moreSpot: (x: CGFloat, y: CGFloat, d: CGFloat) = (162, 170, 46)
    static let size = CGSize(width: 240, height: 196)

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(sources.prefix(Self.spots.count).enumerated()), id: \.element.id) { index, source in
                let spot = Self.spots[index]
                let lifted = hovered == source.id
                // Hover and taps are read before the bubble is positioned: after
                // `.position` a bubble fills the whole cluster, and the lifted one
                // would keep the pointer from every other bubble.
                LoopSourceBubble(source: source, diameter: spot.d, lifted: lifted, nameBelow: spot.y < 60)
                    .onHover { inside in
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.6)) {
                            if inside { hovered = source.id } else if hovered == source.id { hovered = nil }
                        }
                    }
                    .onTapGesture { select(source) }
                    .accessibilityElement()
                    .accessibilityLabel(source.name)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { select(source) }
                    .scaleEffect(shown ? 1 : 0.3)
                    .opacity(shown ? 1 : 0)
                    .animation(.spring(response: 0.5, dampingFraction: 0.68).delay(0.12 + Double(index) * 0.05), value: shown)
                    .position(x: spot.x, y: spot.y)
                    .zIndex(lifted ? 2 : 0)
            }
            if more > 0 {
                Text("+\(LoopLibrarySummary.short(more))")
                    .font(LoopLook.font(12.5, .medium)).foregroundStyle(LoopLook.ink)
                    .frame(width: Self.moreSpot.d, height: Self.moreSpot.d)
                    .background(Circle().fill(LoopLook.onInk))
                    .scaleEffect(shown ? 1 : 0.3)
                    .opacity(shown ? 1 : 0)
                    .animation(.spring(response: 0.5, dampingFraction: 0.68).delay(0.5), value: shown)
                    .position(x: Self.moreSpot.x, y: Self.moreSpot.y)
                    .help(more == 1 ? "1 more file" : "\(more.formatted()) more files")
            }
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .onAppear { shown = true }
    }
}

private struct LoopSourceBubble: View {
    let source: LoopSource
    let diameter: CGFloat
    let lifted: Bool
    /// Near the top of the card the name goes under the bubble, clear of the badge.
    let nameBelow: Bool

    var body: some View {
        ZStack {
            Circle().fill(Color.white.opacity(lifted ? 0.98 : 0.74))
            Circle().strokeBorder(Color.white, lineWidth: 1.5)
            LoopFileIcon(url: nil, fileExtension: source.fileExtension, size: diameter * 0.56)
        }
        .frame(width: diameter, height: diameter)
        .shadow(color: LoopLook.onSky.opacity(lifted ? 0.28 : 0.1), radius: lifted ? 14 : 5, y: lifted ? 8 : 2)
        .scaleEffect(lifted ? 1.3 : 1)
        .overlay(alignment: nameBelow ? .bottom : .top) {
            if lifted {
                Text(source.name)
                    .font(LoopLook.font(12, .medium)).lineLimit(1)
                    .foregroundStyle(LoopLook.ink)
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .background(Capsule().fill(LoopLook.onInk))
                    .fixedSize()
                    .offset(y: (diameter * 0.15 + 34) * (nameBelow ? 1 : -1))
                    .transition(.opacity.combined(with: .scale(scale: 0.9, anchor: nameBelow ? .top : .bottom)))
                    .allowsHitTesting(false)
            }
        }
        .contentShape(Circle())
    }
}

// MARK: Kinds

/// The kinds of file as circles, each as large as its share; a click keeps only that kind.
private struct LoopKindsCard: View {
    let kinds: [(kind: String, count: Int)]
    let total: Int
    let chosen: LoopKindFilter
    let choose: (String) -> Void

    private static let fills: [Color] = [LoopLook.ropeSoft, LoopLook.skySoft, LoopLook.terracottaSoft, LoopLook.lift]
    private static let shown = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Sources by kind").font(LoopLook.font(14)).foregroundStyle(LoopLook.ink2)
            GeometryReader { geometry in
                let circles = LoopCirclePacking.pack(kinds.prefix(Self.shown).map(\.count), in: geometry.size)
                ZStack(alignment: .topLeading) {
                    ForEach(Array(kinds.prefix(Self.shown).enumerated()), id: \.element.kind) { index, entry in
                        let circle = circles[index]
                        LoopKindBubble(kind: entry.kind, count: entry.count, diameter: circle.d, fill: Self.fills[index],
                                        dark: index < 3, chosen: LoopKindFilter.keeping(entry.kind) == chosen && chosen != .all,
                                        index: index) { choose(entry.kind) }
                            .position(x: circle.x, y: circle.y)
                    }
                }
            }
            .padding(.vertical, 8)
            Text(shares).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3).lineLimit(1).truncationMode(.tail)
        }
        .padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .loopPanel()
    }

    /// "Text 52% · Spreadsheets 38% · Code 10%".
    private var shares: String {
        guard total > 0 else { return "No files yet" }
        return kinds.prefix(3).map { entry in
            let name = LoopKindFilter.keeping(entry.kind)?.title ?? LoopKindFilter.label(for: entry.kind)
            return "\(name) \(Int((Double(entry.count) / Double(total) * 100).rounded()))%"
        }.joined(separator: " \u{00B7} ")
    }
}

private struct LoopKindBubble: View {
    let kind: String
    let count: Int
    let diameter: CGFloat
    let fill: Color
    /// Dark type on the pale fills, light on the dark one.
    let dark: Bool
    let chosen: Bool
    let index: Int
    let action: () -> Void
    @State private var hovering = false
    @State private var shown = false

    var body: some View {
        let ink = dark ? LoopLook.onInk : LoopLook.ink
        Button(action: action) {
            VStack(spacing: 0) {
                Text(count.formatted())
                    .font(LoopLook.font(min(22, max(13, diameter * 0.2)), .medium)).monospacedDigit()
                    .foregroundStyle(ink)
                if diameter >= 62 {
                    Text(LoopKindFilter.label(for: kind))
                        .font(LoopLook.font(min(12.5, max(9.5, diameter * 0.115))))
                        .foregroundStyle(ink.opacity(0.62))
                        .lineLimit(1).minimumScaleFactor(0.8)
                }
            }
            .padding(.horizontal, 4)
            .frame(width: diameter, height: diameter)
            .background(Circle().fill(fill))
            .overlay(Circle().strokeBorder(LoopLook.ink, lineWidth: chosen ? 2 : 0).padding(-4))
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .scaleEffect(shown ? (hovering ? 1.06 : 1) : 0.4)
        .opacity(shown ? 1 : 0)
        .animation(.spring(response: 0.34, dampingFraction: 0.62), value: hovering)
        .animation(.spring(response: 0.55, dampingFraction: 0.7).delay(0.15 + Double(index) * 0.07), value: shown)
        .onHover { hovering = $0 }
        .onAppear { shown = true }
        .help(chosen ? "Show every kind again" : "Show only \(LoopKindFilter.keeping(kind)?.title.lowercased() ?? "these")")
        .accessibilityLabel("\(LoopKindFilter.label(for: kind)), \(count)")
    }
}

// MARK: Counts

/// A count on a small card that goes somewhere when clicked.
private struct LoopStatCard<Trailing: View>: View {
    let title: String
    let value: String
    let suffix: String
    let help: String
    let action: () -> Void
    @ViewBuilder var trailing: Trailing
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(LoopLook.font(14)).foregroundStyle(LoopLook.ink2).lineLimit(1)
                Spacer(minLength: 0)
                HStack(alignment: .lastTextBaseline, spacing: 8) {
                    Text(value)
                        .font(LoopLook.font(34, .regular)).loopTracking(-0.04, size: 34).monospacedDigit()
                        .foregroundStyle(LoopLook.ink)
                    Text(suffix).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3).lineLimit(1)
                    Spacer(minLength: 4)
                    trailing.alignmentGuide(.lastTextBaseline) { $0[.bottom] - 5 }
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .loopPanel(hovering ? LoopLook.raise : LoopLook.panel)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
        .help(help)
    }
}

/// A few files' icons in overlapping circles, and how many more there are.
private struct LoopIconStack: View {
    let sources: [LoopSource]
    let more: Int

    var body: some View {
        HStack(spacing: -8) {
            ForEach(sources) { source in
                LoopFileIcon(url: nil, fileExtension: source.fileExtension, size: 16)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(LoopLook.lift))
                    .overlay(Circle().strokeBorder(LoopLook.panel, lineWidth: 2))
            }
            if more > 0 {
                Text(LoopLibrarySummary.short(more))
                    .font(LoopLook.font(9.5, .medium)).foregroundStyle(LoopLook.ink2)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(LoopLook.raise))
                    .overlay(Circle().strokeBorder(LoopLook.panel, lineWidth: 2))
            }
        }
    }
}

/// A short note beside a count, such as how many links have drifted.
private struct LoopNotePill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(LoopLook.font(11.5, .medium)).foregroundStyle(LoopLook.onInk)
            .lineLimit(1)
            .padding(.horizontal, 9)
            .frame(height: 22)
            .background(Capsule().fill(LoopLook.terracottaSoft))
    }
}
