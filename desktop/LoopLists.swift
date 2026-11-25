// Pieces the Loop's lists share: a file's right-click menu, and the button
// that copies a link. The lists themselves are in LoopListTable.swift.

import Cocoa
import SwiftUI

/// The right-click menu of a file, wherever it is listed.
struct LoopSourceMenu: View {
    @ObservedObject var store: LoopStore
    let source: LoopSource

    var body: some View {
        if let url = store.localURL(for: source) {
            let choice = LoopEditorChoice(url: url)
            if let editor = choice.primary {
                Button("Edit in \(editor.name)") { editor.open(url) }
            }
            if !choice.others.isEmpty {
                Menu("Open With") {
                    ForEach(choice.others) { app in Button(app.name) { app.open(url) } }
                }
            }
            if source.canShareLink { Button("Share\u{2026}") { store.sharing = source } }
            Button("Request Review\u{2026}") { store.requestReview(source) }
            Divider()
            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            Button("Copy Path") { store.copy(url.path) }
        } else {
            Text("Not on this Mac right now")
        }
    }
}

/// Copies a link, and shows a tick for a moment so the copy is seen to land.
struct LoopCopyButton: View {
    let copy: () -> Void
    @State private var copied = false
    private static let tickDuration: TimeInterval = 1.5

    var body: some View {
        Button {
            copy()
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.tickDuration) { copied = false }
        } label: {
            if copied {
                Image(systemName: "checkmark").foregroundStyle(.green)
            } else {
                Image(systemName: "doc.on.doc")
            }
        }
        .buttonStyle(LoopIconButtonStyle(size: 24))
        .help(copied ? "Copied" : "Copy Link")
        .accessibilityLabel(copied ? "Copied" : "Copy Link")
    }
}
