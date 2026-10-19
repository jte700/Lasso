//  Finds the Node.js runtime that runs Lasso's local server.
//
//  Lasso.app carries its own Node.js, so the server starts on Macs without
//  Node installed. Installed copies remain a fallback for development and for
//  a bundle whose runtime is missing or damaged.

import Foundation

/// The bundled server uses `node:sqlite`, which needs Node.js 24 or newer.
let minimumNodeMajorVersion = 24

/// The first run of a freshly installed 100 MB Node can be slow while macOS
/// checks it, and timing out there would leave a Mac without Node stuck.
private let nodeVersionTimeout: TimeInterval = 30
/// A login shell with a slow or interactive profile must not stall startup.
private let loginShellTimeout: TimeInterval = 5

/// A Node.js binary new enough to run the server.
struct NodeRuntime: Equatable {
    let path: String
    let version: String
    let isBundled: Bool

    /// How About Lasso and the server log name the runtime.
    var summary: String {
        isBundled ? "Node.js \(version), bundled with Lasso" : "Node.js \(version) from \(path)"
    }
}

enum NodeResolution: Equatable {
    case found(NodeRuntime)
    case tooOld(path: String, version: String)
    case missing
}

/// GUI applications do not inherit a shell PATH, so the Node binary is resolved
/// explicitly: an env override, the copy inside Lasso.app, the path recorded at
/// build time, the usual install locations, any nvm install (newest first),
/// and finally a login shell lookup. Each candidate's version is checked, so
/// an old Node is reported as such instead of as a server that stopped.
func resolveNodeRuntime(bundledNode: String?, recordedNode: String,
                        environment: [String: String] = ProcessInfo.processInfo.environment) -> NodeResolution {
    let fileManager = FileManager.default
    let nvmRoot = fileManager.homeDirectoryForCurrentUser
        .appendingPathComponent(".nvm/versions/node", isDirectory: true).path
    let candidates = nodeCandidates(
        override: environment["LASSO_NODE"] ?? environment["COLAB_NODE"],
        bundledNode: bundledNode,
        recordedNode: recordedNode,
        nvmRoot: nvmRoot,
        nvmVersions: (try? fileManager.contentsOfDirectory(atPath: nvmRoot)) ?? [])
    return selectNodeRuntime(
        candidates: candidates,
        bundledNode: bundledNode,
        isExecutable: fileManager.isExecutableFile(atPath:),
        version: nodeVersion(at:),
        loginShellNode: nodePathFromLoginShell)
}

/// Every place Node may be, in the order they are tried.
func nodeCandidates(override: String?, bundledNode: String?, recordedNode: String,
                    nvmRoot: String, nvmVersions: [String]) -> [String] {
    // "v24.1.0" must sort above "v9.11.2", so compare numerically.
    let newestNvmFirst = nvmVersions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
    return [override, bundledNode, recordedNode].compactMap { $0 }
        + ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        + newestNvmFirst.map { "\(nvmRoot)/\($0)/bin/node" }
}

/// The first candidate new enough to run the server. The login shell is asked
/// only when no candidate is, because starting it can take seconds.
func selectNodeRuntime(candidates: [String], bundledNode: String?,
                       isExecutable: (String) -> Bool,
                       version: (String) -> String?,
                       loginShellNode: () -> String?) -> NodeResolution {
    var tooOld: (path: String, version: String)?
    var checked = Set<String>()
    func runtime(at path: String) -> NodeRuntime? {
        guard checked.insert(path).inserted, isExecutable(path), let found = version(path) else { return nil }
        if nodeMajorVersion(found) >= minimumNodeMajorVersion {
            return NodeRuntime(path: path, version: found, isBundled: path == bundledNode)
        }
        if tooOld == nil { tooOld = (path, found) }
        return nil
    }
    for candidate in candidates {
        if let found = runtime(at: candidate) { return .found(found) }
    }
    if let shellNode = loginShellNode(), let found = runtime(at: shellNode) { return .found(found) }
    if let tooOld { return .tooOld(path: tooOld.path, version: tooOld.version) }
    return .missing
}

func nodeMajorVersion(_ version: String) -> Int {
    let digits = version.trimmingCharacters(in: .whitespacesAndNewlines).drop(while: { $0 == "v" })
    return Int(digits.prefix(while: \.isNumber)) ?? 0
}

/// Output of a short command, or nil when it fails or takes too long.
private func commandOutput(_ executable: String, _ arguments: [String], timeout: TimeInterval) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
    } catch {
        return nil
    }
    let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    deadline.cancel()
    guard process.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func nodeVersion(at path: String) -> String? {
    commandOutput(path, ["--version"], timeout: nodeVersionTimeout).flatMap { $0.isEmpty ? nil : $0 }
}

private func nodePathFromLoginShell() -> String? {
    // An interactive login shell also reads .zshrc, where nvm, fnm and asdf
    // usually set up PATH.
    guard let output = commandOutput("/bin/zsh", ["-ilc", "command -v node"], timeout: loginShellTimeout),
          let path = output.split(separator: "\n").last.map(String.init),
          FileManager.default.isExecutableFile(atPath: path) else { return nil }
    return path
}
