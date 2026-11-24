// The bell at the top right of The Ranch and the little list that drops
// from it: what is waiting on the person (sources that need review, folders
// with edits to approve, reviews asked for by name), each of which, clicked,
// opens the page and the thing it is about.

import SwiftUI

/// One thing the bell tells of, and where a click on it goes.
struct RanchNotification: Identifiable, Equatable {
    enum Target: Equatable {
        /// A Needs Review item, opened beside its page.
        case reviewItem(RanchReviewItem)
        /// A folder's own review of the edits since it was last approved.
        case folderReview(String)
        /// A review asked for by name.
        case reviewRequest(String)
    }

    let id: String
    let icon: RanchLucide
    let tint: Color
    let title: String
    let detail: String
    /// The folder it is in, said under the detail.
    let place: String
    let target: Target

    /// What the bell lists, the most pressing first: sources that need review,
    /// then reviews asked for by name, then folders with edits waiting.
    static func list(store: RanchStore, reviews: RanchReviewModel) -> [RanchNotification] {
        let items = store.overview.review.map { item in
            RanchNotification(
                id: "review:" + item.id, icon: .triangleAlert, tint: RanchTheme.warning,
                title: item.path.map { ($0 as NSString).lastPathComponent } ?? store.directoryName(item.directoryId),
                detail: item.valueChangeLine ?? item.detail,
                place: RanchActivityPage.reviewKinds[item.kind] ?? "To review",
                target: .reviewItem(item))
        }
        let requests = reviews.requests.filter { $0.state == "open" }.map { request in
            RanchNotification(
                id: "request:" + request.id, icon: .fileDiff, tint: RanchLook.sky,
                title: request.title.isEmpty ? "Review #\(request.number)" : request.title,
                detail: Self.files(request.files) + Self.reviewers(request.reviewers),
                place: store.directoryName(request.directoryId),
                target: .reviewRequest(request.id))
        }
        let folders = reviews.folders.filter { $0.state == "open" && $0.files > 0 }.map { folder in
            RanchNotification(
                id: "folder:" + folder.id, icon: .history, tint: RanchLook.sage,
                title: folder.name,
                detail: Self.files(folder.files) + " edited since last approved",
                place: "Review Changes",
                target: .folderReview(folder.id))
        }
        return items + requests + folders
    }

    private static func files(_ count: Int) -> String { count == 1 ? "1 file" : "\(count.formatted()) files" }

    private static func reviewers(_ reviewers: [RanchReviewer]) -> String {
        guard let first = reviewers.first else { return "" }
        return reviewers.count == 1 ? " \u{00B7} for \(first.name)" : " \u{00B7} for \(first.name) and \(reviewers.count - 1) more"
    }
}

extension RanchStore {
    /// Opens the page a notification is about, with its thing chosen.
    func open(_ notification: RanchNotification) {
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
struct RanchNotificationBell: View {
    @ObservedObject var store: RanchStore
    @ObservedObject var reviews: RanchReviewModel
    @State private var showing = false

    var body: some View {
        let notifications = RanchNotification.list(store: store, reviews: reviews)
        RanchBell(count: notifications.count) { showing.toggle() }
            .popover(isPresented: $showing, arrowEdge: .bottom) {
                RanchNotificationList(notifications: notifications) { notification in
                    showing = false
                    store.open(notification)
                }
            }
    }
}

/// The list in the bell's popover.
struct RanchNotificationList: View {
    let notifications: [RanchNotification]
    let choose: (RanchNotification) -> Void

    private static let width: CGFloat = 340
    private static let tallest: CGFloat = 420

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Notifications").font(RanchTheme.titleFont).foregroundStyle(RanchTheme.ink)
                Spacer()
                if !notifications.isEmpty {
                    Text("\(notifications.count)").font(RanchTheme.captionFont).monospacedDigit()
                        .foregroundStyle(RanchTheme.tertiaryInk)
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
                            RanchNotificationRow(notification: notification) { choose(notification) }
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
        .background(RanchLook.panel)
        .environment(\.colorScheme, .dark)
    }

    private var empty: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.seal").font(.system(size: 20)).foregroundStyle(RanchTheme.tertiaryInk)
            Text("You\u{2019}re all caught up").font(RanchTheme.bodyFont).foregroundStyle(RanchTheme.secondaryInk)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .padding(.bottom, 6)
    }
}

/// One notification: its icon, what it is about, and where.
private struct RanchNotificationRow: View {
    let notification: RanchNotification
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            RanchHover { hovering in
                HStack(alignment: .top, spacing: 11) {
                    RanchLucideIcon(icon: notification.icon, size: 15, color: notification.tint)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(notification.tint.opacity(0.14)))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(notification.title).font(RanchLook.font(13, .medium)).foregroundStyle(RanchTheme.ink)
                            .lineLimit(1).truncationMode(.middle)
                        Text(notification.detail).font(RanchTheme.captionFont).foregroundStyle(RanchTheme.secondaryInk)
                            .lineLimit(2)
                        Text(notification.place).font(RanchLook.font(11)).foregroundStyle(RanchTheme.tertiaryInk)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    RanchLucideIcon(icon: .chevronRight, size: 13, color: hovering ? RanchTheme.secondaryInk : RanchTheme.tertiaryInk)
                        .padding(.top, 7)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: RanchLook.rowRadius, style: .continuous)
                    .fill(hovering ? RanchTheme.cardHover : Color.clear))
                .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens it")
    }
}
