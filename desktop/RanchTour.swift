// The tour The Ranch opens with the first time: a white card in the middle
// of the window that walks through Lasso in four steps, each with a live
// demo: welcome (the website's 3D mascot), choosing folders, writing with
// suggestions, and sharing. Its last step turns the card into the Begin card
// (RanchOpening.swift). Nothing on the card is boxed: a plain header, the
// step's words, its demo on the white, and a line under the demo saying what
// it is doing, all in Figtree, the website's typeface.

import Cocoa
import SwiftUI

/// The tour's light look, from the website rework's light theme, on white.
enum RanchTourLook {
    static let card = Color.white
    /// Under a control the pointer is on.
    static let panel = RanchLook.rgb(0xF2F0EA)
    static let ink = RanchLook.rgb(0x1B1F17)
    static let ink2 = RanchLook.rgb(0x1B1F17, 0.66)
    static let ink3 = RanchLook.rgb(0x1B1F17, 0.44)
    static let line = RanchLook.rgb(0x1B1F17, 0.09)
    static let chip = RanchLook.rgb(0x1B1F17, 0.06)
    // The caption's dots: the mascot's colours, deepened to read on white.
    static let blue = RanchLook.rgb(0x2A6DB0)
    static let rope = RanchLook.rgb(0xA0782E)
    static let terracotta = RanchLook.rgb(0xC0583A)
    static let green = RanchLook.rgb(0x3E7D3A)
}

/// One sentence of a demo's caption, and when in the demo's loop it is said.
struct RanchTourLogLine {
    enum Tone { case blue, rope, terracotta, green }

    let at: Double
    let text: String
    let tone: Tone

    var color: Color {
        switch tone {
        case .blue: return RanchTourLook.blue
        case .rope: return RanchTourLook.rope
        case .terracotta: return RanchTourLook.terracotta
        case .green: return RanchTourLook.green
        }
    }
}

enum RanchTourStep: Int, CaseIterable {
    case welcome, folders, autocomplete, share

    var header: String {
        switch self {
        case .welcome: return "Welcome"
        case .folders: return "Choose folders"
        case .autocomplete: return "Autocomplete"
        case .share: return "Share"
        }
    }

    /// "1 of 4", at the right of the header.
    var count: String { "\(rawValue + 1) of \(Self.allCases.count)" }

    var title: String {
        switch self {
        case .welcome: return "Welcome to Lasso"
        case .folders: return "Point it at your work"
        case .autocomplete: return "Write, and it finds the source"
        case .share: return "Share exactly what you cited"
        }
    }

    var body: String {
        switch self {
        case .welcome:
            return "Lasso reads the folders you choose. As you write in any app, it offers the figure or passage you mean from your own files, linked to where it came from."
        case .folders:
            return "Choose any folders. Lasso reads the PDFs, spreadsheets, documents, slides and drawings in them, and keeps up as they change."
        case .autocomplete:
            return "Type in any app. Lasso offers the value or passage from your files, and Tab writes it in, linked to its source."
        case .share:
            return "Send a link to one cell, one passage or a whole file. The person you send it to sees just that, and where it came from."
        }
    }

    /// How long the demo runs before it starts again.
    var loop: Double {
        switch self {
        case .welcome: return 8.4
        case .folders: return 9.6
        case .autocomplete: return 10
        case .share: return 10.5
        }
    }

    /// What the demo is doing, said in turn under it.
    var log: [RanchTourLogLine] {
        switch self {
        case .welcome:
            return [.init(at: 0, text: "Lasso is ready on this Mac.", tone: .green),
                    .init(at: 2.1, text: "Your folders are read here, on this Mac.", tone: .blue),
                    .init(at: 4.2, text: "Suggestions come from your own files.", tone: .rope),
                    .init(at: 6.3, text: "Tab accepts a suggestion; Escape dismisses it.", tone: .terracotta)]
        case .folders:
            return [.init(at: 0, text: "Tick the folders Lasso should read.", tone: .blue),
                    .init(at: 2.9, text: "Three folders, 128 files found.", tone: .rope),
                    .init(at: 3.6, text: "Reading the PDFs, sheets and drawings.", tone: .terracotta),
                    .init(at: 6.9, text: "Ready, and all of it read on this Mac.", tone: .green)]
        case .autocomplete:
            return [.init(at: 0, text: "You write as you always do.", tone: .blue),
                    .init(at: 2.0, text: "Lasso finds 184 m in deck-loads.xlsx.", tone: .rope),
                    .init(at: 3.6, text: "Tab writes it in, linked to its source.", tone: .green),
                    .init(at: 7.2, text: "It comes from your files, not a language model.", tone: .terracotta)]
        case .share:
            return [.init(at: 0, text: "Every linked value knows where it came from.", tone: .blue),
                    .init(at: 2.6, text: "Choose to share just this cell.", tone: .rope),
                    .init(at: 3.55, text: "The link is copied, ready to send.", tone: .green),
                    .init(at: 5.0, text: "They see the cell and its source, nothing more.", tone: .terracotta)]
        }
    }

