// How The Ranch opens: a card pops up in the middle of the window, over the
// library dimmed behind it. The first time, the card is the tour
// (RanchTour.swift), four light steps with live demos. Its last step turns it
// into the Begin card: the window's dark panel with a field of dots that
// gather in colour round the pointer (RanchDotField.swift), its name at the
// bottom left and a slab of glass in the middle saying Begin. Pressed, the
// slab grows into the directories Lasso reads, ticked, with a way to add more.
// Next (or Skip, with none) sends the card outward and the library comes into
// focus. After the tour, the card shows once each time Lasso starts, so after
// an update or a restart, not every time the window opens (`RanchWindow`).

import Cocoa
import SwiftUI

struct RanchOpening: View {
    @ObservedObject var store: RanchStore
    let actions: RanchActions
    @State private var hovering = false
    /// Off until the card has popped up, so it rises into place when the window opens.
    @State private var shown = false

    private static let wordmarkSize: CGFloat = 54
    private static let cardRadius: CGFloat = 30
    /// The room kept round the slab inside the card.
    private static let cardInset: CGFloat = 48
    /// How long the card takes to go before the opening is put away.
    private static let leaving = 1.0

    private var isLeaving: Bool { store.stage == .leaving }
    private var touring: Bool { store.stage == .tour }

