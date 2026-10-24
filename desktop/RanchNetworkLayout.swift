// Where The Ranch's network view puts things. Each directory is a hub; its
// files sit around it, pulled toward the files they connect to, in this
// directory or another. Only the busiest and best-connected files are drawn,
// so the picture stays readable. The layout is deterministic: the same
// library always draws the same way, so nodes do not jump between refreshes.

import Foundation
import CoreGraphics

struct RanchNetworkNode: Equatable {
    enum Role: Equatable { case hub, file }
    let id: String
    let role: Role
    let directoryId: String
    let label: String
    let activity: Double
    /// In a square from -1 to 1; the view scales it to fit.
    let position: CGPoint
    /// Before scaling, in points.
    let radius: CGFloat
}

struct RanchNetworkLine: Equatable {
    let from: Int
    let to: Int
    /// "member" ties a file to its directory; the rest are server edge kinds.
    let kind: String
    let weight: Double
    let crossesDirectories: Bool
}

struct RanchNetworkLayout: Equatable {
    let nodes: [RanchNetworkNode]
    let lines: [RanchNetworkLine]
    /// True when nothing has been used or connected yet, so the view shows
    /// recently edited files as a starting point and says why.
    let isStarter: Bool

    static let maxFiles = 80
    private static let starterFilesPerDirectory = 5
    private static let iterations = 220
    private static let hubRing: CGFloat = 0.70
    private static let hubRadius: CGFloat = 15
    private static let fileRadius: CGFloat = 4.5
    private static let fileRadiusGrowth: CGFloat = 6

