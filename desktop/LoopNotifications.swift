// The bell at the top right of The Loop and the little list that drops
// from it: what is waiting on the person (sources that need review, folders
// with edits to approve, reviews asked for by name), each of which, clicked,
// opens the page and the thing it is about.

import SwiftUI

/// One thing the bell tells of, and where a click on it goes.
struct LoopNotification: Identifiable, Equatable {
    enum Target: Equatable {
        /// A Needs Review item, opened beside its page.
        case reviewItem(LoopReviewItem)
        /// A folder's own review of the edits since it was last approved.
        case folderReview(String)
        /// A review asked for by name.
        case reviewRequest(String)
    }

    let id: String
    let icon: LoopLucide
    let tint: Color
    let title: String
    let detail: String
    /// The folder it is in, said under the detail.
    let place: String
    let target: Target

    /// What the bell lists, the most pressing first: sources that need review,
    /// then reviews asked for by name, then folders with edits waiting.
    static func list(store: LoopStore, reviews: LoopReviewModel) -> [LoopNotification] {
        let items = store.overview.review.map { item in
            LoopNotification(
                id: "review:" + item.id, icon: .triangleAlert, tint: LoopTheme.warning,
                title: item.path.map { ($0 as NSString).lastPathComponent } ?? store.directoryName(item.directoryId),
                detail: item.valueChangeLine ?? item.detail,
                place: LoopActivityPage.reviewKinds[item.kind] ?? "To review",
                target: .reviewItem(item))
        }
        let requests = reviews.requests.filter { $0.state == "open" }.map { request in
            LoopNotification(
                id: "request:" + request.id, icon: .fileDiff, tint: LoopLook.sky,
                title: request.title.isEmpty ? "Review #\(request.number)" : request.title,
                detail: Self.files(request.files) + Self.reviewers(request.reviewers),
                place: store.directoryName(request.directoryId),
                target: .reviewRequest(request.id))
        }
        let folders = reviews.folders.filter { $0.state == "open" && $0.files > 0 }.map { folder in
            LoopNotification(
                id: "folder:" + folder.id, icon: .history, tint: LoopLook.sage,
                title: folder.name,
                detail: Self.files(folder.files) + " edited since last approved",
                place: "Review Changes",
                target: .folderReview(folder.id))
        }
        return items + requests + folders
    }

    private static func files(_ count: Int) -> String { count == 1 ? "1 file" : "\(count.formatted()) files" }

    private static func reviewers(_ reviewers: [LoopReviewer]) -> String {
        guard let first = reviewers.first else { return "" }
        return reviewers.count == 1 ? " \u{00B7} for \(first.name)" : " \u{00B7} for \(first.name) and \(reviewers.count - 1) more"
    }
}

extension LoopStore {
    /// Opens the page a notification is about, with its thing chosen.
    func open(_ notification: LoopNotification) {
        switch notification.target {
        case .reviewItem(let item):
            // The section first: a new section starts with nothing chosen.
            section = .review
            selectedSourceID = item.fileId
            reviewFocus = item
        case .folderReview(let folder):
            section = .reviews
            reviews.choose(folder: folder)
        case .reviewRequest(let id):
            section = .reviews
            reviews.choose(request: id)
        }
    }
}

/// The bell, counting what it lists, and its list dropping from it on a click.
struct LoopNotificationBell: View {
    @ObservedObject var store: LoopStore
    @ObservedObject var reviews: LoopReviewModel
    @State private var showing = false

    var body: some View {
        let notifications = LoopNotification.list(store: store, reviews: reviews)
        LoopBell(count: notifications.count) { showing.toggle() }
            .popover(isPresented: $showing, arrowEdge: .bottom) {
                LoopNotificationList(notifications: notifications) { notification in
                    showing = false
                    store.open(notification)
                }
            }
    }
}

/// The list in the bell's popover.
struct LoopNotificationList: View {
    let notifications: [LoopNotification]
    let choose: (LoopNotification) -> Void

    private static let width: CGFloat = 340
    private static let tallest: CGFloat = 420

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Notifications").font(LoopTheme.titleFont).foregroundStyle(LoopTheme.ink)
                Spacer()
                if !notifications.isEmpty {
                    Text("\(notifications.count)").font(LoopTheme.captionFont).monospacedDigit()
                        .foregroundStyle(LoopTheme.tertiaryInk)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)
            if notifications.isEmpty {
                empty
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(notifications) { notification in
                            LoopNotificationRow(notification: notification) { choose(notification) }
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.bottom, 8)
                }
                .frame(maxHeight: Self.tallest)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(width: Self.width)
        .background(LoopLook.panel)
        .environment(\.colorScheme, .dark)
    }

    private var empty: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.seal").font(.system(size: 20)).foregroundStyle(LoopTheme.tertiaryInk)
            Text("You\u{2019}re all caught up").font(LoopTheme.bodyFont).foregroundStyle(LoopTheme.secondaryInk)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .padding(.bottom, 6)
    }
}

/// One notification: its icon, what it is about, and where.
private struct LoopNotificationRow: View {
    let notification: LoopNotification
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            LoopHover { hovering in
                HStack(alignment: .top, spacing: 11) {
                    LoopLucideIcon(icon: notification.icon, size: 15, color: notification.tint)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(notification.tint.opacity(0.14)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(notification.title).font(LoopLook.font(13, .medium)).foregroundStyle(LoopTheme.ink)
                            .lineLimit(1).truncationMode(.middle)
                        Text(notification.detail).font(LoopTheme.captionFont).foregroundStyle(LoopTheme.secondaryInk)
                            .lineLimit(2)
                        Text(notification.place).font(LoopLook.font(11)).foregroundStyle(LoopTheme.tertiaryInk)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    LoopLucideIcon(icon: .chevronRight, size: 13, color: hovering ? LoopTheme.secondaryInk : LoopTheme.tertiaryInk)
                        .padding(.top, 7)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: LoopLook.rowRadius, style: .continuous)
                    .fill(hovering ? LoopTheme.cardHover : Color.clear))
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens it")
    }
}
