// The review card's state and its conversation with Lasso's server: which
// folders have changes waiting, the chosen folder's review and the file open
// in it, and everything a person does there (comments, replies, suggestions
// applied, changes asked of the AI writer, files marked as looked at,
// approving). Each action answers with the file or review as it now stands.

import Foundation
import SwiftUI

final class RanchReviewModel: ObservableObject {
    @Published private(set) var folders: [RanchReviewFolder] = []
    /// Reviews asked for by name, newest first.
    @Published private(set) var requests: [RanchReviewRequest] = []
    /// The review asked for by name that is open, when one is: its files are in `chosenFolder`.
    @Published private(set) var chosenRequest: String?
    /// A new review being put together: who reviews, then its title, note and files.
    @Published var draft: RanchReviewDraft?
    @Published var chosenFolder: String? { didSet { if chosenFolder != oldValue { review = nil; files = [:]; chosenFile = nil; loadReview() } } }
    @Published private(set) var review: RanchReview?
    @Published var chosenFile: String? { didSet { if chosenFile != oldValue { loadFile() } } }
    /// The chosen folder's files read so far, by path.
    @Published private(set) var files: [String: RanchReviewFileView] = [:]
    @Published private(set) var approving = false
    /// Places the AI writer is working on, by RanchReviewModel.key.
    @Published private(set) var asking: Set<String> = []
    @Published var problem: String?
    /// A file someone chose to ask a change of, shown in its folder's review even before anything is said about it.
    @Published private(set) var requested: (folder: String, path: String)?
    /// The file whose comment box opens on its own, once its changes are read.
    @Published var composeFor: String?
    /// The line or cell a suggestion was just written to, which flashes once.
    @Published private(set) var flashed: String?

    var serverURL: URL? { didSet { if serverURL != oldValue { refresh() } } }
    /// Files waiting to be looked at across the folders, for the sidebar.
    var waiting: Int { folders.filter { $0.state == "open" }.reduce(0) { $0 + $1.files } }

    private let session: URLSession
    /// The AI writer can take a minute or two to make a change.
    private let patient: URLSession
    private var refreshing = false
    /// A refresh asked for while one was on its way, run when it lands.
    private var refreshAgain = false

    static let me: [String: String] = ["id": RanchReviewActor.meID, "displayName": "Desktop", "actorType": "HUMAN_SELF"]

    init(session: URLSession = .shared) {
        self.session = session
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 300
        configuration.timeoutIntervalForResource = 300
        patient = URLSession(configuration: configuration)
    }

    /// A place's key: the file, then the line, cell or passage.
    static func key(_ path: String, _ anchor: [String: Any]) -> String {
        let parts = ["thread", "line", "sheet", "row", "column", "place", "label"].compactMap { anchor[$0].map { "\($0)" } }
        return ([path, anchor["kind"] as? String ?? ""] + parts).joined(separator: "|")
    }

    // MARK: Reading

    /// Reads the folders again, then the chosen folder's review and its open file.
    func refresh() {
        guard serverURL != nil else { return }
        guard !refreshing else { refreshAgain = true; return }
        refreshing = true
        struct Envelope: Decodable {
            let folders: [RanchReviewFolder]
            var requests: [RanchReviewRequest]? = nil
        }
        request("api/reviews", decode: { data in
            try RanchOverview.decoder().decode(Envelope.self, from: data)
        }) { [weak self] result in
            guard let self else { return }
            refreshing = false
            defer { if refreshAgain { refreshAgain = false; refresh() } }
            guard case .success(let envelope) = result else { return }
            let folders = envelope.folders
            if folders != self.folders { self.folders = folders }
            let requests = envelope.requests ?? []
            if requests != self.requests { self.requests = requests }
            if let asked = chosenRequest, requests.contains(where: { $0.id == asked }) {
                loadReview()
            } else if chosenFolder == nil || !folders.contains(where: { $0.id == self.chosenFolder }) {
                chosenRequest = nil
                chosenFolder = folders.first { $0.state == "open" }?.id ?? folders.first?.id
            } else {
                // A review asked for that is gone leaves its folder's own review open.
                if chosenRequest != nil { chosenRequest = nil }
                loadReview()
            }
        }
    }

    private func loadReview() {
        guard let folder = chosenFolder else { return }
        let asked = chosenRequest
        let path = asked.map { "api/reviews/requests/\($0)" } ?? "api/reviews/\(folder)"
        request(path, decode: RanchReview.decode) { [weak self] result in
            guard let self, folder == self.chosenFolder, asked == self.chosenRequest, case .success(let review) = result else { return }
            take(review)
        }
    }

    /// Opens a folder's own review: the files edited since it was last approved.
    func choose(folder: String) {
        guard chosenRequest != nil || chosenFolder != folder else { return }
        chosenRequest = nil
        // In the same folder the card stays until the other review arrives, which keeps the open file if it has it.
        if chosenFolder == folder { loadReview() } else { chosenFolder = folder }
    }

