// The Loop's Network, laid out as its other pages are: a large title and a
// line about what it shows, capsule controls, and the network itself on a
// rounded panel. Directories are hubs in their own colours, their busiest
// files around them, and lines where files connect, in one directory or
// across several (LoopNetworkCanvas.swift draws them). Files go from grey
// (unused) to lime (most tabbed, opened, viewed, shared or linked). Hovering
// a file lights up what it connects to and lists why; hovering a line says
// what joins its two files, in one directory or across two
// (LoopNetworkConnections.swift words it). Clicking a file brings it in from
// the right, as a file chosen in a list does.

import Cocoa
import SwiftUI

/// The network across the page, with a chosen file drawn in over its right.
struct LoopNetworkPane: View {
    @ObservedObject var store: LoopStore
    let actions: LoopActions

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .trailing) {
                LoopNetworkView(store: store)
                LoopFileDrawer(store: store, actions: actions, width: geometry.size.width)
                    .zIndex(3)
            }
        }
        .background(LoopLook.page)
    }
}

struct LoopNetworkView: View {
    @ObservedObject var store: LoopStore
    /// By id, not place: a click that narrows the network, or the refresh
    /// after a visit, redraws it under a resting pointer, and an old index
    /// would point at another node or past the end.
    @State private var hoveredID: String?
    /// The two files of the line under the pointer, by id, when no node is.
    @State private var hoveredPair: LoopNetworkPair?
    @State private var zoom: CGFloat = 1
    @State private var settledZoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var settledPan: CGSize = .zero

    var body: some View {
        let layout = store.networkLayout()
        VStack(alignment: .leading, spacing: 0) {
            heading(layout)
            controls
            Group {
                if layout.nodes.isEmpty {
                    LoopEmptyState(symbol: store.hasLoaded ? "point.3.connected.trianglepath.dotted" : "hourglass",
                                    title: store.hasLoaded ? "Nothing to Connect Yet" : "Gathering Your Sources",
                                    message: store.hasLoaded ? "Add a work directory and its files appear here."
                                        : "The Loop is reading Lasso\u{2019}s library.")
                } else {
                    GeometryReader { geometry in
                        ZStack(alignment: .bottom) {
                            canvas(layout, size: geometry.size)
                            footer(layout)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .loopPanel()
            .overlay(RoundedRectangle(cornerRadius: LoopLook.cardRadius, style: .continuous)
                .strokeBorder(LoopLook.line2, lineWidth: 1))
            .padding(.top, 22)
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 28)
        .onChange(of: store.networkDirectory) { _ in resetView() }
        // ⌘Z (Edit > Undo) brings back the whole network in one step, however
        // far a click narrowed it or a pinch or drag moved it.
        .onChange(of: viewpoint) { _ in
            if showsWholeNetwork { forgetWholeNetwork() } else { offerWholeNetwork() }
        }
        .onAppear { if !showsWholeNetwork { offerWholeNetwork() } }
        .onDisappear { forgetWholeNetwork() }
    }

    // MARK: Top

    private func heading(_ layout: LoopNetworkLayout) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(store.networkDirectory.map(store.directoryName) ?? "Network")
                .font(LoopLook.font(40, .medium)).loopTracking(-0.035, size: 40)
                .foregroundStyle(LoopLook.ink)
                .lineLimit(1).truncationMode(.middle)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle(layout))
                .font(LoopLook.font(15)).foregroundStyle(LoopLook.ink2)
                .lineLimit(1).truncationMode(.tail)
        }
        .padding(.top, 26)
    }

    /// "24 files · 31 connections across 4 directories".
    private func subtitle(_ layout: LoopNetworkLayout) -> String {
        guard store.hasLoaded else { return "Reading your library\u{2026}" }
        let files = layout.nodes.filter { $0.role == .file }.count
        let links = layout.lines.filter { $0.kind != "member" }.count
        let hubs = layout.nodes.filter { $0.role == .hub }.count
        var line = "\(files) file\(files == 1 ? "" : "s") \u{00B7} \(links) connection\(links == 1 ? "" : "s")"
        if store.networkDirectory != nil {
            line += hubs > 1 ? " with \(hubs - 1) other director\(hubs == 2 ? "y" : "ies")" : " within this directory"
        } else if hubs > 0 {
            line += " across \(hubs) director\(hubs == 1 ? "y" : "ies")"
        }
        return line
    }

    private var controls: some View {
        HStack(spacing: 10) {
            // Retraces clicks into directories, one at a time, back to every directory.
            Button { focusNetwork(); store.networkBack() } label: {
                Label("Back", systemImage: "chevron.left")
            }
            .buttonStyle(LoopRoundButtonStyle())
            .keyboardShortcut("[", modifiers: .command)
            .disabled(!store.canGoBackInNetwork)
            .opacity(store.canGoBackInNetwork ? 1 : 0.4)
            .help("Back (\u{2318}[)")
            .accessibilityLabel("Back")
            directoryMenu
            Button { withAnimation(LoopLook.spring) { resetView() } } label: {
                Label("Fit to Window", systemImage: "arrow.up.left.and.arrow.down.right")
            }
            .buttonStyle(LoopRoundButtonStyle())
            .help("Fit to Window")
            .accessibilityLabel("Fit to Window")
            Spacer(minLength: 8)
            Text("Hover a file or a line to see what connects them; click a file to open it")
                .font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3)
                .lineLimit(1).truncationMode(.tail)
        }
        .padding(.top, 22)
    }

