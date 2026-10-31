// The selected suggestion's preview, and opening its source file.

import Cocoa

extension GlobalAssistant {
    func loadPreviewForSelection() {
        guard view.mode == .suggestions,
              let suggestion = currentSuggestion,
              let objectId = suggestion.objectId ?? suggestion.usageObjectId,
              let serverURL else {
            previewRequest?.cancel()
            previewGeneration += 1
            previewKey = nil
            view.preview = nil
            view.previewError = nil
            view.isPreviewLoading = false
            view.needsDisplay = true
            return
        }

        let key = objectId + "|" + (suggestion.versionId ?? "") + "|" + (suggestion.previewText ?? "")
        if previewKey == key, view.preview != nil || view.isPreviewLoading {
            // The same source, but the words typed since may mark different words in it.
            view.updatePreviewContent()
            return
        }
        previewRequest?.cancel()
        previewGeneration += 1
        let token = previewGeneration
        previewKey = key
        view.previewError = nil
        // A PDF cached without its document loads again, to scroll through it.
        if let cached = previewCache[key], cached.pdfPage == nil || cached.pdfPage?.document != nil {
            previewCacheOrder.removeAll { $0 == key }
            previewCacheOrder.append(key)
            view.preview = cached
            view.isPreviewLoading = false
            view.needsDisplay = true
            return
        }

        view.preview = nil
        view.isPreviewLoading = true
        view.needsDisplay = true

        var components = URLComponents(
            url: serverURL.appendingPathComponent("api/dependency-objects")
                .appendingPathComponent(objectId)
                .appendingPathComponent("preview"),
            resolvingAgainstBaseURL: false)
        // The preview scrolls, so it asks for more of the source around the citation.
        var query = [URLQueryItem(name: "context", value: "wide")]
        if let versionId = suggestion.versionId { query.append(URLQueryItem(name: "version", value: versionId)) }
        // Text sources highlight the matched passage, as PDF pages do.
        if let text = suggestion.previewText, !text.isEmpty,
           (suggestion.path as NSString).pathExtension.lowercased() != "pdf" {
            query.append(URLQueryItem(name: "text", value: String(text.prefix(400))))
        }
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else {
            view.isPreviewLoading = false
            view.previewError = "The source preview address is unavailable."
            view.needsDisplay = true
            return
        }
        var request = URLRequest(url: url)
        // A first IFC preview compiles the geometry engine and reads the model.
        // Later previews reuse its geometry; ordinary table requests stay brief.
        switch (suggestion.path as NSString).pathExtension.lowercased() {
        case "ifc": request.timeoutInterval = 60
        case "pdf": request.timeoutInterval = 20
        default: request.timeoutInterval = 2.5
        }
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self, let data,
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  var parsed = Self.parsePreview(data) else {
                DispatchQueue.main.async {
                    guard let self, token == self.previewGeneration, self.previewKey == key else { return }
                    self.view.isPreviewLoading = false
                    self.view.previewError = "The document preview could not be loaded. Select this result again to retry."
                    self.view.needsDisplay = true
                }
                return
            }
            if let pdf = parsed.pdf, let text = suggestion.previewText, !text.isEmpty {
                parsed.pdf = AssistPDFPreview(json: ["kind": "pdf", "fileUrl": pdf.fileUrl,
                    "pageNumber": pdf.pageNumber, "selectedText": text])
            }
            DispatchQueue.main.async {
                guard token == self.previewGeneration, self.previewKey == key else { return }
                if let deck = parsed.deck {
                    // The slides show as pictures, fetched one by one from the cited one out.
                    parsed.slides = SlideDeckDocument(deck: deck, source: SlidePictureSource(
                        serverURL: serverURL, objectId: objectId, versionId: suggestion.versionId))
                }
                if parsed.pdf != nil {
                    self.loadPDFPreview(parsed, serverURL: serverURL, key: key, token: token)
                } else {
                    self.deliverPreview(parsed, key: key, token: token)
                }
            }
        }
        previewRequest = task
        task.resume()
    }

    private func loadPDFPreview(_ preview: AssistDocumentPreview, serverURL: URL, key: String, token: Int) {
        guard let pdf = preview.pdf, let url = pdf.sourceURL(serverURL: serverURL) else {
            var unavailable = preview
            unavailable.unavailableReason = "The indexed PDF preview address is unavailable."
            deliverPreview(unavailable, key: key, token: token)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            var rendered = preview
            if let data, (response as? HTTPURLResponse)?.statusCode == 200 {
                rendered.pdfPage = AssistPDFPageImage.render(data: data, preview: pdf)
            }
            if rendered.pdfPage == nil {
                rendered.unavailableReason = "The PDF page could not be displayed. Select this result again to retry, or open the source."
            }
            DispatchQueue.main.async { self.deliverPreview(rendered, key: key, token: token) }
        }
        previewRequest = task
        task.resume()
    }

    private func deliverPreview(_ preview: AssistDocumentPreview, key: String, token: Int) {
        guard token == previewGeneration, previewKey == key else { return }
        // Transient failures stay retryable; only complete previews enter the cache.
        if preview.unavailableReason == nil {
            previewCache[key] = preview
            previewCacheOrder.removeAll { $0 == key }
            previewCacheOrder.append(key)
            while previewCacheOrder.count > 8 {
                previewCache.removeValue(forKey: previewCacheOrder.removeFirst())
            }
            trimCachedPDFs()
        }
        view.preview = preview
        view.isPreviewLoading = false
        view.needsDisplay = true
    }

    /// Lets go of the oldest cached PDFs' documents beyond the budget. The
    /// one on screen stays whole while its view holds it.
    private func trimCachedPDFs() {
        var kept = 0
        for key in previewCacheOrder.reversed() {
            guard var entry = previewCache[key], let page = entry.pdfPage, page.document != nil else { continue }
            kept += page.documentBytes
            guard kept > Self.cachedPDFBudget else { continue }
            entry.pdfPage?.document = nil
            previewCache[key] = entry
        }
    }

    static func parsePreview(_ data: Data) -> AssistDocumentPreview? {
        AssistDocumentPreview.parse(data)
    }

    func selectRow(_ index: Int) {
        guard index >= 0, index < view.suggestions.count else { return }
        if view.preview?.unavailableReason != nil { previewKey = nil }
        view.selected = index
        view.needsDisplay = true
        loadPreviewForSelection()
    }

    func openCurrentSource() {
        guard let suggestion = currentSuggestion,
              let serverURL else {
            flash(["The local source is unavailable right now."])
            return
        }
        let previewPath = view.preview?.path.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let sourcePath = previewPath.isEmpty ? suggestion.path : previewPath
        // The place the preview cites belongs to the file it previews.
        let target = previewPath.isEmpty ? nil : view.preview?.openTargetAsShown
        let endpoint = serverURL.appendingPathComponent("api/projects")
            .appendingPathComponent(suggestion.projectId)
        let task = URLSession.shared.dataTask(with: endpoint) { [weak self] data, response, _ in
            guard let self else { return }
            guard let data,
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let project = root["project"] as? [String: Any],
                  let rootPath = project["rootPath"] as? String else {
                DispatchQueue.main.async {
                    self.flash(["Lasso could not locate the project folder."])
                }
                return
            }
            DispatchQueue.main.async {
                self.openLocalSource(path: sourcePath, target: target, projectRoot: rootPath,
                                     suggestion: suggestion, serverURL: serverURL)
            }
        }
        task.resume()
    }

    private func openLocalSource(path: String, target: AssistOpenTarget?, projectRoot: String,
                                 suggestion: AssistSuggestion, serverURL: URL) {
        let result = AssistSourceIdentity.openLocalFile(
            projectRoot: projectRoot, sourcePath: path,
            open: { AssistSourceOpener.open($0, at: target) },
            onOpened: {
                RecommendationUsageClient.record(serverURL: serverURL, projectId: suggestion.projectId,
                                                 objectId: suggestion.usageObjectId, path: suggestion.path,
                                                 kind: "open")
            })
        switch result {
        case .unavailable:
            flash(["The source file is no longer available locally."])
        case .opened:
            hide()
        case .failed:
            flash(["macOS could not open \((path as NSString).lastPathComponent)."])
        }
    }
}
