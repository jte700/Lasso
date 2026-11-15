// What the status panel's add control says while chosen folders are added:
// how far the server has got reading them, then whether they are ready.
// The island in MorphIsland.swift draws it; this file only decides the words.

import Foundation

/// One state of the add control. Each kind has its own size and contents, so a
/// change of kind morphs the island; a change within a kind only updates words.
enum MorphIslandState: Equatable {
    /// The Add Work Directories button.
    case idle
    /// Lasso is reading the chosen folders. No percent until the server reports one.
    case adding(title: String, detail: String, percent: Int?)
    case done(title: String, detail: String)
    case failed(title: String)

    enum Kind { case idle, adding, done, failed }

    var kind: Kind {
        switch self {
        case .idle: return .idle
        case .adding: return .adding
        case .done: return .done
        case .failed: return .failed
        }
    }
}

/// A folder as the workspace lists it, with what the add control needs to know.
struct AddedFolderStatus {
    let name: String
    let rootPath: String
    let progress: DirectoryProgress?
    let fileCount: Int
    let needsAttention: Bool
}

/// The folders chosen in one Add Work Directories step, until the island has
/// shown how adding them went.
struct FolderAddition: Equatable {
    enum Outcome: Equatable { case running, succeeded, failed }

    let paths: [String]
    var outcome: Outcome = .running
    private let keys: Set<String>

    init(paths: [String]) {
        self.paths = paths
        keys = Set(paths.map(Self.key))
    }

    private static func key(_ path: String) -> String {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// Whether a listed folder is one of those chosen, so its row leaves the progress to the island.
    func includes(rootPath: String) -> Bool { keys.contains(Self.key(rootPath)) }

    /// The listed folder for each chosen path, nil while the server has not listed it yet.
    /// Paths are compared resolved, so a trailing slash or a symlink does not hide one.
    func matches(in folders: [AddedFolderStatus]) -> [AddedFolderStatus?] {
        let listed = Dictionary(folders.map { (Self.key($0.rootPath), $0) }, uniquingKeysWith: { first, _ in first })
        return paths.map { listed[Self.key($0)] }
    }

    func state(folders: [AddedFolderStatus]) -> MorphIslandState {
        let found = matches(in: folders)
        let names = zip(paths, found).map { path, folder in folder?.name ?? (path as NSString).lastPathComponent }
        let one = names.count == 1 ? names[0] : nil
        switch outcome {
        case .running:
            let title = one.map { "Adding \($0)" } ?? "Adding \(paths.count) folders"
            let reporting = found.compactMap { $0?.progress }
            guard let first = reporting.first else {
                return .adding(title: title, detail: DirectoryProgress(percent: 0, phase: "waiting", kind: "adding").activity,
                               percent: nil)
            }
            // A chosen folder that is listed but no longer reading is done; one not listed yet has not started.
            let total = found.reduce(0) { sum, folder in
                sum + (folder == nil ? 0 : folder?.progress?.percent ?? 100)
            }
            return .adding(title: title, detail: first.activity, percent: total / max(1, paths.count))
        case .succeeded:
            if let troubled = zip(names, found).first(where: { $0.1?.needsAttention == true }) {
                return .failed(title: "\(troubled.0) needs attention")
            }
            let files = found.reduce(0) { $0 + ($1?.fileCount ?? 0) }
            return .done(title: one.map { "\($0) is ready" } ?? "\(paths.count) folders are ready",
                         detail: Self.fileCountText(files))
        case .failed:
            return .failed(title: "Couldn\u{2019}t add " + (one ?? "\(paths.count) folders"))
        }
    }

    static func fileCountText(_ count: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        let number = formatter.string(from: NSNumber(value: count)) ?? String(count)
        return count == 1 ? "1 file" : "\(number) files"
    }
}