    var body: some View {
        GeometryReader { geometry in
            let card = cardSize(in: geometry.size)
            ZStack {
                // The dimmed library around the card takes no clicks; dragging it moves the window.
                RanchWindowDragArea()
                    .background(Color.black.opacity(isLeaving || !shown ? 0 : 0.42))
                    .accessibilityHidden(true)
                cardBody(card)
                    .frame(width: card.width, height: card.height)
                    .clipShape(RoundedRectangle(cornerRadius: Self.cardRadius, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Self.cardRadius, style: .continuous)
                        .strokeBorder(touring ? Color.black.opacity(0.06) : Color.white.opacity(0.1), lineWidth: 1))
                    // Leaving, its edges soften, so it dissolves rather than moving as a pane.
                    .blur(radius: isLeaving ? 36 : 0)
                    .shadow(color: .black.opacity(isLeaving ? 0 : 0.55), radius: 50, y: 24)
                    // Popping up it rises from a little smaller; leaving, it spreads out past the window.
                    .scaleEffect(isLeaving ? 1.5 : shown ? 1 : 0.9)
                    .opacity(isLeaving || !shown ? 0 : 1)
                    .accessibilityElement(children: .contain)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .ignoresSafeArea()
        .ranchDark()
        .onAppear {
            guard !shown else { return }
            withAnimation(.spring(response: 0.6, dampingFraction: 0.82).delay(0.12)) { shown = true }
        }
    }

    /// The tour, or the dots and their glass; as one gives way to the other the
    /// card grows from the tour's tall card to the Begin card.
    @ViewBuilder
    private func cardBody(_ card: CGSize) -> some View {
        ZStack {
            if touring {
                RanchTourCard(store: store, begin: toBegin)
                    .transition(.opacity.animation(.easeOut(duration: 0.18)))
            } else {
                ZStack {
                    // The window's own panel, so the card is of a piece with the library behind it.
                    RanchLook.panel.opacity(isLeaving ? 0 : 1)
                        .animation(.easeOut(duration: 0.16), value: isLeaving)
                    RanchDotField(disperse: fade)
                    wordmark
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                        .padding(.leading, 34)
                        .padding(.bottom, 28)
                        .allowsHitTesting(false)
                    slab(in: card)
                    tourLink
                }
                .transition(.opacity.animation(.easeIn(duration: 0.45).delay(0.12)))
            }
        }
    }

    /// On the Begin card, a way back into the tour.
    @ViewBuilder private var tourLink: some View {
        if store.stage == .welcome {
            Button(action: startTour) {
                HStack(spacing: 6) {
                    Image(systemName: "play.circle").font(.system(size: 13, weight: .medium))
                    Text("How Lasso works")
                }
                .font(RanchLook.font(13, .medium))
            }
            .buttonStyle(RanchTourLinkStyle())
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            .padding(.trailing, 30)
            .padding(.bottom, 34)
            .transition(.opacity)
        }
    }

    /// The card fills most of the window, as wide as a page; the directories may
    /// make it taller. The tour's card is tall and narrow, like a page held up.
    private func cardSize(in window: CGSize) -> CGSize {
        if touring { return CGSize(width: min(456, window.width - 64), height: min(700, window.height - 56)) }
        let width = min(940, window.width - 96)
        let base = min(560, window.height - 110)
        guard store.stage != .welcome else { return CGSize(width: width, height: base) }
        let step = RanchDirectoryStep.height(rows: store.orderedDirectories.count, loaded: store.hasLoaded)
        return CGSize(width: width, height: min(window.height - 56, max(base, step + Self.cardInset * 2)))
    }

    /// How far the dots have faded at each step: mostly gone behind the directories.
    private var fade: Double {
        switch store.stage {
        case .tour, .welcome: return 0
        case .directories: return 0.6
        case .leaving, .home: return 1
        }
    }

    private var wordmark: some View {
        Text(Ranch.title)
            .font(RanchLook.font(Self.wordmarkSize, .medium))
            .ranchTracking(-0.035, size: Self.wordmarkSize)
            .foregroundStyle(RanchLook.ink)
            .shadow(color: .black.opacity(0.35), radius: 18, y: 4)
            // It steps back while the directories are up, so the glass never sits over it.
            .opacity(store.stage == .welcome ? 1 : 0)
            .animation(.easeOut(duration: 0.25), value: store.stage)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: The glass in the middle

    /// One piece of glass throughout: the Begin button, then, grown, the directories.
    private func slab(in card: CGSize) -> some View {
        let welcome = store.stage == .welcome
        let size = slabSize(in: card)
        let shape = RoundedRectangle(cornerRadius: welcome ? 20 : 28, style: .continuous)
        return ZStack {
            if welcome {
                Button(action: begin) {
                    Text("Begin")
                        .font(RanchLook.font(18, .medium))
                        .ranchTracking(-0.02, size: 18)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(RanchSlabButtonStyle())
                .keyboardShortcut(.defaultAction)
                .onHover { hovering = $0 }
                // The word swells and fades as the glass grows past it.
                .transition(.opacity.combined(with: .scale(scale: 1.5)))
            } else {
                RanchDirectoryStep(store: store, add: actions.addDirectories, apply: actions.setDirectoriesActive,
                                   done: finish)
                    .frame(width: size.width)
                    .transition(.opacity.animation(.easeOut(duration: 0.3).delay(0.2)))
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(shape)
        .modifier(RanchOpeningGlass(shape: shape, lit: welcome && hovering, frost: welcome ? 0.15 : 0.04))
        .scaleEffect(welcome && hovering ? 1.05 : 1)
        // Leaving, the glass goes first so nothing of it is seen over the library.
        .opacity(isLeaving ? 0 : 1)
        .animation(.easeOut(duration: 0.16), value: isLeaving)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: hovering)
    }

    private func slabSize(in card: CGSize) -> CGSize {
        if store.stage == .welcome { return CGSize(width: 136, height: 58) }
        let height = RanchDirectoryStep.height(rows: store.orderedDirectories.count, loaded: store.hasLoaded)
        return CGSize(width: min(560, card.width - Self.cardInset * 2), height: min(height, card.height - Self.cardInset * 2))
    }

    // MARK: Steps

    /// From the tour to the Begin card; the tour is not shown on its own again.
    private func toBegin() {
        RanchTour.markFinished()
        withAnimation(.spring(response: 0.62, dampingFraction: 0.86)) { store.stage = .welcome }
    }

    private func startTour() {
        hovering = false
        withAnimation(.spring(response: 0.62, dampingFraction: 0.86)) {
            store.tourStep = 0
            store.stage = .tour
        }
    }

    private func begin() {
        hovering = false
        store.reload()
        withAnimation(.spring(response: 0.66, dampingFraction: 0.84)) { store.stage = .directories }
    }

    private func finish() {
        guard store.stage == .directories else { return }
        withAnimation(.easeIn(duration: 0.55)) { store.stage = .leaving }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.leaving) {
            // Left alone if the window was closed and opened again meanwhile.
            guard store.stage == .leaving else { return }
            store.stage = .home
        }
    }
}

/// Glass over the dots: Liquid Glass on macOS 26, a frosted pane before it.
private struct RanchOpeningGlass<Outline: InsettableShape>: ViewModifier {
    let shape: Outline
    /// Brighter while the pointer is on the Begin button.
    let lit: Bool
    /// How milky the glass is: more for the Begin button, less once it holds the directories.
    let frost: Double

    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content
                .background(shape.fill(Color.white.opacity(lit ? 0.24 : frost)))
                .glassEffect(.regular, in: shape)
                .shadow(color: .black.opacity(0.22), radius: 30, y: 16)
        } else {
            content
                .background(shape.fill(Color.white.opacity(lit ? 0.26 : frost + 0.02)))
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.strokeBorder(Color.white.opacity(0.2), lineWidth: 1))
                .shadow(color: .black.opacity(0.28), radius: 30, y: 16)
        }
    }
}

/// The Begin card's way back into the tour: quiet white words that brighten under the pointer.
private struct RanchTourLinkStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RanchHover { hovering in
            configuration.label
                .foregroundStyle(Color.white.opacity(hovering ? 0.95 : 0.7))
                .padding(.horizontal, 12)
                .frame(height: 30)
                .background(Capsule().fill(Color.white.opacity(hovering ? 0.14 : 0.08)))
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .contentShape(Capsule())
        }
    }
}