    /// Every directory, or one and what it connects to, from one capsule.
    private var directoryMenu: some View {
        let chosen = store.directory(store.networkDirectory)
        return Menu {
            Picker("Show", selection: $store.networkDirectory) {
                Text("All directories").tag(String?.none)
                Divider()
                ForEach(store.orderedDirectories) { Text($0.name).tag(Optional($0.id)) }
            }
            .pickerStyle(.inline)
        } label: {
            LoopHover { hovering in
                HStack(spacing: 8) {
                    LoopLucideIcon(icon: .folder, size: 14, color: chosen?.color ?? LoopLook.ink2)
                    Text(chosen?.name ?? "All directories").lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9.5, weight: .bold)).foregroundStyle(LoopLook.ink3)
                }
                .font(LoopLook.font(13, .medium))
                .foregroundStyle(LoopLook.ink)
                .padding(.horizontal, 15)
                .frame(height: 36)
                .background(Capsule().fill(hovering ? LoopLook.raise : LoopLook.panel))
                .overlay(Capsule().strokeBorder(chosen == nil ? LoopLook.line2 : LoopLook.sky.opacity(0.55), lineWidth: 1))
                .contentShape(Capsule())
            }
        }
        .modifier(LoopPlainMenuStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Show every directory, or one and what it connects to")
    }

    // MARK: The network

    private func canvas(_ layout: LoopNetworkLayout, size: CGSize) -> some View {
        let place = placement(size: size)
        // Hovering lights a file and what it connects to; typing in the search
        // field lights the files whose names match.
        let query = store.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let found = query.isEmpty ? nil : Set(layout.nodes.indices.filter { layout.nodes[$0].role == .hub
            || layout.nodes[$0].label.localizedCaseInsensitiveContains(query) })
        let hovered = layout.index(of: hoveredID)
        let pair = hoveredPair.flatMap { pair in layout.index(of: pair.one).flatMap { one in layout.index(of: pair.two).map { (one, $0) } } }
        let hubs = layout.nodes.filter { $0.role == .hub }
        let scene = LoopNetworkScene(
            layout: layout, place: place, zoom: zoom, pan: pan, hovered: hovered, hoveredPair: pair,
            selected: layout.index(of: store.selectedSourceID),
            lit: hovered.map { layout.neighbours(of: $0).union([$0]) } ?? pair.map { [$0.0, $0.1] } ?? found,
            labelled: layout.labelledFiles(limit: 10),
            colors: Dictionary(hubs.map { ($0.directoryId, store.directory($0.directoryId)?.color ?? LoopLook.ink2) },
                               uniquingKeysWith: { first, _ in first }))
        return Canvas { context, canvasSize in
            scene.draw(in: &context, size: canvasSize)
        } symbols: {
            ForEach(hubs, id: \.id) { hub in
                LoopNetworkHubGlyph(directory: store.directory(hub.directoryId), color: scene.colors[hub.directoryId] ?? LoopLook.ink2)
                    .tag(hub.directoryId)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Network of \(layout.nodes.filter { $0.role == .file }.count) files in \(hubs.count) directories")
        .accessibilityValue(layout.nodes.indices.filter { layout.labelledFiles(limit: 5).contains($0) }
            .map { layout.nodes[$0].label }.joined(separator: ", "))
        .onContinuousHover { phase in
            switch phase {
            case .active(let point):
                let next = hit(layout, at: point, place: place).map { layout.nodes[$0].id }
                if next != hoveredID { hoveredID = next }
                let line = next == nil ? lineHit(layout, at: point, place: place) : nil
                if line != hoveredPair { hoveredPair = line }
            case .ended:
                hoveredID = nil
                hoveredPair = nil
            }
        }
        .gesture(SpatialTapGesture().onEnded { value in
            focusNetwork()
            guard let index = hit(layout, at: value.location, place: place) else { store.selectedSourceID = nil; return }
            let node = layout.nodes[index]
            if node.role == .file { store.selectedSourceID = node.id } else { store.networkDirectory = node.directoryId }
        })
        .gesture(MagnificationGesture()
            .onChanged { zoom = min(4, max(0.5, settledZoom * $0)) }
            .onEnded { _ in settledZoom = zoom; focusNetwork() })
        .simultaneousGesture(DragGesture(minimumDistance: 4)
            .onChanged { pan = CGSize(width: settledPan.width + $0.translation.width, height: settledPan.height + $0.translation.height) }
            .onEnded { _ in settledPan = pan; focusNetwork() })
    }

    /// From the layout's -1...1 square to the whole panel, so a wide window spreads the network out.
    private func placement(size: CGSize) -> (CGPoint) -> CGPoint {
        let padding = LoopNetworkScene.padding
        let width = max(1, size.width - padding * 2) / 2 * zoom
        let height = max(1, size.height - padding * 2.6) / 2 * zoom
        let center = CGPoint(x: size.width / 2 + pan.width, y: (size.height - padding * 0.6) / 2 + pan.height)
        return { point in CGPoint(x: center.x + point.x * width, y: center.y + point.y * height) }
    }

    private func hit(_ layout: LoopNetworkLayout, at point: CGPoint, place: (CGPoint) -> CGPoint) -> Int? {
        layout.nodes.indices.min { left, right in
            distance(place(layout.nodes[left].position), point) < distance(place(layout.nodes[right].position), point)
        }.flatMap { index in
            let reach = LoopNetworkScene.radius(of: layout.nodes[index], zoom: zoom) + 6
            return distance(place(layout.nodes[index].position), point) <= reach ? index : nil
        }
    }

    private func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

    /// The connection under the pointer, nearest first, as the pair of files it joins.
    private func lineHit(_ layout: LoopNetworkLayout, at point: CGPoint, place: (CGPoint) -> CGPoint) -> LoopNetworkPair? {
        var best: (line: LoopNetworkLine, distance: CGFloat)?
        for line in layout.lines where line.kind != "member" {
            let from = place(layout.nodes[line.from].position), to = place(layout.nodes[line.to].position)
            // Lines whose box is far from the pointer are skipped before the curve is measured.
            let box = CGRect(x: min(from.x, to.x), y: min(from.y, to.y), width: abs(to.x - from.x), height: abs(to.y - from.y))
            guard box.insetBy(dx: -Self.lineReach * 6, dy: -Self.lineReach * 6).contains(point) else { continue }
            let gap = LoopNetworkScene.distance(from: point, toCurveFrom: from, to: to)
            if gap <= Self.lineReach, gap < (best?.distance ?? .greatestFiniteMagnitude) { best = (line, gap) }
        }
        return best.map { LoopNetworkPair(layout.nodes[$0.line.from].id, layout.nodes[$0.line.to].id) }
    }

    /// How near a line, in points, the pointer counts as on it.
    private static let lineReach: CGFloat = 5

    private func resetView() {
        zoom = 1; settledZoom = 1; pan = .zero; settledPan = .zero
    }

    // MARK: Undo

    /// Every directory, at the size that fits the window.
    private var showsWholeNetwork: Bool {
        store.networkDirectory == nil && settledZoom == 1 && settledPan == .zero
    }

    /// What the network shows, and from where.
    private var viewpoint: String {
        "\(store.networkDirectory ?? "")|\(settledZoom)|\(settledPan.width),\(settledPan.height)"
    }

    /// One offer at a time, named for what is on screen now, as the Edit menu shows it.
    private func offerWholeNetwork() {
        forgetWholeNetwork()
        store.undoManager.registerUndo(withTarget: store.networkUndoTarget) { _ in
            store.networkDirectory = nil
            resetView()
        }
        store.undoManager.setActionName(store.networkDirectory.map { "Show \(store.directoryName($0))" }
                                   ?? (settledZoom == 1 ? "Move" : "Zoom"))
    }

    /// Back at the whole network, or out of sight: ⌘Z has nothing here to undo.
    private func forgetWholeNetwork() {
        store.undoManager.removeAllActions(withTarget: store.networkUndoTarget)
    }

    /// A click, pinch or drag on the network takes focus from the search
    /// field, whose own typing would otherwise take ⌘Z.
    private func focusNetwork() {
        NSApp.keyWindow?.makeFirstResponder(nil)
    }

    // MARK: Footer

    @ViewBuilder
    private func footer(_ layout: LoopNetworkLayout) -> some View {
        HStack(alignment: .bottom, spacing: 12) {
            if let hovered = layout.index(of: hoveredID) {
                card(layout, hovered)
            } else if let pair = hoveredPair, let one = layout.index(of: pair.one), let two = layout.index(of: pair.two),
                      let connection = layout.connection(between: one, and: two) {
                LoopNetworkConnectionCard(layout: layout, one: one, connection: connection)
            } else if layout.isStarter {
                Text("Nothing has been used or linked yet, so these are recently edited files. They turn lime as you Tab, open, view and share them.")
                    .font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 320, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .loopNetworkNote()
            }
            Spacer(minLength: 0)
            LoopNetworkLegend()
        }
        .padding(16)
        .animation(.easeOut(duration: 0.15), value: hoveredID)
        .animation(.easeOut(duration: 0.15), value: hoveredPair)
    }

    /// What the pointer is on, in a note at the panel's corner: a file with
    /// what it connects to and why, or a directory.
    private func card(_ layout: LoopNetworkLayout, _ index: Int) -> some View {
        let node = layout.nodes[index]
        return HStack(alignment: .top, spacing: 11) {
            if node.role == .file, let source = store.source(node.id) {
                LoopFileIcon(url: nil, fileExtension: source.fileExtension, size: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text(node.label).font(LoopLook.font(14, .medium)).foregroundStyle(LoopLook.ink).lineLimit(1)
                    Text(store.directoryName(source.directoryId) + (source.folder.isEmpty ? "" : " \u{203A} " + source.folder))
                        .font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3).lineLimit(1).truncationMode(.middle)
                    Text(source.counts.summary).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink2).lineLimit(1)
                    LoopNetworkConnectionList(layout: layout, connections: layout.connections(of: index))
                }
            } else {
                LoopNetworkHubGlyph(directory: store.directory(node.directoryId),
                                     color: store.directory(node.directoryId)?.color ?? LoopLook.ink2)
                    .frame(width: 26, height: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text(node.label).font(LoopLook.font(14, .medium)).foregroundStyle(LoopLook.ink).lineLimit(1)
                    Text("Click to show only this directory and what it connects to.")
                        .font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink3).lineLimit(1)
                }
            }
        }
        .frame(maxWidth: 400, alignment: .leading)
        .padding(.horizontal, 14).padding(.vertical, 11)
        .loopNetworkNote()
        .transition(.opacity.combined(with: .offset(y: 6)))
    }
}

