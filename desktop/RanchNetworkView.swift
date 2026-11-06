// The Ranch's Network: directories as hubs, their busiest files around
// them, and lines where files connect, in one directory or across several.
// Files fade from grey (unused) to green (most tabbed, opened, viewed,
// shared or linked). Hovering a file lights up what it connects to;
// clicking one shows it on the right.

import Cocoa
import SwiftUI

/// The network across the whole window, with the chosen file beside it.
struct RanchNetworkPane: View {
    @ObservedObject var store: RanchStore
    let actions: RanchActions
    private static let previewWidth: CGFloat = 460

    var body: some View {
        HStack(spacing: 0) {
            RanchNetworkView(store: store)
            if let source = store.source(store.selectedSourceID) {
                RanchHairline(vertical: true)
                RanchSourceDetail(store: store, source: source, actions: actions)
                    .id(source.id + (source.contentHash ?? ""))
                    .frame(width: Self.previewWidth)
            }
        }
    }
}

struct RanchNetworkView: View {
    @ObservedObject var store: RanchStore
    /// By id, not place: a click that narrows the network, or the refresh
    /// after a visit, redraws it under a resting pointer, and an old index
    /// would point at another node or past the end.
    @State private var hoveredID: String?
    @State private var zoom: CGFloat = 1
    @State private var settledZoom: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var settledPan: CGSize = .zero

    private static let padding: CGFloat = 48

    var body: some View {
        let layout = store.networkLayout()
        VStack(spacing: 0) {
            RanchColumnHeader(title: "Network", subtitle: subtitle(layout))
            RanchFilterBar {
                // Retraces clicks into directories, one at a time, back to every directory.
                Button { focusNetwork(); store.networkBack() } label: {
                    Label("Back", systemImage: "chevron.left")
                }
                .buttonStyle(RanchPillButtonStyle())
                .keyboardShortcut("[", modifiers: .command)
                .disabled(!store.canGoBackInNetwork)
                .help("Back (\u{2318}[)")
                RanchPillMenu(title: store.networkDirectory.map(store.directoryName) ?? "All Directories", symbol: "folder",
                              help: "Show every directory, or one and what it connects to") {
                    Picker("Show", selection: $store.networkDirectory) {
                        Text("All Directories").tag(String?.none)
                        Divider()
                        ForEach(store.orderedDirectories) { Text($0.name).tag(Optional($0.id)) }
                    }
                    .pickerStyle(.inline)
                }
                Button { resetView() } label: {
                    Label("Fit to Window", systemImage: "arrow.up.left.and.down.right.magnifyingglass")
                }
                .buttonStyle(RanchPillButtonStyle())
                .help("Fit to Window")
            }
            if layout.nodes.isEmpty {
                RanchEmptyState(symbol: "point.3.connected.trianglepath.dotted", title: "Nothing to Connect Yet",
                                message: "Add a work directory and its files appear here.")
            } else {
                GeometryReader { geometry in
                    ZStack(alignment: .bottom) {
                        canvas(layout, size: geometry.size)
                        footer(layout)
                    }
                }
            }
        }
        .background(RanchTheme.surface)
        .onChange(of: store.networkDirectory) { _ in resetView() }
        // ⌘Z (Edit > Undo) brings back the whole network in one step, however
        // far a click narrowed it or a pinch or drag moved it.
        .onChange(of: viewpoint) { _ in
            if showsWholeNetwork { forgetWholeNetwork() } else { offerWholeNetwork() }
        }
        .onAppear { if !showsWholeNetwork { offerWholeNetwork() } }
        .onDisappear { forgetWholeNetwork() }
    }

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

    private func subtitle(_ layout: RanchNetworkLayout) -> String {
        let files = layout.nodes.filter { $0.role == .file }.count
        let links = layout.lines.filter { $0.kind != "member" }.count
        return "\(files) file\(files == 1 ? "" : "s") \u{00B7} \(links) connection\(links == 1 ? "" : "s")"
    }

    // MARK: Drawing

