// The Ranch window: its opening, then a sidebar of library views and
// directories beside the page the chosen one shows.

import Cocoa
import SwiftUI
import UniformTypeIdentifiers

/// What the window asks the rest of Lasso to do.
struct RanchActions {
    /// Opens the share composer for a file; the rect is where it was asked from, in screen coordinates.
    let createShareLink: (RanchShareTarget, NSRect) -> Void
    let addDirectories: () -> Void
    /// Opens Lasso's Settings window.
    var openSettings: () -> Void = {}
    /// Pauses and resumes directories, one after another.
    var setDirectoriesActive: ([RanchDirectoryChange]) -> Void = { _ in }
}

enum RanchFormat {
    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEEEMMMMd")
        return formatter
    }()

    private static let medium: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    static func ago(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "Unknown" }
        let seconds = date.timeIntervalSince(now)
        guard abs(seconds) >= 60 else { return "just now" }
        // The formatter is slow and a list asks once a row per redraw, so its
        // words are kept by the whole minute they describe.
        let minutes = Int((seconds / 60).rounded(.towardZero))
        if let said = agoByMinute[minutes] { return said }
        if agoByMinute.count >= maxAgoKept { agoByMinute.removeAll() }
        let said = relative.localizedString(fromTimeInterval: Double(minutes) * 60)
        agoByMinute[minutes] = said
        return said
    }

    private static var agoByMinute: [Int: String] = [:]
    private static let maxAgoKept = 4096

    static func clock(_ date: Date?) -> String { date.map(time.string(from:)) ?? "" }
    static func full(_ date: Date?) -> String { date.map(medium.string(from:)) ?? "Unknown" }

    /// "Today", "Yesterday", or "Monday, October 19".
    static func dayTitle(_ date: Date, calendar: Calendar = .current) -> String {
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        return day.string(from: date)
    }

    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

extension RanchDirectory {
    var color: Color { RanchDirectoryColors.color(for: id) }

    /// The connected app's own symbol, a drive while it is disconnected, or a folder.
    var sidebarSymbol: String {
        if isApp, let symbol, NSImage(systemSymbolName: symbol, accessibilityDescription: nil) != nil { return symbol }
        if isApp { return "app" }
        return offline ? "externaldrive" : "folder"
    }

    /// The same symbol, filled where it has a filled form.
    var filledSymbol: String {
        let filled = sidebarSymbol + ".fill"
        return NSImage(systemSymbolName: filled, accessibilityDescription: nil) == nil ? sidebarSymbol : filled
    }
}

/// Each directory's colour, read from Settings once and again only after a
/// colour changes, not for every row a list draws.
enum RanchDirectoryColors {
    private static var known: [String: Color] = [:]
    private static let watcher = NotificationCenter.default.addObserver(
        forName: .directoryColorsDidChange, object: nil, queue: .main) { _ in known.removeAll() }

    static func color(for id: String) -> Color {
        _ = watcher
        if let color = known[id] { return color }
        let color = Color(nsColor: DirectoryColorPreferences.color(for: id)?.color ?? .controlAccentColor)
        known[id] = color
        return color
    }
}

/// The Finder's own icon for a file, or the one for its type. Lists use the
/// type's, kept once per extension, so a long list never reads the disk to draw.
/// Types macOS draws as plain white pages get Lasso's own (`RanchTypeIcon`).
struct RanchFileIcon: View {
    let url: URL?
    let fileExtension: String
    var size: CGFloat = 16

    private static var typeIcons: [String: NSImage] = [:]

    var body: some View {
        Image(nsImage: icon).resizable().interpolation(.high).frame(width: size, height: size)
    }

    private var icon: NSImage {
        if let drawn = RanchTypeIcon.image(for: fileExtension, size: size) { return drawn }
        if let url, FileManager.default.fileExists(atPath: url.path) { return NSWorkspace.shared.icon(forFile: url.path) }
        return Self.typeIcon(fileExtension)
    }

    static func typeIcon(_ fileExtension: String) -> NSImage {
        let key = fileExtension.lowercased()
        if let cached = typeIcons[key] { return cached }
        let icon = UTType(filenameExtension: key).map(NSWorkspace.shared.icon(for:)) ?? NSWorkspace.shared.icon(for: .data)
        typeIcons[key] = icon
        return icon
    }
}

/// A dot in the network's grey-to-green, for how much a file is used.
struct RanchActivityDot: View {
    let activity: Double
    var body: some View {
        Circle().fill(Color(nsColor: RanchActivityColor.color(for: activity))).frame(width: 7, height: 7)
            .help(activity > 0 ? "Used \(Int((activity * 100).rounded()))% as much as your busiest file" : "Not used yet")
    }
}