/// Two files a line joins, by id, kept across redraws as a hovered node is.
struct LoopNetworkPair: Equatable {
    let one: String
    let two: String
    init(_ one: String, _ two: String) { self.one = one; self.two = two }
}

/// A hovered line: the two files, whether the connection stays in one
/// directory or crosses two, and each reason it exists.
struct LoopNetworkConnectionCard: View {
    let layout: LoopNetworkLayout
    let one: Int
    let connection: LoopNetworkConnection

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(layout.nodes[one].label).lineLimit(1).truncationMode(.middle)
                Image(systemName: "arrow.left.and.right").font(.system(size: 10.5, weight: .bold))
                    .foregroundStyle(LoopLook.ink3)
                Text(layout.nodes[connection.other].label).lineLimit(1).truncationMode(.middle)
            }
            .font(LoopLook.font(14, .medium)).foregroundStyle(LoopLook.ink)
            LoopNetworkScopeLine(crosses: connection.crossesDirectories,
                                  words: layout.whereConnected(one, connection.other))
            VStack(alignment: .leading, spacing: 4) {
                ForEach(connection.sentences, id: \.self) { sentence in
                    Text(sentence).font(LoopLook.font(12.5)).foregroundStyle(LoopLook.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: 400, alignment: .leading)
        .padding(.horizontal, 14).padding(.vertical, 11)
        .loopNetworkNote()
        .transition(.opacity.combined(with: .offset(y: 6)))
        .accessibilityElement(children: .combine)
    }
}