    /// Opens a review asked for by name.
    func choose(request id: String) {
        guard let asked = requests.first(where: { $0.id == id }), chosenRequest != id else { return }
        chosenRequest = id
        if chosenFolder == asked.directoryId { loadReview() } else { chosenFolder = asked.directoryId }
    }

    /// Starts putting a new review together, in a folder and with a file in it when one was chosen.
    func startReview(folder: String?, path: String? = nil) {
        withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) {
            draft = RanchReviewDraft(folder: folder ?? chosenFolder ?? folders.first?.id, paths: path.map { [$0] } ?? [])
        }
    }

    /// Asks for the review the draft describes, then opens it.
    func createRequest(folder: String, title: String, note: String, paths: [String], reviewers: [RanchInvitee], done: @escaping (Bool) -> Void) {
        guard let serverURL else { return done(false) }
        var request = URLRequest(url: serverURL.appendingPathComponent("api/reviews/\(folder)/requests"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "title": title, "note": note, "paths": paths, "actor": Self.me,
            "reviewers": reviewers.map { ["email": $0.email, "name": $0.name] },
        ] as [String: Any])
        session.dataTask(with: request) { [weak self] data, response, error in
            let review = (response as? HTTPURLResponse)?.statusCode == 200 ? data.flatMap { try? RanchReview.decode($0) } : nil
            let message = review == nil ? WorkspaceAPI.errorMessage(data: data, response: response, error: error) : nil
            DispatchQueue.main.async {
                guard let self else { return }
                if let review, let id = review.requestId {
                    self.requests.insert(RanchReviewRequest(id: id, directoryId: review.directoryId, number: review.number ?? 0,
                                                            title: review.title ?? "", state: review.state, files: review.files.count,
                                                            reviewers: review.reviewers ?? []), at: 0)
                    withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { self.draft = nil }
                    self.choose(request: id)
                    self.refresh()
                } else if let message {
                    withAnimation(RanchLook.spring) { self.problem = message }
                }
                done(review != nil)
            }
        }.resume()
    }

    private func take(_ review: RanchReview) {
        withAnimation(RanchLook.spring) { self.review = review }
        if let asked = requested, asked.folder == review.directoryId, chosenFile == asked.path {
            loadFile()
        } else if chosenFile == nil || !review.files.contains(where: { $0.path == chosenFile }) {
            chosenFile = review.files.first { $0.openThreads > 0 }?.path ?? review.files.first?.path
        } else {
            loadFile()
        }
    }

    private func loadFile() {
        guard let folder = chosenFolder, let path = chosenFile else { return }
        request("api/reviews/\(folder)/file", query: [URLQueryItem(name: "path", value: path)], decode: RanchReviewFileView.decode) { [weak self] result in
            guard let self, folder == self.chosenFolder, case .success(let file) = result else { return }
            if files[path] != file { files[path] = file }
        }
    }

    /// The review's tabs: its files, and the file someone chose to ask a change of when it is not among them yet.
    func tabs(_ review: RanchReview) -> [RanchReview.File] {
        guard let asked = requested, asked.folder == review.directoryId, !review.files.contains(where: { $0.path == asked.path }) else {
            return review.files
        }
        return review.files + [RanchReview.File(path: asked.path, previousPath: nil, fileId: nil, fileType: nil, change: "unchanged",
                                                 kind: files[asked.path]?.kind ?? "file", viewed: false, comments: 0, openThreads: 0, editors: [])]
    }

    /// Opens a file in its folder's review with its comment box ready, to ask for a change to it.
    func request(folder: String, path: String) {
        requested = (folder, path)
        composeFor = path
        if chosenFolder != folder { chosenFolder = folder }
        chosenFile = path
        refresh()
    }

    // MARK: What a person does

    func comment(path: String, anchor: [String: Any], body: String, suggestion: [String: Any]?, done: @escaping (Bool) -> Void) {
        guard let folder = chosenFolder else { return done(false) }
        var payload: [String: Any] = ["path": path, "anchor": anchor, "body": body]
        if let suggestion { payload["suggestion"] = suggestion }
        post("api/reviews/\(folder)/threads", payload, done: done)
    }

    func reply(_ thread: RanchReviewThread, body: String, suggestion: [String: Any]?, done: @escaping (Bool) -> Void) {
        var payload: [String: Any] = ["body": body]
        if let suggestion { payload["suggestion"] = suggestion }
        post("api/reviews/threads/\(thread.id)/replies", payload, done: done)
    }

    func resolve(_ thread: RanchReviewThread, _ resolved: Bool) {
        post("api/reviews/threads/\(thread.id)/resolve", ["resolved": resolved]) { _ in }
    }

    func apply(_ thread: RanchReviewThread, done: @escaping (Bool) -> Void) {
        post("api/reviews/threads/\(thread.id)/apply", [:], done: done)
    }

    /// A backslash prompt: the AI writer makes the change at `anchor`, or at the thread's place.
    func ask(path: String, anchor: [String: Any], prompt: String, thread: RanchReviewThread? = nil, done: @escaping (Bool) -> Void) {
        guard let folder = chosenFolder else { return done(false) }
        let key = Self.key(path, anchor)
        withAnimation(RanchLook.spring) { _ = asking.insert(key) }
        var payload: [String: Any] = ["path": path, "anchor": anchor, "prompt": prompt]
        if let thread { payload["threadId"] = thread.id }
        post("api/reviews/\(folder)/ask", payload, session: patient) { [weak self] succeeded in
            withAnimation(RanchLook.spring) { _ = self?.asking.remove(key) }
            done(succeeded)
        }
    }

    func setViewed(_ file: RanchReview.File, _ viewed: Bool) {
        guard let folder = chosenFolder else { return }
        post("api/reviews/\(folder)/viewed", ["path": file.path, "viewed": viewed]) { _ in }
    }

    func approve() {
        guard let folder = chosenFolder, !approving else { return }
        withAnimation(RanchLook.spring) { approving = true }
        let path = chosenRequest.map { "api/reviews/requests/\($0)/approve" } ?? "api/reviews/\(folder)/approve"
        post(path, [:]) { [weak self] _ in
            withAnimation(RanchLook.spring) { self?.approving = false }
        }
    }

    func undo() {
        guard let folder = chosenFolder, let approval = review?.approval else { return }
        if let asked = chosenRequest { return post("api/reviews/requests/\(asked)/undo", [:]) { _ in } }
        post("api/reviews/\(folder)/undo", ["approvalId": approval.id]) { _ in }
    }

    /// The key a line or cell flashes under.
    static func flashKey(_ path: String, line: Int) -> String { "\(path)|line|\(line)" }
    static func flashKey(_ path: String, sheet: String?, row: Int, column: Int) -> String { "\(path)|cell|\(sheet ?? "")|\(row)|\(column)" }

    /// Flashes the place a thread's suggestion was just written to.
    func flash(_ thread: RanchReviewThread) {
        guard let position = thread.position else { return }
        let key: String
        if let line = position.line { key = Self.flashKey(thread.path, line: line) }
        else if let row = position.row, let column = position.column { key = Self.flashKey(thread.path, sheet: position.sheet, row: row, column: column) }
        else { return }
        flashed = key
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            withAnimation(.easeOut(duration: 1.1)) { if self?.flashed == key { self?.flashed = nil } }
        }
    }

    // MARK: Requests

    private func request<T>(_ path: String, query: [URLQueryItem] = [], decode: @escaping (Data) throws -> T,
                            completion: @escaping (Result<T, Error>) -> Void) {
        guard let serverURL, var components = URLComponents(url: serverURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            return completion(.failure(NSError(domain: "LassoReview", code: 2, userInfo: [NSLocalizedDescriptionKey: "Lasso\u{2019}s server isn\u{2019}t ready yet."])))
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else {
            return completion(.failure(NSError(domain: "LassoReview", code: 3, userInfo: [NSLocalizedDescriptionKey: "Lasso couldn\u{2019}t ask for this."])))
        }
        session.dataTask(with: url) { data, response, error in
            let result: Result<T, Error>
            if let data, (response as? HTTPURLResponse)?.statusCode == 200 {
                result = Result { try decode(data) }
            } else {
                result = .failure(NSError(domain: "LassoReview", code: 1, userInfo: [NSLocalizedDescriptionKey:
                    WorkspaceAPI.errorMessage(data: data, response: response, error: error)]))
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    /// Sends what the person did; the answer is the file or review as it now stands.
    private func post(_ path: String, _ body: [String: Any], session chosen: URLSession? = nil, done: @escaping (Bool) -> Void) {
        guard let serverURL else { return done(false) }
        var request = URLRequest(url: serverURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        var payload = body
        payload["actor"] = Self.me
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        (chosen ?? session).dataTask(with: request) { [weak self] data, response, error in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let message = ok ? nil : WorkspaceAPI.errorMessage(data: data, response: response, error: error)
            DispatchQueue.main.async {
                guard let self else { return }
                if let data, ok { self.absorb(data) }
                if let message { withAnimation(RanchLook.spring) { self.problem = message } }
                done(ok)
                if ok { self.refresh() }
            }
        }.resume()
    }

    /// Takes in a file or review an action answered with.
    private func absorb(_ data: Data) {
        if let file = try? RanchReviewFileView.decode(data) {
            withAnimation(RanchLook.spring) { files[file.path] = file }
        }
        if let review = try? RanchReview.decode(data), review.directoryId == chosenFolder, review.requestId == chosenRequest {
            withAnimation(RanchLook.spring) { self.review = review }
        }
    }
}

/// A new review being put together.
struct RanchReviewDraft: Equatable {
    var folder: String?
    var paths: [String]
}