/// The Begin button gives a little under the press.
private struct RanchSlabButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: Directories

/// The directories Lasso reads, ticked, with a way to add more and a way on.
/// A click ticks or unticks one; going on pauses the unticked and resumes the
/// ticked. Nothing in a folder is changed, and a paused one keeps its history.
struct RanchDirectoryStep: View {
    @ObservedObject var store: RanchStore
    let add: () -> Void
    /// Pauses and resumes directories as the ticks ask.
    let apply: ([RanchDirectoryChange]) -> Void
    let done: () -> Void
    @State private var shown = false
    @State private var ticks = RanchDirectoryTicks()

    private static let rowHeight: CGFloat = 60
    private static let rowGap: CGFloat = 6
    /// More directories than this scroll.
    private static let rowsInView = 5
    private static let headerHeight: CGFloat = 112
    private static let footerHeight: CGFloat = 84
    /// Folders added from the open panel show here within a couple of seconds.
    private let refresh = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    /// How tall the glass grows to hold this many directories.
    static func height(rows: Int, loaded: Bool) -> CGFloat {
        guard loaded, rows > 0 else { return headerHeight + 96 + footerHeight }
        let inView = min(rows, rowsInView)
        // Half of the next row shows when there are more, so the list reads as one that scrolls.
        let peek: CGFloat = rows > rowsInView ? rowHeight * 0.5 : 0
        return headerHeight + CGFloat(inView) * (rowHeight + rowGap) + peek + footerHeight
    }

    var body: some View {
        let directories = store.orderedDirectories
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(directories.isEmpty ? "Choose your directories" : "Your directories")
                        .font(RanchLook.font(26, .medium)).ranchTracking(-0.025, size: 26)
                        .foregroundStyle(.white)
                    Spacer(minLength: 8)
                    if !directories.isEmpty {
                        Text("\(ticks.count(directories)) of \(directories.count) ticked")
                            .font(RanchLook.font(13)).monospacedDigit().foregroundStyle(Color.white.opacity(0.6))
                            .contentTransition(.numericText())
                    }
                }
                Text(caption(directories))
                    .font(RanchLook.font(13.5)).foregroundStyle(Color.white.opacity(0.66))
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 28)
            .padding(.top, 26)
            .frame(height: Self.headerHeight, alignment: .top)
            if !store.hasLoaded {
                waiting
            } else if directories.isEmpty {
                none
            } else {
                ScrollView {
                    VStack(spacing: Self.rowGap) {
                        ForEach(Array(directories.enumerated()), id: \.element.id) { index, directory in
                            RanchDirectoryStepRow(directory: directory, color: directory.color,
                                                  ticked: ticks.isTicked(directory)) {
                                withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) { ticks.toggle(directory) }
                            }
                                .frame(height: Self.rowHeight)
                                .opacity(shown ? 1 : 0)
                                .offset(y: shown ? 0 : 12)
                                .animation(RanchLook.spring.delay(0.24 + Double(min(index, 8)) * 0.05), value: shown)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .frame(maxHeight: .infinity)
            }
            footer(directories)
        }
        .onAppear {
            shown = true
            ticks.meet(directories)
        }
        // A directory just added, or the library read for the first time, comes in ticked as it is.
        .onChange(of: directories.map(\.id)) { _ in ticks.meet(store.orderedDirectories) }
        .onReceive(refresh) { _ in store.reload() }
    }

    /// Pauses and resumes what the ticks changed, then goes on.
    private func next() {
        let changes = ticks.changes(store.orderedDirectories)
        if !changes.isEmpty { apply(changes) }
        done()
    }

    private func caption(_ directories: [RanchDirectory]) -> String {
        if !store.hasLoaded { return "Lasso is opening its library." }
        if directories.isEmpty {
            return "Pick the folders Lasso should read. Their files become sources you can cite from any app."
        }
        return "Lasso reads the ones you tick and pauses the rest. Nothing in a folder is changed."
    }

    private var waiting: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(store.loadError == nil ? "Reading your library\u{2026}" : "Waiting for Lasso\u{2019}s library\u{2026}")
                .font(RanchLook.font(13.5)).foregroundStyle(Color.white.opacity(0.66))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var none: some View {
        Button(action: add) {
            VStack(spacing: 8) {
                Image(systemName: "folder.badge.plus").font(.system(size: 22, weight: .medium))
                Text("Add Directories\u{2026}").font(RanchLook.font(14, .medium))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(0.3), style: StrokeStyle(lineWidth: 1.2, dash: [5, 5])))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
        .padding(.bottom, 4)
        .help("Choose folders for Lasso to read")
    }

    private func footer(_ directories: [RanchDirectory]) -> some View {
        HStack(spacing: 10) {
            if !directories.isEmpty {
                Button(action: add) {
                    Label("Add More\u{2026}", systemImage: "plus")
                }
                .buttonStyle(RanchStepButtonStyle(filled: false))
                .help("Choose more folders for Lasso to read")
            }
            Spacer(minLength: 0)
            Button(action: next) {
                Text(directories.isEmpty ? "Skip" : "Next")
            }
            .buttonStyle(RanchStepButtonStyle(filled: !directories.isEmpty))
            .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, 22)
        .frame(height: Self.footerHeight)
    }
}