/// Under a hovered file, the files it connects to, each with why.
struct LoopNetworkConnectionList: View {
    let layout: LoopNetworkLayout
    let connections: [LoopNetworkConnection]
    private static let shown = 4

    var body: some View {
        if !connections.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(connections.prefix(Self.shown), id: \.other) { connection in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Circle().fill(connection.crossesDirectories ? LoopLook.sky : LoopLook.ink3)
                            .frame(width: 6, height: 6)
                        Text(layout.nodes[connection.other].label).foregroundStyle(LoopLook.ink)
                            .lineLimit(1).truncationMode(.middle)
                        Text(connection.tag).foregroundStyle(LoopLook.ink3).lineLimit(1)
                        if connection.crossesDirectories, let name = layout.directoryName(of: connection.other) {
                            Text("in \(name)").foregroundStyle(LoopLook.sky.opacity(0.85)).lineLimit(1)
                        }
                    }
                }
                if connections.count > Self.shown {
                    Text("and \(connections.count - Self.shown) more").foregroundStyle(LoopLook.ink3)
                }
            }
            .font(LoopLook.font(12.5))
            .padding(.top, 6)
        }
    }
}

/// "Across Finance and Models" in blue, or "Within Finance".
private struct LoopNetworkScopeLine: View {
    let crosses: Bool
    let words: String

