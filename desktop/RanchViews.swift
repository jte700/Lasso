// The Ranch window: a sidebar of library views and directories, a list of
// what the chosen view holds, and the selected file on the right.

import Cocoa
import SwiftUI
import UniformTypeIdentifiers

/// What the window asks the rest of Lasso to do.
struct RanchActions {
    /// Opens the share composer for a file; the rect is where it was asked from, in screen coordinates.
    let createShareLink: (RanchShareTarget, NSRect) -> Void
    let addDirectories: () -> Void
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
        return abs(now.timeIntervalSince(date)) < 60 ? "just now" : relative.localizedString(for: date, relativeTo: now)
    }

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
    var color: Color { Color(nsColor: DirectoryColorPreferences.color(for: id)?.color ?? .controlAccentColor) }

    /// The connected app's own symbol, a drive while it is disconnected, or a folder.
    var sidebarSymbol: String {
        if isApp, let symbol, NSImage(systemSymbolName: symbol, accessibilityDescription: nil) != nil { return symbol }
        if isApp { return "app" }
        return offline ? "externaldrive" : "folder"
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

/// An empty pane, said the way macOS says it.
struct RanchEmptyState: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 34, weight: .light)).foregroundStyle(.tertiary)
            Text(title).font(.title3.weight(.semibold))
            Text(message).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 320)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct RanchRootView: View {
    @ObservedObject var store: RanchStore
    let actions: RanchActions

    var body: some View {
        Group {
            // The network needs room, so it takes the whole width and shows
            // the chosen file beside it instead of in a third column.
            if store.section == .network {
                NavigationSplitView {
                    sidebar
                } detail: {
                    RanchNetworkPane(store: store, actions: actions)
                }
            } else {
                NavigationSplitView {
                    sidebar
                } content: {
                    RanchContent(store: store)
                        .navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 700)
                } detail: {
                    RanchDetail(store: store, actions: actions)
                }
            }
        }
        .frame(minWidth: 860, minHeight: 520)
        .alert("Something Didn\u{2019}t Work", isPresented: Binding(get: { store.actionError != nil },
                                                                 set: { if !$0 { store.actionError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
    }

    private var sidebar: some View {
        RanchSidebar(store: store, actions: actions)
            .navigationSplitViewColumnWidth(min: 190, ideal: 230, max: 320)
    }
}

struct RanchSidebar: View {
    @ObservedObject var store: RanchStore
    let actions: RanchActions
    private static let shortcuts: [RanchStore.Section] = [.changes, .sources, .links, .review, .network]
    /// Section headers run wider than rows; this lines the sort menu up with the file counts below it.
    private static let countColumnInset: CGFloat = 16

    var body: some View {
        List(selection: $store.section) {
            Section("Library") {
                Label("Recent Changes", systemImage: "clock.arrow.circlepath")
                    .badge(store.overview.history.count)
                    .tag(RanchStore.Section.changes)
                Label("All Sources", systemImage: "square.stack.3d.up")
                    .badge(store.overview.sources.count)
                    .tag(RanchStore.Section.sources)
                Label("Links", systemImage: "link")
                    .badge(store.activeLinkCount + store.overview.links.received.count)
                    .tag(RanchStore.Section.links)
                Label { Text("Needs Review") } icon: {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(store.reviewCount > 0 ? .orange : .secondary)
                }
                .badge(store.reviewCount)
                .tag(RanchStore.Section.review)
                Label("Network", systemImage: "point.3.connected.trianglepath.dotted")
                    .tag(RanchStore.Section.network)
            }
            Section {
                ForEach(store.folders) { directory in
                    RanchDirectoryRow(directory: directory).tag(RanchStore.Section.directory(directory.id))
                }
                if store.folders.isEmpty && store.hasLoaded {
                    Button("Add Work Directories\u{2026}", action: actions.addDirectories)
                        .buttonStyle(.link)
                }
            } header: {
                HStack {
                    Text("Directories")
                    Spacer()
                    RanchOrderMenu(title: "Sort Directories By", order: $store.directoryOrder)
                        .padding(.trailing, Self.countColumnInset)
                }
            }
            if !store.apps.isEmpty {
                Section("Connected Apps") {
                    ForEach(store.apps) { directory in
                        RanchDirectoryRow(directory: directory).tag(RanchStore.Section.directory(directory.id))
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $store.searchText, placement: .sidebar, prompt: "Search files")
        // Command-1 to Command-5 go to the library views, as Mail's do to its mailboxes.
        .background {
            ForEach(Array(Self.shortcuts.enumerated()), id: \.offset) { index, section in
                Button("") { store.section = section }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                    .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
            }
        }
    }
}

/// Last Edited, Recently Used, Oldest or Newest, from a small menu.
struct RanchOrderMenu: View {
    let title: String
    @Binding var order: RanchOrder

    var body: some View {
        Menu {
            Picker(title, selection: $order) {
                ForEach(RanchOrder.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            HStack(spacing: 2) {
                Text(order.title)
                Image(systemName: "chevron.down").imageScale(.small)
            }
        }
        .modifier(HeaderMenuStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .help(title)
    }
}

/// A menu that reads as part of a section header: its label in the header's
/// own type and colour. A plain SwiftUI label needs macOS 14; macOS 13 keeps
/// the borderless pop-up, made small.
private struct HeaderMenuStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 14, *) {
            content.menuStyle(.button).buttonStyle(.plain)
        } else {
            content.menuStyle(.borderlessButton).controlSize(.small)
        }
    }
}

struct RanchDirectoryRow: View {
    let directory: RanchDirectory

    var body: some View {
        Label {
            HStack(spacing: 6) {
                Text(directory.name).lineLimit(1)
                if !directory.active {
                    Text("Paused").font(.caption).foregroundStyle(.secondary)
                } else if directory.offline {
                    Text("Offline").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if directory.issue != nil {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
                        .help(directory.issue ?? "")
                }
            }
        } icon: {
            Image(systemName: directory.sidebarSymbol).foregroundStyle(directory.color)
        }
        .badge(directory.listedCount)
        .help(directory.rootPath)
    }
}
