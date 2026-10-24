// The Ranch's state: the library as the server last described it, what is
// selected, and how directories and files are ordered. It reads the server
// while the window is open and changes nothing in any file.

import Cocoa
import Combine

/// The indexed object a share link for a whole file pins.
struct RanchShareTarget: Equatable {
    let projectId: String
    let objectId: String
    let versionId: String?
    let label: String
    let path: String
}

final class RanchStore: ObservableObject {
    enum Section: Hashable {
        case changes, sources, links, review, network
        case directory(String)

        /// How the window remembers where it was left.
        var saved: String {
            switch self {
            case .changes: return "changes"
            case .sources: return "sources"
            case .links: return "links"
            case .review: return "review"
            case .network: return "network"
            case .directory(let id): return "directory:" + id
            }
        }

        init?(saved: String?) {
            switch saved {
            case "changes": self = .changes
            case "sources": self = .sources
            case "links": self = .links
            case "review": self = .review
            case "network": self = .network
            case let value? where value.hasPrefix("directory:") && value.count > 10:
                self = .directory(String(value.dropFirst(10)))
            default: return nil
            }
        }
    }

    enum LinkTab: String, CaseIterable, Identifiable {
        case outgoing, received
        var id: String { rawValue }
        var title: String { self == .outgoing ? "Shared by You" : "Received" }
    }

    @Published private(set) var overview = RanchOverview.empty {
        didSet {
            sourcesByID = Dictionary(overview.sources.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            sourcesByDirectory = Dictionary(grouping: overview.sources, by: \.directoryId)
            listCache.removeAll()
        }
    }
    private var sourcesByID: [String: RanchSource] = [:]
    private var sourcesByDirectory: [String: [RanchSource]] = [:]
    /// Each directory's files as listed: filtered, searched and sorted once per
    /// change, not on every redraw, which a large library would feel.
    private var listCache: [String: [RanchSource]] = [:]
    @Published private(set) var hasLoaded = false
    @Published private(set) var loadError: String?
    @Published var section: Section? = .sources {
        didSet {
            defaults.set(section?.saved, forKey: Self.sectionKey)
            // A new view starts with nothing chosen, as Mail does on another mailbox.
            if section != oldValue { selectedSourceID = nil; selectionNote = nil }
        }
    }
    @Published var selectedSourceID: String? {
        didSet {
            if let id = selectedSourceID, id != oldValue { recordVisit(id) }
            if selectedSourceID != nil { selectionNote = nil }
        }
    }
    /// What the right side says when the selected row has no file to show,
    /// such as a change that removed one.
    @Published var selectionNote: (title: String, message: String)?
    @Published var directoryOrder: RanchOrder {
        didSet { defaults.set(directoryOrder.rawValue, forKey: RanchOrder.directoryKey) }
    }
    @Published var itemOrder: RanchOrder {
        didSet { defaults.set(itemOrder.rawValue, forKey: RanchOrder.itemKey); listCache.removeAll() }
    }
    @Published var kindFilter: RanchKindFilter {
        didSet { defaults.set(kindFilter.rawValue, forKey: RanchKindFilter.key); listCache.removeAll() }
    }
    @Published var searchText = "" {
        didSet { listCache.removeAll() }
    }
    /// Something the person asked for that did not work, for an alert.
    @Published var actionError: String?
    @Published var linkTab = LinkTab.outgoing
    /// The network shows every directory, or one and what it connects to.
    @Published var networkDirectory: String?

    var serverURL: URL? {
        didSet { if serverURL != oldValue { etag = nil; reload() } }
    }
    /// The overview's tag from the server; a poll with it is answered "not modified".
    private var etag: String?
    private var reloadAgain = false

    private let defaults: UserDefaults
    private let session: URLSession
    private var refreshTimer: Timer?
    private var request: URLSessionDataTask?
    /// The window refreshes this often while it is open; the server answers
    /// from its cache when nothing changed.
    private static let refreshInterval: TimeInterval = 20
    private static let sectionKey = "RanchSection"
    private static let modelTimeout: TimeInterval = 120
    private static let cachedPreviews = 24
    private var previews: [String: AssistModelPreview] = [:]
    private var networkCache: (key: String, layout: RanchNetworkLayout)?
    /// The window's, so Edit > Undo (⌘Z) reaches what its views offer to undo.
    let undoManager = UndoManager()

    init(defaults: UserDefaults = .standard, session: URLSession = .shared) {
        self.defaults = defaults
        self.session = session
        directoryOrder = RanchOrder.saved(RanchOrder.directoryKey, defaults: defaults)
        itemOrder = RanchOrder.saved(RanchOrder.itemKey, defaults: defaults)
        kindFilter = defaults.string(forKey: RanchKindFilter.key).flatMap(RanchKindFilter.init(rawValue:)) ?? .all
        section = Section(saved: defaults.string(forKey: Self.sectionKey)) ?? .sources
    }

    // MARK: Loading

    func startRefreshing() {
        reload()
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: Self.refreshInterval, repeats: true) { [weak self] _ in
            self?.reload()
        }
    }

