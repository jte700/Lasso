//  Privacy-aware source sharing.
//
//  The composer is deliberately native and non-activating so the document the
//  user is writing in keeps focus. It makes the public boundary visible before
//  a token is minted: whole document, indexed context, or a preview with safe
//  redactions selected directly with the mouse.
//
//  The composer is split by concern. This file holds the glass surface it sits
//  on and the full-document model it previews; ShareComposerController.swift
//  owns its panel and loads what it shows; ShareComposerView.swift holds the
//  view's state, with its drawing, document and PDF handling, scrolling
//  preview, mouse input, mark-up and checks in the ShareComposerView+ files.

import Cocoa

final class ShareComposerSurface: NSView {
    static let cornerRadius: CGFloat = 14

    init(content: NSView) {
        super.init(frame: content.frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.cornerRadius = Self.cornerRadius
        layer?.masksToBounds = true
        let material = NativeMaterial.glassContainer(content: content, cornerRadius: Self.cornerRadius)
        material.frame = bounds
        material.autoresizingMask = [.width, .height]
        addSubview(material)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

struct ShareFullSheet {
    let name: String
    let rows: [[String]]
}

struct ShareFullDocument {
    let kind: String
    let sheets: [ShareFullSheet]
    let blocks: [String]
    /// Markdown structure for each block, when the source is Markdown.
    var styles: [AssistTextBlock] = []
    var model: AssistModelPreview? = nil
    var pdf: AssistPDFPreview? = nil
    var unavailableReason: String? = nil
    /// XML reads as one section per source line, drawn like code.
    var lineLayout = false

    static func parse(_ data: Data) -> ShareFullDocument? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let document = root["document"] as? [String: Any],
              let kind = document["kind"] as? String else { return nil }
        let sheets = (document["sheets"] as? [[String: Any]] ?? []).map { sheet in
            ShareFullSheet(
                name: sheet["name"] as? String ?? "Sheet",
                rows: (sheet["rows"] as? [[Any]] ?? []).map { row in
                    row.map { String(describing: $0) }
                })
        }
        var result = ShareFullDocument(
            kind: kind, sheets: sheets,
            blocks: document["blocks"] as? [String] ?? [])
        if kind == "model-plan" {
            var drawing = document
            drawing["focusBounds"] = drawing["bounds"]
            result.model = AssistModelPreview(json: drawing)
        }
        if kind == "pdf" { result.pdf = AssistPDFPreview(json: document) }
        if document["format"] as? String == "markdown",
           let styles = document["styles"] as? [[String: Any]], styles.count == result.blocks.count {
            result.styles = styles.map(AssistTextBlock.init(markdown:))
        }
        result.unavailableReason = document["reason"] as? String
        result.lineLayout = document["format"] as? String == "lines"
        return result
    }
}
