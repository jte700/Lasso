// Owns the sheet picker: shows it in the suggestion card's own panel, loads
// the cited sheet from the server (another sheet when one is chosen from its
// menu) and hands back the cells highlighted. The card comes back when the
// picker closes.

import Cocoa

final class SheetPickerController {
    static let shared = SheetPickerController()

    private let view = SheetPickerView(frame: NSRect(origin: .zero, size: SheetPickerView.defaultSize))
    private let takeover = CardPanelTakeover()
    private var request: URLSessionDataTask?
    private var generation = 0
    private var active = false
    private var cancellation: (() -> Void)?
    private var source: (objectId: String, versionId: String?, snapshotId: String?, serverURL: URL)?
    private static let requestTimeout: TimeInterval = 30

    var isVisible: Bool { active && takeover.panel?.isVisible == true }

    func isPresented(in panel: NSPanel?) -> Bool { active && panel != nil && takeover.panel === panel }

    private init() {
        view.onCancel = { [weak self] in self?.cancel() }
        view.onSheet = { [weak self] sheet in self?.load(sheet: sheet) }
    }

    /// Opens on the sheet `objectId` cites, with the cited cell, row or column highlighted.
    func show(objectId: String, versionId: String?, snapshotId: String?, name: String, projectId: String?,
              serverURL: URL, hostPanel: NSPanel, onInsert: @escaping (SheetPick) -> Void, onCancel: @escaping () -> Void) {
        hide()
        active = true
        cancellation = onCancel
        source = (objectId, versionId, snapshotId, serverURL)
        view.onInsert = { [weak self] pick in self?.finish { onInsert(pick) } }
        view.highlightColor = DirectoryColorPreferences.color(for: projectId)?.color ?? .controlAccentColor
        view.showLoading(name: name)
        takeover.present(view, size: SheetPickerView.defaultSize, in: hostPanel)
        load(sheet: nil)
    }

    private func load(sheet: String?) {
        guard let source else { return }
        generation += 1
        let token = generation
        request?.cancel()
        var components = URLComponents(url: source.serverURL.appendingPathComponent("api/dependency-objects")
            .appendingPathComponent(source.objectId).appendingPathComponent("sheet"), resolvingAgainstBaseURL: false)
        components?.queryItems = [source.versionId.map { URLQueryItem(name: "version", value: $0) },
                                  source.snapshotId.map { URLQueryItem(name: "snapshot", value: $0) },
                                  sheet.map { URLQueryItem(name: "sheet", value: $0) }].compactMap { $0 }
        guard let url = components?.url else { view.show(message: "This sheet cannot be opened."); return }
        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = Self.requestTimeout
        request = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let document = (200..<300).contains(status) ? data.flatMap(SheetDocument.parse) : nil
            let failure = document == nil ? WorkspaceAPI.errorMessage(data: data, response: response, error: error) : nil
            DispatchQueue.main.async {
                guard let self, self.active, token == self.generation else { return }
                if let document { self.view.show(document) } else { self.view.show(message: failure ?? "This sheet could not be opened.") }
            }
        }
        request?.resume()
    }

    // MARK: Keys, routed from the keyboard tap

    func insert() { if isVisible { view.insert() } }
    func undo() { if isVisible { view.undo() } }
    func redo() { if isVisible { view.redo() } }
    func move(columns: Int, rows: Int, extending: Bool) {
        if isVisible { view.move(columns: columns, rows: rows, extending: extending) }
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
        cancellation = nil
        source = nil
        takeover.restore()
    }
}
