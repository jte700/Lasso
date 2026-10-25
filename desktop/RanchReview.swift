// What The Ranch shows beside a file chosen from Needs Review: the facts
// Lasso recorded about the link, quoted as they are, and the ways a person can
// resolve it. Lasso changes no document; it only opens one, or updates its
// own record of the link when asked.

import Cocoa
import SwiftUI

struct RanchReviewPanel: View {
    @ObservedObject var store: RanchStore
    let item: RanchReviewItem
    /// The cited cell, once the sheet view has found it ("B19").
    var cell: String? = nil
    /// Opens the source in its app at the cited cell.
    var openAtCell: (() -> Void)? = nil
    /// Makes a new share link to the file, for one that changed since it was shared.
    var shareAgain: (() -> Void)? = nil
    @State private var removing: RanchReviewLink?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            header
            if let link = store.focusedLink {
                facts(link)
            } else {
                Text(item.detail).foregroundStyle(RanchTheme.ink.opacity(0.85)).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) { actions }
        }
        .font(RanchTheme.captionFont)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
            shape.fill(RanchTheme.warning.opacity(0.07)).overlay(shape.strokeBorder(RanchTheme.warning.opacity(0.28), lineWidth: 1))
        }
        .alert("Remove This Link?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
               presenting: removing) { link in
            Button("Remove Link", role: .destructive) { store.removeLink(link) }
            Button("Cancel", role: .cancel) {}
        } message: { link in
            Text("\u{201C}\(link.text)\u{201D} stays in \(link.documentName) as it is written. Lasso stops checking it against \(sourceName).")
        }
    }

    private var sourceName: String { item.path.map { ($0 as NSString).lastPathComponent } ?? "its source" }

    private var header: some View {
        HStack(spacing: 7) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(RanchTheme.warning)
            Text(item.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(RanchTheme.ink)
            Spacer(minLength: 6)
            if item.links.count > 1, let index = item.links.firstIndex(where: { $0.id == store.focusedLinkID }) {
                Button { store.focusedLinkID = item.links[index - 1].id } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(RanchIconButtonStyle(size: 22)).disabled(index == 0).help("Previous link")
                Text("\(index + 1) of \(item.links.count)").foregroundStyle(RanchTheme.secondaryInk).monospacedDigit()
                Button { store.focusedLinkID = item.links[index + 1].id } label: { Image(systemName: "chevron.right") }
                    .buttonStyle(RanchIconButtonStyle(size: 22)).disabled(index == item.links.count - 1).help("Next link")
            }
        }
    }

    /// Where the link is written, what it cites, and what Lasso found, as recorded.
    private func facts(_ link: RanchReviewLink) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            (Text("In ") + Text(link.documentName).fontWeight(.semibold) + Text(link.text.isEmpty ? "" : ": \u{201C}\(link.text)\u{201D}"))
                .foregroundStyle(RanchTheme.ink)
                .lineLimit(2)
            if let label = link.label {
                Text("Cites \(label)\(cell.map { " \u{00B7} \($0)" } ?? "")").foregroundStyle(RanchTheme.secondaryInk).lineLimit(2)
            }
            if link.status == "STALE", let linked = link.linkedValue, let now = link.currentValue {
                HStack(spacing: 6) {
                    value("Linked", linked)
                    Image(systemName: "arrow.right").imageScale(.small).foregroundStyle(RanchTheme.tertiaryInk)
                    value("Now", now)
                }
            } else if let linked = link.linkedValue, !linked.isEmpty, linked != link.label {
                value("Linked", linked)
            }
            if let issue = link.issue {
                Text(issue).foregroundStyle(RanchTheme.secondaryInk).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func value(_ title: String, _ value: String) -> some View {
        HStack(spacing: 5) {
            Text(title).foregroundStyle(RanchTheme.secondaryInk)
            Text(value).font(.system(size: 12, weight: .semibold).monospacedDigit()).foregroundStyle(RanchTheme.ink).lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(RanchPillShape())
    }

    @ViewBuilder
    private var actions: some View {
        switch item.kind {
        case "changed", "missing", "unverified":
            if let link = store.focusedLink {
                Button { store.openDocument(for: link) } label: {
                    Label("Open \(link.documentName)", systemImage: "arrow.up.forward.app")
                }
                .buttonStyle(RanchPillButtonStyle())
                .disabled(store.documentURL(for: link) == nil)
                .help("Open the document at these words, to change them yourself")
                if let cell, let openAtCell {
                    Button(action: openAtCell) { Label("Open at \(cell)", systemImage: "tablecells") }
                        .buttonStyle(RanchPillButtonStyle())
                        .help("Open \(sourceName) in its app at the cited cell")
                }
                if link.status == "STALE" {
                    Button { store.keepLinkedVersion(link) } label: { Label("Keep Linked Value", systemImage: "checkmark") }
                        .buttonStyle(RanchPillButtonStyle())
                        .help("Keep citing the value the document linked. The document doesn\u{2019}t change.")
                }
                Button { removing = link } label: { Label("Remove Link\u{2026}", systemImage: "minus.circle") }
                    .buttonStyle(RanchPillButtonStyle())
                    .help("Stop tracking this link. The document\u{2019}s words stay as they are.")
            }
        case "drifted":
            if let shareAgain {
                Button(action: shareAgain) { Label("Share Again", systemImage: "link") }
                    .buttonStyle(RanchPillButtonStyle())
                    .help("Make a new share link to the file as it is now")
            }
            if let share = store.overview.links.outgoing.first(where: { "share:\($0.id)" == item.id }), share.status == "active" {
                Button { store.stopSharing(share) } label: { Label("Stop Sharing", systemImage: "xmark.circle") }
                    .buttonStyle(RanchPillButtonStyle())
            }
        case "directory":
            Button { store.retryDirectory(item.directoryId) } label: { Label("Try Again", systemImage: "arrow.clockwise") }
                .buttonStyle(RanchPillButtonStyle())
            if let directory = store.directory(item.directoryId), !directory.isApp, directory.available {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: directory.rootPath)])
                } label: { Label("Show in Finder", systemImage: "folder") }
                    .buttonStyle(RanchPillButtonStyle())
            }
        default:
            EmptyView()
        }
    }
}

/// A review item with no file to show: a directory, or a source that is gone.
struct RanchReviewOnly: View {
    @ObservedObject var store: RanchStore
    let item: RanchReviewItem

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                RanchEmptyState(symbol: item.kind == "directory" ? "folder.badge.questionmark" : "questionmark.folder",
                                title: item.path.map { ($0 as NSString).lastPathComponent } ?? store.directoryName(item.directoryId),
                                message: item.kind == "directory" ? store.directory(item.directoryId)?.rootPath ?? ""
                                    : "Lasso can\u{2019}t find this file where it was linked.")
                    .frame(height: 170)
                RanchReviewPanel(store: store, item: item)
            }
            .frame(maxWidth: 520)
            .padding(28)
            .frame(maxWidth: .infinity)
        }
        .padding(.top, RanchTheme.headerHeight)
    }
}