/// An empty pane: a quiet symbol, what is missing, and how to fill it.
struct RanchEmptyState: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 19))
                .foregroundStyle(RanchTheme.secondaryInk)
                .frame(width: 48, height: 48)
                .background(Circle().fill(RanchTheme.card))
            Text(title).font(RanchTheme.titleFont).foregroundStyle(RanchTheme.ink).multilineTextAlignment(.center)
            Text(message).font(.system(size: 12)).foregroundStyle(RanchTheme.secondaryInk)
                .multilineTextAlignment(.center).frame(maxWidth: 300)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct RanchRootView: View {
    @ObservedObject var store: RanchStore
    let actions: RanchActions
    @FocusState private var searchFocused: Bool
    @AppStorage("RanchSidebarWidth") private var sidebarWidth = 260.0
    private static let shortcuts: [RanchStore.Section] = [.sources, .changes, .reviews, .links, .review, .network]
    private static let sidebarWidths = 200.0...380.0

    var body: some View {
        let opening = store.isOpening
        ZStack {
            // Behind the glass sidebar, the desktop; each page draws its own solid ground.
            RanchWindowBackdrop().ignoresSafeArea()
            // The library waits, blurred and still, behind the opening's card,
            // and comes into focus as the card goes.
            library
                .blur(radius: opening ? 14 : 0)
                .scaleEffect(opening ? 0.985 : 1)
                .animation(.easeOut(duration: 0.7), value: opening)
                .allowsHitTesting(!opening)
                .accessibilityHidden(opening)
            // A source's share dialog, over the whole window.
            if let source = store.sharing {
                RanchShareFlow(store: store, source: source)
                    .id(source.id)
                    .transition(.opacity)
            }
            if store.stage != .home {
                RanchOpening(store: store, actions: actions)
            }
        }
        // Everything runs up under the window's buttons, the gas included.
        .ignoresSafeArea()
        .ranchDark()
        .frame(minWidth: 860, minHeight: 520)
        .background { shortcuts }
        .alert("Something Didn\u{2019}t Work", isPresented: Binding(get: { store.actionError != nil },
                                                                 set: { if !$0 { store.actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
    }

    /// The window as one surface: its material runs through the sidebar and
    /// the top row, and the page is a solid rounded panel set into it.
    private var library: some View {
        let panel = RoundedRectangle(cornerRadius: RanchGlass.panelRadius, style: .continuous)
        return ZStack(alignment: .topLeading) {
            HStack(spacing: 0) {
                if !store.sidebarHidden {
                    RanchSidebar(store: store, actions: actions, search: $searchFocused)
                        .frame(width: sidebarWidth)
                        .transition(.move(edge: .leading))
                    RanchColumnDivider(width: $sidebarWidth, range: Self.sidebarWidths, showsLine: false)
                }
                VStack(spacing: 0) {
                    RanchTitleRow(store: store, leading: store.sidebarHidden ? Self.windowButtons : 0)
                    page
                        .background(RanchTheme.surface)
                        .clipShape(panel)
                        .overlay(panel.strokeBorder(Color.white.opacity(0.06), lineWidth: 1))
                        .padding(.leading, store.sidebarHidden ? RanchGlass.panelInset : 0)
                        .padding([.trailing, .bottom], RanchGlass.panelInset)
                }
            }
            // Beside the window's own buttons, the one that hides and shows the sidebar.
            Button(action: toggleSidebar) {
                RanchLucideIcon(icon: .panelLeft, color: RanchTreeStyle.restInk)
            }
            .buttonStyle(RanchSidebarIconStyle())
            .help(store.sidebarHidden ? "Show Sidebar (\u{2303}\u{2318}S)" : "Hide Sidebar (\u{2303}\u{2318}S)")
            .accessibilityLabel(store.sidebarHidden ? "Show Sidebar" : "Hide Sidebar")
            .padding(.leading, RanchGlass.isAvailable ? 84 : 74)
            .frame(height: RanchTheme.titlebarHeight)
        }
    }

    /// Room the window's buttons and the sidebar button take at the top left.
    private static var windowButtons: CGFloat { RanchGlass.isAvailable ? 118 : 108 }

    /// What the chosen view shows beside the sidebar: sources, directories,
    /// changes, links and review items as pages of one kind of list, and the
    /// network across the whole width.
    @ViewBuilder
    private var page: some View {
        switch store.section ?? .sources {
        case .sources:
            RanchSourcesPage(store: store, actions: actions, directoryId: nil, search: $searchFocused)
        case .directory(let id):
            RanchSourcesPage(store: store, actions: actions, directoryId: id, search: $searchFocused)
        case .network:
            RanchNetworkPane(store: store, actions: actions)
        case .changes:
            RanchActivityPage(store: store, actions: actions, kind: .changes)
        case .links:
            RanchActivityPage(store: store, actions: actions, kind: .links)
        case .review:
            RanchActivityPage(store: store, actions: actions, kind: .review)
        case .reviews:
            RanchReviewPage(store: store, model: store.reviews)
        }
    }

    private func toggleSidebar() {
        withAnimation(.easeInOut(duration: 0.2)) { store.sidebarHidden.toggle() }
    }

    /// Command-F searches, unless code being read has the keyboard: its own
    /// find bar keeps Command-F, as in any text view.
    private func find() {
        if let text = NSApp.keyWindow?.firstResponder as? NSTextView, !text.isFieldEditor {
            let item = NSMenuItem()
            item.tag = Int(NSFindPanelAction.showFindPanel.rawValue)
            text.performFindPanelAction(item)
            return
        }
        // The sources pages put the cursor in their search bar; the other views use the sidebar's field.
        switch store.section ?? .sources {
        case .sources, .directory:
            store.searchRequest += 1
        default:
            if store.sidebarHidden { toggleSidebar() }
            searchFocused = true
        }
    }

    /// Command-1 to Command-6 go to the library views, as Mail's do to its
    /// mailboxes; Control-Command-S hides the sidebar, as in Finder and Mail.
    private var shortcuts: some View {
        ZStack {
            ForEach(Array(Self.shortcuts.enumerated()), id: \.offset) { index, section in
                RanchHiddenShortcut(key: KeyEquivalent(Character("\(index + 1)"))) { store.section = section }
            }
            RanchHiddenShortcut(key: "s", modifiers: [.command, .control], action: toggleSidebar)
            RanchHiddenShortcut(key: "f", action: find)
        }
    }
}

/// A keyboard shortcut with no button of its own on screen.
struct RanchHiddenShortcut: View {
    let key: KeyEquivalent
    var modifiers: EventModifiers = .command
    let action: () -> Void

    var body: some View {
        Button("", action: action)
            .keyboardShortcut(key, modifiers: modifiers)
            .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }
}