    var hint: String {
        switch self {
        case .welcome: return "Three short demos, then Begin. Click the mascot to spin it."
        case .folders: return "You choose your folders after Begin, or any time from the menu bar."
        case .autocomplete: return "Escape hides the card for the rest of the sentence."
        case .share: return "Stop a link any time from Links in The Ranch."
        }
    }

    /// A moment of the demo that shows what it is about, for Reduce Motion.
    var still: Double {
        switch self {
        case .welcome: return 0.2
        case .folders: return 7.4
        case .autocomplete: return 2.9
        case .share: return 6.2
        }
    }
}

enum RanchTour {
    private static let finishedKey = "RanchTourFinished"

    /// Whether the person has been through the tour, or skipped it; after
    /// that The Ranch opens on its Begin card, which can start the tour again.
    static func finished(_ defaults: UserDefaults = .standard) -> Bool { defaults.bool(forKey: finishedKey) }
    static func markFinished(_ defaults: UserDefaults = .standard) { defaults.set(true, forKey: finishedKey) }
}

/// The tour's card: its header bar, the step's words, its demo and its log,
/// and the way through. Steps slide across inside the card.
struct RanchTourCard: View {
    @ObservedObject var store: RanchStore
    /// Goes on to the Begin card, after the last step or a skip.
    let begin: () -> Void
    /// Whether the last move went forward, so steps slide the right way.
    @State private var forward = true

    private var step: RanchTourStep { RanchTourStep(rawValue: store.tourStep) ?? .welcome }

    var body: some View {
        GeometryReader { geometry in
            // Short windows drop the caption first, so the demo keeps its room.
            let roomy = geometry.size.height >= 560
            VStack(spacing: 0) {
                header
                ZStack {
                    RanchTourPage(step: step, captioned: roomy)
                        .id(step)
                        .transition(.asymmetric(
                            insertion: .offset(x: forward ? 44 : -44).combined(with: .opacity),
                            removal: .offset(x: forward ? -44 : 44).combined(with: .opacity)))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
                footer
            }
        }
        .background(RanchTourLook.card)
        .environment(\.colorScheme, .light)
        .background { keys }
    }

    /// The step's name and how far through the tour it is, as plain words.
    private var header: some View {
        HStack(spacing: 10) {
            Text(step.header)
                .font(RanchLook.font(14, .medium))
                .foregroundStyle(RanchTourLook.ink2)
                .id("title-\(step.rawValue)")
                .transition(.opacity)
            Spacer(minLength: 8)
            Text(step.count)
                .font(RanchLook.font(13)).monospacedDigit()
                .foregroundStyle(RanchTourLook.ink3)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 28)
        .padding(.top, 22)
        .frame(maxWidth: .infinity)
        .background(RanchWindowDragArea())
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button("Skip tour", action: skip)
                .buttonStyle(RanchTourQuietStyle())
                .help("Go straight to Begin; the tour can be started again from there")
            Spacer(minLength: 8)
            RanchTourDots(count: RanchTourStep.allCases.count, current: step.rawValue)
            Spacer(minLength: 8)
            Button(action: back) { Image(systemName: "chevron.left") }
                .buttonStyle(RanchTourRoundStyle())
                .opacity(step == .welcome ? 0 : 1)
                .disabled(step == .welcome)
                .help("Back")
                .accessibilityLabel("Back")
            Button(action: next) {
                HStack(spacing: 6) {
                    Text(step == RanchTourStep.allCases.last ? "Continue" : "Next")
                    Image(systemName: "arrow.right").font(.system(size: 11, weight: .semibold))
                }
            }
            .buttonStyle(RanchTourNextStyle())
            .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, 22)
        .frame(height: 72)
    }

    /// → and ← step through, and Escape skips, as well as the buttons.
    private var keys: some View {
        ZStack {
            Button("", action: next).keyboardShortcut(.rightArrow, modifiers: [])
            Button("", action: back).keyboardShortcut(.leftArrow, modifiers: [])
            Button("", action: skip).keyboardShortcut(.cancelAction)
        }
        .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }

    private func next() {
        guard let following = RanchTourStep(rawValue: step.rawValue + 1) else { return begin() }
        forward = true
        withAnimation(.spring(response: 0.5, dampingFraction: 0.86)) { store.tourStep = following.rawValue }
    }

    private func back() {
        guard let previous = RanchTourStep(rawValue: step.rawValue - 1) else { return }
        forward = false
        withAnimation(.spring(response: 0.5, dampingFraction: 0.86)) { store.tourStep = previous.rawValue }
    }

    private func skip() { begin() }
}

/// One step's words, demo and caption. Made afresh for each step, so its
/// demo starts from the beginning.
private struct RanchTourPage: View {
    let step: RanchTourStep
    /// Whether there is room for the caption under the demo.
    let captioned: Bool
    @State private var start = Date()
    private let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Text(step.title)
                    .font(RanchLook.font(step == .welcome ? 32 : 27, .medium))
                    .ranchTracking(-0.035, size: step == .welcome ? 32 : 27)
                    .foregroundStyle(RanchTourLook.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(step.body)
                    .font(RanchLook.font(15)).foregroundStyle(RanchTourLook.ink2)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 28)
            .padding(.top, 14)
            .padding(.bottom, 8)
            if step == .welcome {
                // The mascot draws itself, and follows the pointer on its own clock.
                RanchMascot3D()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("Lasso's mascot. Click to spin it.")
                if captioned {
                    TimelineView(.animation(paused: still)) { context in
                        RanchTourCaption(step: step, time: time(context.date))
                    }
                }
            } else {
                TimelineView(.animation(paused: still)) { context in
                    let now = time(context.date)
                    VStack(spacing: 0) {
                        RanchTourDemo(step: step, time: now)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .accessibilityElement()
                            .accessibilityLabel("A demo of \(step.header.lowercased())")
                        if captioned { RanchTourCaption(step: step, time: now) }
                    }
                }
            }
        }
    }

    private func time(_ date: Date) -> RanchDemoTime {
        RanchDemoTime(t: still ? step.still : date.timeIntervalSince(start).truncatingRemainder(dividingBy: step.loop),
                      loop: step.loop)
    }
}

/// What the demo is doing, in a plain sentence that gives way to the next as
/// the demo goes on, and a quieter line about the step underneath.
private struct RanchTourCaption: View {
    let step: RanchTourStep
    let time: RanchDemoTime

    var body: some View {
        let lines = step.log
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .leading) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    let until = index + 1 < lines.count ? lines[index + 1].at : step.loop
                    let shown = time.span(line.at, until, edge: 0.3)
                    HStack(spacing: 9) {
                        Circle().fill(line.color).frame(width: 7, height: 7)
                        Text(line.text)
                            .font(RanchLook.font(14.5, .medium))
                            .foregroundStyle(RanchTourLook.ink)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    }
                    .opacity(shown)
                    .offset(y: 5 * (1 - shown))
                }
            }
            .frame(height: 20, alignment: .leading)
            Text(step.hint)
                .font(RanchLook.font(13)).foregroundStyle(RanchTourLook.ink3)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 28)
        .padding(.top, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Where the tour is: a dot for each step, the current one drawn long.
private struct RanchTourDots: View {
    let count: Int
    let current: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index == current ? RanchTourLook.ink : RanchTourLook.ink.opacity(0.18))
                    .frame(width: index == current ? 20 : 6, height: 6)
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: current)
        .accessibilityElement()
        .accessibilityLabel("Step \(current + 1) of \(count)")
    }
}

private struct RanchTourNextStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RanchHover { hovering in
            configuration.label
                .font(RanchLook.font(14, .medium))
                .foregroundStyle(RanchTourLook.card)
                .padding(.horizontal, 18)
                .frame(height: 38)
                .background(Capsule().fill(RanchTourLook.ink.opacity(hovering ? 0.86 : 1)))
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
                .contentShape(Capsule())
        }
    }
}

private struct RanchTourRoundStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RanchHover { hovering in
            configuration.label
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(RanchTourLook.ink)
                .frame(width: 38, height: 38)
                .background(Circle().fill(hovering ? RanchTourLook.panel : RanchTourLook.card))
                .overlay(Circle().strokeBorder(RanchTourLook.line, lineWidth: 1))
                .scaleEffect(configuration.isPressed ? 0.94 : 1)
                .contentShape(Circle())
        }
    }
}

private struct RanchTourQuietStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RanchHover { hovering in
            configuration.label
                .font(RanchLook.font(13, .medium))
                .foregroundStyle(hovering ? RanchTourLook.ink : RanchTourLook.ink3)
                .contentShape(Rectangle())
        }
    }
}