    private func canvas(_ layout: RanchNetworkLayout, size: CGSize) -> some View {
        let place = placement(size: size)
        // Hovering lights a file and what it connects to; typing in the search
        // field lights the files whose names match.
        let query = store.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let found = query.isEmpty ? nil : Set(layout.nodes.indices.filter { layout.nodes[$0].role == .hub
            || layout.nodes[$0].label.localizedCaseInsensitiveContains(query) })
        let hovered = layout.index(of: hoveredID)
        let lit = hovered.map { layout.neighbours(of: $0).union([$0]) } ?? found
        let labelled = layout.labelledFiles(limit: 10)
        let selected = layout.index(of: store.selectedSourceID)
        return Canvas { context, canvasSize in
            for line in layout.lines {
                let from = place(layout.nodes[line.from].position), to = place(layout.nodes[line.to].position)
                let isLit = lit.map { $0.contains(line.from) && $0.contains(line.to) } ?? true
                var path = Path()
                path.move(to: from)
                if line.kind == "member" {
                    path.addLine(to: to)
                    context.stroke(path, with: .color(.secondary.opacity(isLit ? 0.14 : 0.05)), lineWidth: 0.75)
                } else {
                    // A gentle curve keeps crossing lines apart.
                    let middle = CGPoint(x: (from.x + to.x) / 2, y: (from.y + to.y) / 2)
                    let bend = CGPoint(x: middle.x - (to.y - from.y) * 0.12, y: middle.y + (to.x - from.x) * 0.12)
                    path.addQuadCurve(to: to, control: bend)
                    let color: Color = line.crossesDirectories ? .accentColor : .secondary
                    let opacity = isLit ? (hovered == nil ? 0.32 : 0.75) : 0.06
                    let style = StrokeStyle(lineWidth: 0.8 + 0.5 * min(3, line.weight), lineCap: .round,
                                            dash: line.kind == "same-name" ? [3, 3] : [])
                    context.stroke(path, with: .color(color.opacity(opacity)), style: style)
                }
            }
            for (index, node) in layout.nodes.enumerated() {
                let center = place(node.position)
                let radius = node.radius * min(1.6, max(0.8, zoom))
                let rect = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
                context.opacity = lit.map { $0.contains(index) ? 1 : 0.25 } ?? 1
                let fill = Color(nsColor: RanchActivityColor.color(for: node.activity))
                if node.role == .hub {
                    context.fill(Path(ellipseIn: rect), with: .color(RanchTheme.surface))
                    context.stroke(Path(ellipseIn: rect), with: .color(fill), lineWidth: 3)
                    // Grey, as in the sidebar: the folder colour is kept for the suggestion card and highlights.
                    let directory = store.directory(node.directoryId)
                    var glyph = context.resolve(Image(systemName: directory?.sidebarSymbol ?? "folder"))
                    glyph.shading = .color(RanchTheme.secondaryInk)
                    context.draw(glyph, at: center)
                } else {
                    context.fill(Path(ellipseIn: rect), with: .color(fill))
                    context.stroke(Path(ellipseIn: rect), with: .color(RanchTheme.surface), lineWidth: 1)
                    if index == selected {
                        context.stroke(Path(ellipseIn: rect.insetBy(dx: -3.5, dy: -3.5)), with: .color(RanchTheme.ink), lineWidth: 1.75)
                    }
                }
            }
            context.opacity = 1
            // Labels go on in order of importance and are left off where they
            // would cover one already drawn, so the picture never turns to mush.
            let order = [hovered, selected].compactMap { $0 }
                + layout.nodes.indices.filter { layout.nodes[$0].role == .hub }
                + layout.nodes.indices.filter { labelled.contains($0) }.sorted { layout.nodes[$0].activity > layout.nodes[$1].activity }
            // Hubs, and the file in focus, keep their own space clear.
            var taken: [CGRect] = layout.nodes.indices.filter { index in
                layout.nodes[index].role == .hub || index == hovered || index == selected
            }.map { index in
                let center = place(layout.nodes[index].position)
                let radius = layout.nodes[index].radius * min(1.6, max(0.8, zoom))
                return CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
            }
            var seen = Set<Int>()
            for index in order where seen.insert(index).inserted {
                let node = layout.nodes[index]
                let center = place(node.position)
                let radius = node.radius * min(1.6, max(0.8, zoom))
                let text = context.resolve(Text(node.label).font(node.role == .hub ? .caption.weight(.semibold) : .caption2)
                    .foregroundColor(node.role == .hub || index == hovered ? .primary : .secondary))
                let size = text.measure(in: CGSize(width: 220, height: 40))
                // Kept inside the view, so a name near the edge is never cut off.
                let x = min(max(4, center.x - size.width / 2), max(4, canvasSize.width - size.width - 4))
                let frame = CGRect(x: x, y: center.y + radius + 4, width: size.width, height: size.height)
                let important = index == hovered || index == selected
                if !important && taken.contains(where: { $0.insetBy(dx: -4, dy: -1).intersects(frame) }) { continue }
                if let lit, !lit.contains(index) { continue }
                taken.append(frame)
                context.draw(text, in: frame)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Network of \(layout.nodes.filter { $0.role == .file }.count) files in \(layout.nodes.filter { $0.role == .hub }.count) directories")
        .accessibilityValue(layout.nodes.indices.filter { layout.labelledFiles(limit: 5).contains($0) }
            .map { layout.nodes[$0].label }.joined(separator: ", "))
        .onContinuousHover { phase in
            switch phase {
            case .active(let point): hoveredID = hit(layout, at: point, place: place).map { layout.nodes[$0].id }
            case .ended: hoveredID = nil
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

    /// From the layout's -1...1 square to the whole view, so a wide window spreads the network out.
    private func placement(size: CGSize) -> (CGPoint) -> CGPoint {
        let width = max(1, size.width - Self.padding * 2) / 2 * zoom
        let height = max(1, size.height - Self.padding * 2.6) / 2 * zoom
        let center = CGPoint(x: size.width / 2 + pan.width, y: (size.height - Self.padding * 0.6) / 2 + pan.height)
        return { point in CGPoint(x: center.x + point.x * width, y: center.y + point.y * height) }
    }

    private func hit(_ layout: RanchNetworkLayout, at point: CGPoint, place: (CGPoint) -> CGPoint) -> Int? {
        layout.nodes.indices.min { left, right in
            distance(place(layout.nodes[left].position), point) < distance(place(layout.nodes[right].position), point)
        }.flatMap { index in
            distance(place(layout.nodes[index].position), point) <= layout.nodes[index].radius * max(1, zoom) + 6 ? index : nil
        }
    }

    private func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

    private func resetView() {
        zoom = 1; settledZoom = 1; pan = .zero; settledPan = .zero
    }

    // MARK: Footer

    @ViewBuilder
    private func footer(_ layout: RanchNetworkLayout) -> some View {
        HStack(alignment: .bottom) {
            if let hovered = layout.index(of: hoveredID) {
                card(layout.nodes[hovered])
            } else if layout.isStarter {
                Text("Nothing has been used or linked yet, so these are recently edited files. They turn green as you Tab, open, view and share them.")
                    .font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
                    .frame(maxWidth: 300, alignment: .leading)
                    .padding(10)
                    .background {
                        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
                        shape.fill(RanchTheme.control).overlay(shape.strokeBorder(RanchTheme.controlEdge, lineWidth: 1))
                    }
            }
            Spacer()
            legend
        }
        .padding(14)
    }

    /// What the pointer is on, as a dark note in the corner.
    private func card(_ node: RanchNetworkNode) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(node.label).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
            Group {
                if node.role == .file, let source = store.source(node.id) {
                    Text(store.directoryName(source.directoryId) + (source.folder.isEmpty ? "" : " \u{203A} " + source.folder))
                        .lineLimit(1)
                    Text(source.counts.summary).lineLimit(1)
                } else {
                    Text("Click to show only this directory and what it connects to.")
                }
            }
            .font(RanchTheme.captionFont)
            .foregroundStyle(RanchTheme.onTooltipSecondary)
        }
        .frame(maxWidth: 300, alignment: .leading)
        .ranchTooltip()
    }

    /// Grey to green, from files nobody has used to the busiest.
    private var legend: some View {
        HStack(spacing: 10) {
            Text("Use").font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
            VStack(spacing: 3) {
                Capsule()
                    .fill(LinearGradient(colors: [0.0, 0.25, 0.5, 0.75, 1.0].map { Color(nsColor: RanchActivityColor.color(for: $0)) },
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: 112, height: 6)
                HStack {
                    Text("Less used")
                    Spacer()
                    Text("More used")
                }
                .font(.system(size: 9.5))
                .foregroundStyle(RanchTheme.tertiaryInk)
                .frame(width: 112)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background {
            let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
            shape.fill(RanchTheme.control).overlay(shape.strokeBorder(RanchTheme.controlEdge, lineWidth: 1))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Grey for files not used yet, through to green for the most used")
    }
}