    func stopRefreshing() {
        refreshTimer?.invalidate()
        refreshTimer = nil
        request?.cancel()
        request = nil
    }

    func reload() {
        guard let serverURL else {
            loadError = "Lasso\u{2019}s server is starting. The Ranch will fill in as soon as it is ready."
            return
        }
        // A read already under way may predate what was just changed; read again after it.
        guard request == nil else { reloadAgain = true; return }
        var request = URLRequest(url: serverURL.appendingPathComponent("api/ranch"))
        if let etag, hasLoaded { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        let task = session.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            let tag = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Etag")
            let result: Result<RanchOverview?, Error>
            if status == 304 {
                result = .success(nil)
            } else if let data, status == 200 {
                // Decoded here, off the main thread; a large library takes a moment.
                result = Result { try RanchOverview.decode(data) }
            } else {
                result = .failure(NSError(domain: "LassoRanch", code: 1, userInfo: [NSLocalizedDescriptionKey:
                    WorkspaceAPI.errorMessage(data: data, response: response, error: error)]))
            }
            DispatchQueue.main.async { self?.apply(result, tag: tag) }
        }
        self.request = task
        task.resume()
    }

    private func apply(_ result: Result<RanchOverview?, Error>, tag: String?) {
        request = nil
        defer { if reloadAgain { reloadAgain = false; reload() } }
        switch result {
        case .success(nil):
            loadError = nil
        case .success(let next?):
            loadError = nil
            hasLoaded = true
            etag = tag
            if next != overview { overview = next }
            if let id = selectedSourceID, source(id) == nil { selectedSourceID = nil }
            // A directory removed since the window last showed it.
            if case .directory(let id) = section, directory(id) == nil { section = .sources }
            if let id = networkDirectory, directory(id) == nil { networkDirectory = nil }
        case .failure(let error):
            if (error as NSError).code == NSURLErrorCancelled { return }
            NSLog("The Ranch could not load the library: %@", error.localizedDescription)
            loadError = "The library couldn\u{2019}t be loaded. \(error.localizedDescription)"
        }
    }

    // MARK: What the window lists

    var folders: [RanchDirectory] { directoryOrder.sorted(overview.directories.filter { !$0.isApp }) }
    var apps: [RanchDirectory] { directoryOrder.sorted(overview.directories.filter(\.isApp)) }
    /// Folders, then connected apps, each in the chosen directory order.
    var orderedDirectories: [RanchDirectory] { folders + apps }

    func directory(_ id: String?) -> RanchDirectory? {
        guard let id else { return nil }
        return overview.directories.first { $0.id == id }
    }

    func source(_ id: String?) -> RanchSource? {
        guard let id else { return nil }
        return sourcesByID[id]
    }

    /// One directory's files in the file order, narrowed by the search field and the kind filter.
    func sources(in directoryId: String) -> [RanchSource] {
        if let listed = listCache[directoryId] { return listed }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let listed = itemOrder.sorted((sourcesByDirectory[directoryId] ?? []).filter { source in
            kindFilter.includes(source) && (query.isEmpty || source.path.localizedCaseInsensitiveContains(query))
        })
        listCache[directoryId] = listed
        return listed
    }

    func directoryName(_ id: String) -> String { directory(id)?.name ?? "Removed directory" }

    var reviewCount: Int { overview.review.count }
    var activeLinkCount: Int { overview.links.outgoing.filter { $0.status == "active" }.count }

    /// The network's layout, worked out again only when the library or the
    /// directory shown changes, not on every hover.
    func networkLayout() -> RanchNetworkLayout {
        let key = [overview.generatedAt.map { "\($0.timeIntervalSince1970)" } ?? "", networkDirectory ?? "",
                   "\(overview.sources.count)", "\(overview.network.edges.count)"].joined(separator: "|")
        if let cached = networkCache, cached.key == key { return cached.layout }
        let layout = RanchNetworkLayout.make(overview, directoryId: networkDirectory)
        networkCache = (key, layout)
        return layout
    }

    // MARK: Files on disk