    var body: some View {
        HStack(spacing: 7) {
            Capsule().fill(crosses ? LoopLook.sky : LoopLook.ink3).frame(width: 14, height: 2)
            Text(words).lineLimit(1)
        }
        .font(LoopLook.font(12.5, .medium))
        .foregroundStyle(crosses ? LoopLook.sky : LoopLook.ink3)
    }
}

/// Grey to lime, from files nobody has used to the busiest, and what a blue line means.
private struct LoopNetworkLegend: View {
    var body: some View {
        HStack(spacing: 14) {
            HStack(spacing: 8) {
                Text("Less used")
                Capsule()
                    .fill(LinearGradient(colors: [0.0, 0.25, 0.5, 0.75, 1.0].map(LoopNetworkScene.fill(activity:)),
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: 72, height: 6)
                Text("More used")
            }
            LoopLook.line.frame(width: 1, height: 14)
            HStack(spacing: 7) {
                Capsule().fill(LoopLook.sky).frame(width: 16, height: 2)
                Text("Across directories")
            }
        }
        .font(LoopLook.font(12)).foregroundStyle(LoopLook.ink3)
        .padding(.horizontal, 14)
        .frame(height: 34)
        .loopNetworkNote(capsule: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Grey for files not used yet, through to lime for the most used. Blue lines connect files in different directories.")
    }
}

/// A directory's mark in its own colour: a folder, or a connected app's own symbol.
struct LoopNetworkHubGlyph: View {
    let directory: LoopDirectory?
    let color: Color

    var body: some View {
        if let directory, directory.isApp {
            Image(systemName: directory.sidebarSymbol).font(.system(size: 13, weight: .medium)).foregroundStyle(color)
        } else {
            LoopLucideIcon(icon: .folder, size: 15, color: color)
        }
    }
}

extension View {
    /// A note floating on the network's panel: raised, edged, and soft-shadowed.
    func loopNetworkNote(capsule: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: capsule ? 17 : 14, style: .continuous)
        return background(shape.fill(LoopLook.raise.opacity(0.94)))
            .overlay(shape.strokeBorder(LoopLook.line, lineWidth: 1))
            .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
    }
}