/// One directory: its tick, its name, where it is and how much it holds. A
/// click ticks or unticks it; a connected app's tick stays, since apps are
/// switched on and off where they were connected.
private struct RanchDirectoryStepRow: View {
    let directory: RanchDirectory
    let color: Color
    let ticked: Bool
    let toggle: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 13) {
                ZStack {
                    Circle().fill(ticked ? RanchLook.sky : Color.clear)
                    Circle().strokeBorder(Color.white.opacity(ticked ? 0 : hovering ? 0.6 : 0.34), lineWidth: 1.4)
                    if ticked {
                        Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(RanchLook.onSky)
                            .transition(.scale(scale: 0.4).combined(with: .opacity))
                    }
                }
                .frame(width: 24, height: 24)
                .scaleEffect(ticked ? 1 : 0.92)
                .opacity(directory.isApp ? 0.55 : 1)
                Image(systemName: directory.filledSymbol).font(.system(size: 17)).foregroundStyle(color).frame(width: 24)
                    .opacity(ticked ? 1 : 0.5)
                VStack(alignment: .leading, spacing: 2) {
                    Text(directory.name).font(RanchLook.font(15, .medium))
                        .foregroundStyle(Color.white.opacity(ticked ? 1 : 0.6)).lineLimit(1)
                    Text(place).font(RanchLook.font(12)).foregroundStyle(Color.white.opacity(0.55))
                        .lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Text(count).font(RanchLook.font(12.5)).monospacedDigit()
                    .foregroundStyle(Color.white.opacity(ticked ? 0.66 : 0.4))
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(hovering && !directory.isApp ? 0.11 : 0.07)))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(directory.isApp)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.15), value: hovering)
        .help(directory.isApp ? "Connected apps are switched on and off where they were connected"
              : ticked ? "Untick to pause this directory" : "Tick for Lasso to read this directory")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(ticked ? [.isButton, .isSelected] : .isButton)
        .accessibilityValue(ticked ? "Ticked" : "Not ticked")
    }

    /// Where it is, and what going on will do to it when its tick was changed.
    private var place: String {
        if directory.isApp { return "Connected app" }
        let path = (directory.rootPath as NSString).abbreviatingWithTildeInPath
        if ticked != directory.active { return (ticked ? "Will be read" : "Will be paused") + " \u{00B7} \(path)" }
        if !directory.active { return "Paused \u{00B7} \(path)" }
        return directory.offline ? "Offline \u{00B7} \(path)" : path
    }

    private var count: String {
        let files = directory.listedCount
        return files == 1 ? "1 file" : "\(files.formatted()) files"
    }
}

/// The step's buttons: Next filled with the page's ink, the others glassy outlines.
struct RanchStepButtonStyle: ButtonStyle {
    let filled: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(RanchLook.font(14, .medium))
            .foregroundStyle(filled ? RanchLook.onInk : Color.white)
            .padding(.horizontal, filled ? 26 : 18)
            .frame(height: 40)
            .background(Capsule().fill(filled ? RanchLook.ink : Color.white.opacity(configuration.isPressed ? 0.2 : 0.12)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(filled ? 0 : 0.16), lineWidth: 1))
            .opacity(configuration.isPressed && filled ? 0.82 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .contentShape(Capsule())
    }
}