    /// Where the file is on this Mac, or nil when its drive is disconnected.
    func localURL(for source: RanchSource) -> URL? {
        guard let directory = directory(source.directoryId), !directory.offline else { return nil }
        let url = URL(fileURLWithPath: directory.rootPath).appendingPathComponent(source.path)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// The file itself, or Lasso's saved copy when the original is out of reach.
    func resolveFile(_ source: RanchSource, completion: @escaping (Result<URL, Error>) -> Void) {
        if let local = localURL(for: source) { return completion(.success(local)) }
        guard let serverURL, let hash = source.contentHash,
              var components = URLComponents(url: serverURL.appendingPathComponent("api/ranch/file"),
                                             resolvingAgainstBaseURL: false) else {
            return completion(.failure(Self.failure("This file isn\u{2019}t on this Mac, and Lasso has no copy of it.")))
        }
        let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Lasso/Ranch/\(hash)", isDirectory: true)
        let copy = cache.appendingPathComponent(source.name)
        if FileManager.default.fileExists(atPath: copy.path) { return completion(.success(copy)) }
        components.queryItems = [URLQueryItem(name: "directory", value: source.directoryId),
                                 URLQueryItem(name: "path", value: source.path)]
        guard let url = components.url else { return completion(.failure(Self.failure("The file address is invalid."))) }
        session.dataTask(with: url) { data, response, error in
            let result: Result<URL, Error>
            if let data, (response as? HTTPURLResponse)?.statusCode == 200 {
                result = Result {
                    try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
                    try data.write(to: copy, options: .atomic)
                    return copy
                }
            } else {
                result = .failure(Self.failure(WorkspaceAPI.errorMessage(data: data, response: response, error: error)))
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    /// The model or drawing Lasso's reader recorded for a STEP, DXF or IFC
    /// file, kept by content so a file looked at twice is read once.
    func modelPreview(_ source: RanchSource, completion: @escaping (AssistModelPreview?) -> Void) {
        if let hash = source.contentHash, let cached = previews[hash] { return completion(cached) }
        guard let serverURL, let snapshot = directory(source.directoryId)?.snapshotId,
              var components = URLComponents(url: serverURL.appendingPathComponent("api/snapshots/\(snapshot)/preview"),
                                             resolvingAgainstBaseURL: false) else { return completion(nil) }
        components.queryItems = [URLQueryItem(name: "path", value: source.path)]
        guard let url = components.url else { return completion(nil) }
        var request = URLRequest(url: url)
        // A large model takes the reader a while; the viewer says it is reading.
        request.timeoutInterval = Self.modelTimeout
        session.dataTask(with: request) { [weak self] data, _, error in
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let model = (body?["preview"] as? [String: Any]).flatMap(AssistModelPreview.init(json:))
            if let error { NSLog("The Ranch could not read the model %@: %@", source.path, error.localizedDescription) }
            DispatchQueue.main.async {
                if let model, let hash = source.contentHash {
                    if self?.previews.count ?? 0 >= Self.cachedPreviews { self?.previews.removeAll() }
                    self?.previews[hash] = model
                }
                completion(model)
            }
        }.resume()
    }

    // MARK: Actions

    /// Tells the server a file was looked at; it counts once per half hour.
    private func recordVisit(_ id: String) {
        guard let serverURL, let source = source(id) else { return }
        var request = URLRequest(url: serverURL.appendingPathComponent("api/ranch/visits"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["directoryId": source.directoryId, "path": source.path])
        session.dataTask(with: request) { _, response, error in
            if let error { NSLog("The Ranch could not record a visit: %@", error.localizedDescription) }
            else if let status = (response as? HTTPURLResponse)?.statusCode, status != 200 {
                NSLog("The Ranch could not record a visit (HTTP %d)", status)
            }
        }.resume()
    }

    /// The indexed object a share link for the whole file would pin.
    func shareTarget(for source: RanchSource, completion: @escaping (Result<RanchShareTarget, Error>) -> Void) {
        guard let serverURL,
              var components = URLComponents(url: serverURL.appendingPathComponent("api/ranch/share-target"),
                                             resolvingAgainstBaseURL: false) else {
            return completion(.failure(Self.failure("Lasso\u{2019}s server isn\u{2019}t ready yet.")))
        }
        components.queryItems = [URLQueryItem(name: "directory", value: source.directoryId),
                                 URLQueryItem(name: "path", value: source.path)]
        guard let url = components.url else { return completion(.failure(Self.failure("The file address is invalid."))) }
        session.dataTask(with: url) { data, response, error in
            let target = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["target"] as? [String: Any]
            let result: Result<RanchShareTarget, Error>
            if let target, let projectId = target["projectId"] as? String, let objectId = target["objectId"] as? String {
                result = .success(RanchShareTarget(projectId: projectId, objectId: objectId,
                                                   versionId: target["versionId"] as? String,
                                                   label: target["label"] as? String ?? source.name, path: source.path))
            } else {
                result = .failure(Self.failure(WorkspaceAPI.errorMessage(data: data, response: response, error: error)))
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    func copy(_ link: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link, forType: .string)
    }

    /// Stops a share link working. The file and its history are unchanged.
    func stopSharing(_ link: RanchOutgoingLink) {
        guard let serverURL else { return }
        // Links made in the browser editor are kept apart from links to a source.
        var request = URLRequest(url: link.kind == "DEPENDENCY"
            ? serverURL.appendingPathComponent("api/dependency-shares/\(link.token)")
            : serverURL.appendingPathComponent("api/object-shares/\(link.token)/revoke"))
        request.httpMethod = link.kind == "DEPENDENCY" ? "DELETE" : "POST"
        request.timeoutInterval = 10
        session.dataTask(with: request) { [weak self] data, response, error in
            let stopped = (response as? HTTPURLResponse)?.statusCode == 200
            let message = stopped ? nil : WorkspaceAPI.errorMessage(data: data, response: response, error: error)
            DispatchQueue.main.async {
                if let message { self?.actionError = "The link couldn\u{2019}t be stopped. \(message)" }
                self?.reload()
            }
        }.resume()
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "LassoRanch", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
