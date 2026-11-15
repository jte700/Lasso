// Owns the passage picker: shows it in the suggestion card's own panel, which
// never takes the keyboard, loads the cited document from the server and
// hands back the words chosen. The card comes back when the picker closes.

import Cocoa

final class PassagePickerController {
    static let shared = PassagePickerController()

    private let view = PassagePickerView(frame: NSRect(origin: .zero, size: PassagePickerView.defaultSize))
    private let takeover = CardPanelTakeover()
    private var hostPanel: NSPanel? { takeover.panel }
    private var request: URLSessionDataTask?
    private var generation = 0
    private var active = false
    private var cancellation: (() -> Void)?
    private static let requestTimeout: TimeInterval = 30

    var isVisible: Bool { active && hostPanel?.isVisible == true }
    var canInsert: Bool { isVisible && view.canInsert }

    func isPresented(in panel: NSPanel?) -> Bool { active && panel != nil && hostPanel === panel }

    private init() {
        view.onCancel = { [weak self] in self?.cancel() }
    }

    /// Opens on the document `objectId` cites, highlighted from what was typed (`typed`, the text before the caret).
    func show(objectId: String, versionId: String?, snapshotId: String?, name: String, typed: String,
              projectId: String?, serverURL: URL, hostPanel: NSPanel, linkAvailable: Bool,
              onInsert: @escaping (PassagePick) -> Void, onLink: @escaping (PassagePick) -> Void,
              onCancel: @escaping () -> Void) {
        hide()
        active = true
        generation += 1
        let token = generation
        cancellation = onCancel
        view.onInsert = { [weak self] pick in self?.finish { onInsert(pick) } }
        view.onLink = { [weak self] pick in self?.finish { onLink(pick) } }
        view.linkAvailable = linkAvailable
        view.highlightColor = DirectoryColorPreferences.color(for: projectId)?.color ?? .controlAccentColor
        let kind = Self.kind(of: name)
        view.showLoading(name: name, kind: kind)
        present(in: hostPanel)
        let links = PassageSourceLinks(serverURL: serverURL, objectId: objectId, versionId: versionId)
        load(objectId: objectId, versionId: versionId, snapshotId: snapshotId, typed: typed, serverURL: serverURL,
             links: links, token: token)
    }

    private func present(in panel: NSPanel) {
        takeover.present(view, size: PassagePickerView.defaultSize, in: panel)
    }

    /// The kind a file's name says it is, for the icon shown while it opens.
    static func kind(of name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "mov", "mp4", "m4v": return "video"
        case "pptx": return "slides"
        case "pdf": return "pdf"
        case "docx": return "word"
        default: return "text"
        }
    }

    private func load(objectId: String, versionId: String?, snapshotId: String?, typed: String, serverURL: URL,
                      links: PassageSourceLinks, token: Int) {
        var components = URLComponents(url: serverURL.appendingPathComponent("api/dependency-objects")
            .appendingPathComponent(objectId).appendingPathComponent("passages"), resolvingAgainstBaseURL: false)
        components?.queryItems = [versionId.map { URLQueryItem(name: "version", value: $0) },
                                  snapshotId.map { URLQueryItem(name: "snapshot", value: $0) },
                                  URLQueryItem(name: "typed", value: String(typed.suffix(2000)))].compactMap { $0 }
        guard let url = components?.url else { view.show(message: "This source cannot be opened."); return }
        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = Self.requestTimeout
        request = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let document = (200..<300).contains(status) ? data.flatMap(PassageDocument.parse) : nil
            let failure = document == nil ? WorkspaceAPI.errorMessage(data: data, response: response, error: error) : nil
            DispatchQueue.main.async {
                guard let self, self.active, token == self.generation else { return }
                if let document { self.view.show(document, links: links) } else { self.view.show(message: failure ?? "This source could not be opened.") }
            }
        }
        request?.resume()
    }

    // MARK: Keys, routed from the keyboard tap

    func insert() { if isVisible { view.insert() } }
    func link() { if isVisible { view.link() } }
    func moveSelection(forward: Bool, byLine: Bool, extending: Bool) {
        if isVisible { view.moveSelection(forward: forward, byLine: byLine, extending: extending) }
    }

    /// Back to the card the picker opened from.
    func cancel() {
        let callback = cancellation
        hide()
        callback?()
    }

    /// Closes the picker, then does what was chosen once the card's panel is back.
    private func finish(_ action: @escaping () -> Void) {
        cancellation = nil
        hide()
        action()
    }

    func hide() {
        generation += 1
        request?.cancel()
        request = nil
        guard active else { return }
        active = false
        view.stop()
        cancellation = nil
        takeover.restore()
    }
}