    /// `directoryId` keeps one directory's files and the files elsewhere they connect to.
    static func make(_ overview: RanchOverview, directoryId: String? = nil, maxFiles: Int = maxFiles) -> RanchNetworkLayout {
        let sources = Dictionary(overview.sources.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let edges = overview.network.edges.filter { sources[$0.from] != nil && sources[$0.to] != nil }
        let local: (RanchSource) -> Bool = { directoryId == nil || $0.directoryId == directoryId }
        let relevant = edges.filter { edge in local(sources[edge.from]!) || local(sources[edge.to]!) }
        var degree: [String: Int] = [:]
        for edge in relevant { degree[edge.from, default: 0] += 1; degree[edge.to, default: 0] += 1 }

        let candidates = overview.sources.filter { source in
            (local(source) && source.activity > 0) || degree[source.id] != nil
        }
        let ranked = candidates.sorted { left, right in
            let l = left.activity + 0.15 * Double(degree[left.id] ?? 0)
            let r = right.activity + 0.15 * Double(degree[right.id] ?? 0)
            return l != r ? l > r : left.id < right.id
        }
        var chosen = Array(ranked.prefix(max(0, maxFiles)))
        let isStarter = chosen.isEmpty
        if isStarter {
            let byDirectory = Dictionary(grouping: overview.sources.filter(local), by: \.directoryId)
            chosen = byDirectory.keys.sorted().flatMap { key in
                RanchOrder.lastEdited.sorted(byDirectory[key]!).prefix(starterFilesPerDirectory)
            }
        }

        let directories = overview.directories.filter { directory in chosen.contains { $0.directoryId == directory.id } }
        let hubPositions = hubs(directories.map(\.id))
        var nodes = directories.enumerated().map { index, directory in
            RanchNetworkNode(id: "hub:" + directory.id, role: .hub, directoryId: directory.id, label: directory.name,
                             activity: directory.activity, position: hubPositions[index], radius: hubRadius)
        }
        let hubIndex = Dictionary(uniqueKeysWithValues: directories.enumerated().map { ($1.id, $0) })
        let fileStart = nodes.count
        for source in chosen {
            let hub = nodes[hubIndex[source.directoryId]!].position
            let angle = Double(stableHash(source.id) % 3600) / 3600 * 2 * .pi
            let ring = 0.12 + 0.08 * CGFloat(stableHash(source.id + "r") % 100) / 100
            nodes.append(RanchNetworkNode(
                id: source.id, role: .file, directoryId: source.directoryId, label: source.name, activity: source.activity,
                position: CGPoint(x: hub.x + ring * CGFloat(cos(angle)), y: hub.y + ring * CGFloat(sin(angle))),
                radius: fileRadius + fileRadiusGrowth * CGFloat(source.activity)))
        }
        let index = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($1.id, $0) })
        var lines = (fileStart..<nodes.count).map { file in
            RanchNetworkLine(from: hubIndex[nodes[file].directoryId]!, to: file, kind: "member", weight: 1, crossesDirectories: false)
        }
        for edge in relevant {
            guard let from = index[edge.from], let to = index[edge.to] else { continue }
            lines.append(RanchNetworkLine(from: from, to: to, kind: edge.kind, weight: edge.weight,
                                          crossesDirectories: nodes[from].directoryId != nodes[to].directoryId))
        }
        return RanchNetworkLayout(nodes: relax(nodes, lines: lines, hubCount: fileStart), lines: lines, isStarter: isStarter)
    }

    /// One hub sits in the middle; several sit on a ring, the first at the top.
    private static func hubs(_ ids: [String]) -> [CGPoint] {
        guard ids.count > 1 else { return ids.map { _ in .zero } }
        return ids.indices.map { index in
            let angle = 2 * Double.pi * Double(index) / Double(ids.count) - .pi / 2
            return CGPoint(x: hubRing * CGFloat(cos(angle)), y: hubRing * CGFloat(sin(angle)))
        }
    }

    /// Springs pull files toward their hub and the files they connect to;
    /// every node pushes the others away. Hubs stay where they are.
    private static func relax(_ nodes: [RanchNetworkNode], lines: [RanchNetworkLine], hubCount: Int) -> [RanchNetworkNode] {
        guard nodes.count > hubCount else { return nodes }
        var points = nodes.map(\.position)
        let crowd = CGFloat(max(1, nodes.count - hubCount))
        let spacing = 0.9 / sqrt(crowd + 8)
        for step in 0..<iterations {
            let heat = 0.06 * (1 - CGFloat(step) / CGFloat(iterations)) + 0.002
            var push = [CGVector](repeating: .zero, count: points.count)
            for a in hubCount..<points.count {
                for b in 0..<points.count where b != a {
                    let dx = points[a].x - points[b].x, dy = points[a].y - points[b].y
                    let distance = max(0.01, sqrt(dx * dx + dy * dy))
                    guard distance < spacing * 4 else { continue }
                    let force = spacing * spacing / (distance * distance) * 0.02
                    push[a].dx += dx / distance * force
                    push[a].dy += dy / distance * force
                }
            }
            for line in lines {
                let rest: CGFloat = line.kind == "member" ? spacing * 1.6 : spacing * 2.2
                let strength: CGFloat = line.kind == "member" ? 0.05 : 0.03 * CGFloat(min(3, line.weight))
                let dx = points[line.to].x - points[line.from].x, dy = points[line.to].y - points[line.from].y
                let distance = max(0.001, sqrt(dx * dx + dy * dy))
                let pull = (distance - rest) * strength
                if line.from >= hubCount { push[line.from].dx += dx / distance * pull; push[line.from].dy += dy / distance * pull }
                if line.to >= hubCount { push[line.to].dx -= dx / distance * pull; push[line.to].dy -= dy / distance * pull }
            }
            for node in hubCount..<points.count {
                let length = sqrt(push[node].dx * push[node].dx + push[node].dy * push[node].dy)
                let scale = length > heat ? heat / length : 1
                points[node].x = min(1, max(-1, points[node].x + push[node].dx * scale))
                points[node].y = min(1, max(-1, points[node].y + push[node].dy * scale))
            }
        }
        return nodes.enumerated().map { index, node in
            RanchNetworkNode(id: node.id, role: node.role, directoryId: node.directoryId, label: node.label,
                             activity: node.activity, position: points[index], radius: node.radius)
        }
    }

    /// FNV-1a, so a file keeps its place across launches (Swift's own hash is seeded).
    static func stableHash(_ value: String) -> UInt64 {
        value.utf8.reduce(UInt64(0xcbf29ce484222325)) { ($0 ^ UInt64($1)) &* 0x100000001b3 }
    }

    /// Which file labels to draw: hubs always, and only the few busiest files.
    func labelledFiles(limit: Int = 6) -> Set<Int> {
        let files = nodes.indices.filter { nodes[$0].role == .file && nodes[$0].activity > 0 }
        return Set(files.sorted { nodes[$0].activity > nodes[$1].activity }.prefix(limit))
    }

    func neighbours(of node: Int) -> Set<Int> {
        Set(lines.compactMap { line in
            line.from == node ? line.to : line.to == node ? line.from : nil
        })
    }
}
