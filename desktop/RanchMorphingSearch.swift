// The sources pages' search bar, rebuilt from BeUI's Morphing Search: the
// Chip Search its page opens with (beui.dev/components/blocks/morphing-search,
// morphing-search-chips.tsx). A glass pill 56 points tall floats at the foot
// of the page over the list, holding the filters as chips; a file is listed
// when it holds every one. A click in the bar, F, ⌘F or the sidebar's Search
// row puts the cursor in it: the bar widens on BeUI's layout spring and a
// glass panel grows up out of it, from a small pill tucked behind its edge
// (stiffness 380, damping 28, mass 0.8; it folds back faster, on 520, 40 and
// 0.6), its rows fading in once the shape has mostly arrived. The panel lists
// the recent searches, or while typing what was typed and the recents and
// suggestions holding it, the typed part heavier. Return or a click adds the
// highlighted row as a chip; Backspace at the start of the field marks the
// last chip and a second press removes it; ← walks back through the chips;
// Delete removes the highlighted recent; Escape clears the typing, then
// closes the panel; a click anywhere else closes it too.

import Cocoa
import SwiftUI

enum RanchChipMotion {
    /// SPRING_MORPH: the panel's glass growing out of the bar, landing with a soft overshoot.
    static let morph = Animation.interpolatingSpring(mass: 0.8, stiffness: 380, damping: 28)
    /// MORPH_EXIT: folding back into the bar, faster than it grew.
    static let morphBack = Animation.interpolatingSpring(mass: 0.6, stiffness: 520, damping: 40)
    static let glassIn = Animation.easeOut(duration: 0.1)
    static let glassOut = Animation.easeOut(duration: 0.12).delay(0.1)
    /// CONTENT_IN and CONTENT_OUT, on BeUI's EASE_OUT.
    static let contentIn = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.18).delay(0.12)
    static let contentOut = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.08)
    /// SPRING_LAYOUT: the bar widening, the field gliding aside, the highlight between rows.
    static let layout = Animation.interpolatingSpring(mass: 0.6, stiffness: 360, damping: 32)
    /// SPRING_SWAP, with the opacity and blur timings of CHIP_ENTER: a chip arriving.
    static let chipIn = Animation.interpolatingSpring(mass: 0.55, stiffness: 460, damping: 30)
    static let chipFade = Animation.easeOut(duration: 0.16)
    static let chipFocus = Animation.easeOut(duration: 0.2)
    /// CHIP_EXIT: a chip leaving, faster than it came.
    static let chipOut = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.16)
    /// SEED and SEED_TUCK: the pill the panel starts from, tucked halfway behind the bar.
    static let seed = CGSize(width: 112, height: 40)
    static let tuck: CGFloat = 28
    static let height: CGFloat = 56
    /// max-w-xl: the widest the bar grows.
    static let maxWidth: CGFloat = 576
    /// The panel's distance from the bar.
    static let gap: CGFloat = 8
    static let row: CGFloat = 44
    /// BeUI's muted foreground.
    static let muted = RanchLook.ink2
    /// How long the panel takes to fold away before it leaves the page.
    static let folding = 0.42
    /// The icon, gaps and the bar's own insets beside the chips and the field.
    static let insets: CGFloat = 16 + 20 + 8 + 8 + 16
}

/// BeUI's glass: a thin tint of the page over a blur of what is under it, a
/// hairline edge, a highlight along the top and a soft drop below.
struct RanchChipGlass: View {
    let radius: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        ZStack {
            RanchBackdropBlur(radius: radius)
            shape.fill(RanchLook.page.opacity(RanchBackdropBlur.tint))
            shape.fill(Color.white.opacity(0.06))
                .mask {
                    ZStack {
                        shape.fill(Color.white)
                        shape.fill(Color.black).offset(y: 1).blendMode(.destinationOut)
                    }
                    .compositingGroup()
                }
            shape.strokeBorder(RanchLook.ink.opacity(0.08), lineWidth: 1)
        }
        .environment(\.colorScheme, .dark)
        .background {
            // 0 24px 60px -24px: a drop drawn from the shape drawn in by 24 points, outside the shape only.
            GeometryReader { place in
                shape.fill(Color.black.opacity(0.45))
                    .frame(width: max(0, place.size.width - 48), height: max(0, place.size.height - 48))
                    .position(x: place.size.width / 2, y: place.size.height / 2 + 24)
                    .blur(radius: 30)
                    .mask {
                        ZStack {
                            Rectangle().fill(Color.white).padding(-100)
                            shape.fill(Color.black).blendMode(.destinationOut)
                        }
                        .compositingGroup()
                    }
            }
            .allowsHitTesting(false)
        }
    }
}

/// What lies under it on the page, blurred, as CSS's backdrop-filter does:
/// AppKit's in-window material (SwiftUI's own materials show what is behind
/// the window instead), its corners cut as the shape it fills.
struct RanchBackdropBlur: NSViewRepresentable {
    let radius: CGFloat
    /// How much of the page's colour lies over the blur; the material darkens it a little itself.
    static let tint = 0.4

    final class Blur: NSVisualEffectView {
        var radius: CGFloat = 0 { didSet { needsLayout = true } }
        private var cut: CGFloat = -1

        override func layout() {
            super.layout()
            let corner = max(1, floor(min(radius, bounds.height / 2, bounds.width / 2)))
            guard corner != cut else { return }
            cut = corner
            let edge = corner * 2 + 1
            let mask = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
                NSColor.black.setFill()
                NSBezierPath(roundedRect: rect, xRadius: corner, yRadius: corner).fill()
                return true
            }
            mask.capInsets = NSEdgeInsets(top: corner, left: corner, bottom: corner, right: corner)
            mask.resizingMode = .stretch
            maskImage = mask
        }
    }

    func makeNSView(context: Context) -> Blur {
        let view = Blur()
        view.blendingMode = .withinWindow
        view.material = .hudWindow
        view.state = .active
        view.appearance = NSAppearance(named: .darkAqua)
        view.radius = radius
        return view
    }

    func updateNSView(_ view: Blur, context: Context) {
        if view.radius != radius { view.radius = radius }
    }
}

private struct RanchBarFrameKey: PreferenceKey {
    static let defaultValue = CGRect.zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

private struct RanchPanelFrameKey: PreferenceKey {
    static let defaultValue = CGRect.zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        let next = nextValue()
        if next != .zero { value = next }
    }
}

private struct RanchChipsWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct RanchPanelRowsKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct RanchSearchBar: View {
    typealias Row = RanchChipSearch.Row

    @Binding var chips: [String]
    @Binding var recents: [String]
    /// The terms offered as the field is typed in.
    let suggestions: RanchChipSearch.Terms
    let placeholder: String
    /// Counts asks to put the cursor in the bar: F, ⌘F and the sidebar's Search row.
    let focusRequest: Int
    /// The widest the bar grows, and the tallest the panel's list gets before it scrolls.
    let width: CGFloat
    let listRoom: CGFloat
    var emptyState = "Type part of a file\u{2019}s name, a directory or a kind of file, then press Return to filter by it."

    /// The highlighted row: its id, stamped with the words it was chosen under.
    private struct Cursor: Equatable {
        let id: String
        let query: String
    }

    @State private var open = false
    @State private var query = ""
    @State private var marked: String?
    @State private var cursor: Cursor?
    /// The panel is on the page (it stays while folding away), and its glass has grown.
    @State private var present = false
    @State private var grown = false
    @State private var arrived = false
    @State private var panelSize = CGSize.zero
    /// The tallest the panel has been since it opened: typing can grow it but never shrink it.
    @State private var floor: CGFloat = 0
    @State private var chipsWidth: CGFloat = 0
    /// The chips as the bar draws them, moved on its springs; the page's list follows `chips` without them.
    @State private var shown: [String] = []
    @State private var fieldFocus = 0
    @State private var fieldBlur = 0
    @State private var newestChip: String?
    @State private var barFrame = CGRect.zero
    @State private var panelFrame = CGRect.zero
    @State private var clicks: Any?
    @Namespace private var space
    private let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    private var typed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var rows: [Row] {
        RanchChipSearch.rows(query: query, chips: chips, recents: recents, terms: suggestions)
    }

    /// The cursor's row, or the first once the words have moved on or the row has left.
    private func activeIndex(_ rows: [Row]) -> Int {
        guard let cursor, cursor.query == typed, let at = rows.firstIndex(where: { $0.id == cursor.id }) else { return 0 }
        return at
    }

    var body: some View {
        let rows = self.rows
        let active = activeIndex(rows)
        bar
            .frame(width: width, height: RanchChipMotion.height)
            // The panel floats over the page above the bar, behind it, so it grows out from under its edge.
            .background(alignment: .bottom) {
                if present {
                    panel(rows, active: active)
                        .frame(width: width)
                        .fixedSize(horizontal: false, vertical: true)
                        .offset(y: -(RanchChipMotion.height + RanchChipMotion.gap))
                        .transition(.identity)
                }
            }
            .onPreferenceChange(RanchBarFrameKey.self) { barFrame = $0 }
            .onPreferenceChange(RanchPanelFrameKey.self) { panelFrame = $0 }
            .onChange(of: focusRequest) { _ in
                fieldFocus += 1
                setOpen(true)
            }
            .onChange(of: open) { isOpen in isOpen ? unfold() : fold() }
            .onChange(of: chips) { next in
                if next != shown { withAnimation(still ? nil : RanchChipMotion.layout) { shown = next } }
            }
            .onAppear {
                shown = chips
                watchClicks()
            }
            .onDisappear {
                if let clicks { NSEvent.removeMonitor(clicks) }
                clicks = nil
            }
    }

    // MARK: The bar

    private var bar: some View {
        let restField = Self.restFieldWidth(placeholder)
        let fieldRoom = open ? 96 : restField
        let chipsNatural = shown.isEmpty ? 0 : chipsWidth + 12
        let chipsArea = min(chipsNatural, max(0, width - RanchChipMotion.insets - fieldRoom))
        let barWidth = open ? width : min(width, RanchChipMotion.insets + chipsArea + restField)
        return HStack(spacing: 8) {
            RanchLucideIcon(icon: .search, size: 20, color: RanchChipMotion.muted)
            chipsRow
                .frame(width: chipsArea + 12)
                .padding(.horizontal, -6)
            RanchChipField(text: $query, placeholder: placeholder, focusAsk: fieldFocus, blurAsk: fieldBlur,
                           focused: { now in
                               if now {
                                   setOpen(true)
                               } else {
                                   marked = nil
                                   setOpen(false)
                               }
                           },
                           typed: {
                               marked = nil
                               if !open { setOpen(true) }
                           },
                           command: handle)
                .frame(maxWidth: .infinity, minHeight: 36, maxHeight: 36)
                .accessibilityLabel(placeholder)
        }
        .padding(.horizontal, 16)
        .frame(width: barWidth, height: RanchChipMotion.height)
        .background(RanchChipGlass(radius: RanchChipMotion.height / 2))
        .contentShape(Capsule())
        // A press anywhere on the bar that is not its own control lands in the field.
        .onTapGesture {
            fieldFocus += 1
            setOpen(true)
        }
        .background(GeometryReader { place in
            Color.clear.preference(key: RanchBarFrameKey.self, value: place.frame(in: .global))
        })
        .help("Search (F)")
    }

    /// At rest the field is as wide as its prompt, so the bar hugs what it holds.
    static func restFieldWidth(_ placeholder: String) -> CGFloat {
        let zero = ("0" as NSString).size(withAttributes: [.font: RanchLook.nsFont(16)]).width
        return ceil(CGFloat(max(placeholder.count, 6) + 2) * zero)
    }

    /// The chips, in a row that scrolls once they outgrow the bar and fades at its ends.
    private var chipsRow: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(shown, id: \.self) { chip in
                        RanchChip(term: chip, marked: marked == chip, remove: { remove(chip) })
                            .transition(.ranchChip)
                            .id(chip)
                    }
                }
                .padding(.horizontal, 12)
                .frame(height: RanchChipMotion.height)
                .background(GeometryReader { place in
                    Color.clear.preference(key: RanchChipsWidthKey.self, value: max(0, place.size.width - 24))
                })
            }
            .frame(height: RanchChipMotion.height)
            .onChange(of: newestChip) { chip in
                guard let chip else { return }
                withAnimation(still ? nil : .easeOut(duration: 0.3)) { proxy.scrollTo(chip, anchor: .trailing) }
            }
        }
        .mask {
            if shown.isEmpty {
                Rectangle()
            } else {
                HStack(spacing: 0) {
                    LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: 12)
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 12)
                }
            }
        }
        .onPreferenceChange(RanchChipsWidthKey.self) { chipsWidth = $0 }
    }

    // MARK: The panel

    private func panel(_ rows: [Row], active: Int) -> some View {
        let seed = RanchChipMotion.seed
        let size = grown ? CGSize(width: panelSize.width > 0 ? panelSize.width : seed.width,
                                  height: panelSize.height > 0 ? panelSize.height : seed.height) : seed
        return VStack(spacing: 0) {
            panelRows(rows, active: active)
        }
        .background(GeometryReader { place in
            Color.clear.preference(key: RanchPanelRowsKey.self, value: place.size.height)
        })
        .onPreferenceChange(RanchPanelRowsKey.self) { height in floor = max(floor, height + 16) }
        .padding(8)
        // Never shorter than this session's tallest list, so narrowing a search leaves empty glass.
        .frame(maxWidth: .infinity, minHeight: floor > 0 ? floor : nil, alignment: .top)
        // The rows wait for the shape to arrive and leave before it goes.
        .opacity(grown ? 1 : 0)
        .animation(still ? .easeOut(duration: 0.15) : grown ? RanchChipMotion.contentIn : RanchChipMotion.contentOut, value: grown)
        .offset(y: arrived || still ? 0 : 6)
        .animation(RanchChipMotion.contentIn, value: arrived)
        .background(GeometryReader { place in
            Color.clear
                .preference(key: RanchPanelFrameKey.self, value: place.frame(in: .global))
                .onAppear { panelSize = place.size }
                .onChange(of: place.size) { panelSize = $0 }
        })
        .background(alignment: .bottom) {
            // The glass starts as a small pill on the bar's edge and springs out to the size of what it holds.
            RanchChipGlass(radius: RanchChipMotion.height / 2)
                .frame(width: still ? panelSize.width : size.width, height: still ? panelSize.height : size.height)
                .offset(y: grown || still ? 0 : RanchChipMotion.tuck)
                .animation(still ? nil : grown ? RanchChipMotion.morph : RanchChipMotion.morphBack, value: grown)
                .animation(still ? nil : RanchChipMotion.morph, value: panelSize)
                .opacity(grown ? 1 : 0)
                .animation(still ? .easeOut(duration: 0.12) : grown ? RanchChipMotion.glassIn : RanchChipMotion.glassOut, value: grown)
                .allowsHitTesting(false)
        }
        .allowsHitTesting(grown)
        .accessibilityHidden(!grown)
    }

    @ViewBuilder
    private func panelRows(_ rows: [Row], active: Int) -> some View {
        HStack {
            Text(typed.isEmpty ? "Recent" : "Suggestions")
                .font(RanchLook.font(12, .medium))
                .foregroundStyle(RanchChipMotion.muted)
            Spacer(minLength: 8)
            if typed.isEmpty && !recents.isEmpty {
                Button("Clear", action: clearRecents)
                    .buttonStyle(RanchChipClearStyle())
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        if !rows.isEmpty {
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    VStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            rowView(row, selected: index == active)
                        }
                    }
                }
                .frame(height: min(CGFloat(rows.count) * RanchChipMotion.row, listRoom))
                .onChange(of: rows.indices.contains(active) ? rows[active].id : "") { id in
                    if !id.isEmpty { proxy.scrollTo(id) }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(typed.isEmpty ? "Recent searches" : "Suggestions")
        } else if typed.isEmpty {
            Text(emptyState)
                .font(RanchLook.font(14))
                .foregroundStyle(RanchChipMotion.muted)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.top, 4)
                .padding(.bottom, 8)
        }
    }

    private func rowView(_ row: Row, selected: Bool) -> some View {
        HStack(spacing: 12) {
            RanchLucideIcon(icon: row.kind == .recent ? .clock : .search, size: 16, color: RanchChipMotion.muted)
            label(row)
                .font(RanchLook.font(14))
                .foregroundStyle(RanchLook.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if row.kind == .recent {
                RanchChipX(size: 28) { removeRecent(row.label) }
                    .accessibilityLabel("Remove \(row.label) from recent searches")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: RanchChipMotion.row)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(RanchLook.ink.opacity(0.06))
                    .matchedGeometryEffect(id: "active", in: space)
            }
        }
        .contentShape(Rectangle())
        .onHover { inside in if inside { aim(at: row) } }
        .onTapGesture { add(row.label) }
        .id(row.id)
        .transition(.identity)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { add(row.label) }
    }

    /// The typed words drawn heavier where they sit in a recent or a suggestion.
    private func label(_ row: Row) -> Text {
        guard row.kind != .query, let range = RanchChipSearch.highlight(row.label, query: query) else { return Text(row.label) }
        return Text(String(row.label[..<range.lowerBound]))
            + Text(String(row.label[range])).font(RanchLook.font(14, .semibold))
            + Text(String(row.label[range.upperBound...]))
    }

    // MARK: Opening and closing

    private func setOpen(_ value: Bool) {
        guard value != open else { return }
        // A fresh session each time the panel opens: the highlight starts at the top.
        if value { cursor = nil }
        withAnimation(still ? nil : RanchChipMotion.layout) { open = value }
    }

    private func unfold() {
        floor = 0
        var quiet = Transaction()
        quiet.disablesAnimations = true
        withTransaction(quiet) { present = true }
        DispatchQueue.main.async {
            guard open else { return }
            grown = true
            arrived = true
        }
    }

    private func fold() {
        grown = false
        DispatchQueue.main.asyncAfter(deadline: .now() + RanchChipMotion.folding) {
            guard !open else { return }
            var quiet = Transaction()
            quiet.disablesAnimations = true
            withTransaction(quiet) {
                present = false
                arrived = false
            }
        }
    }

    /// A press outside the bar and its panel closes it and takes the cursor out of
    /// the field, and still does what it was aimed at; a press on the field
    /// while the panel is closed opens it again.
    private func watchClicks() {
        guard clicks == nil else { return }
        clicks = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { event in
            guard let window = event.window, let content = window.contentView else {
                if open { marked = nil; setOpen(false) }
                return event
            }
            guard window.title == Ranch.title else {
                if open { marked = nil; setOpen(false) }
                return event
            }
            let point = CGPoint(x: event.locationInWindow.x, y: content.bounds.height - event.locationInWindow.y)
            let inside = barFrame.contains(point) || (present && grown && panelFrame.contains(point))
            if inside {
                if !open && barFrame.contains(point) { setOpen(true) }
            } else if open || marked != nil {
                marked = nil
                setOpen(false)
                fieldBlur += 1
            }
            return event
        }
    }

    // MARK: Chips and recents

    private func add(_ term: String) {
        let result = RanchChipSearch.add(term, chips: chips, recents: recents)
        let value = term.trimmingCharacters(in: .whitespacesAndNewlines)
        switch result.outcome {
        case .empty:
            return
        case .full:
            announce("Up to \(RanchChipSearch.maxChips) filters")
            return
        case .added:
            announce("Added filter \(value)")
        case .existing:
            break
        }
        withoutAnimation {
            query = ""
            recents = result.recents
        }
        setChips(result.chips)
        if result.outcome == .added { newestChip = value }
    }

    private func remove(_ chip: String) {
        setChips(chips.filter { $0 != chip })
        if marked == chip { marked = nil }
        announce("Removed filter \(chip)")
        fieldFocus += 1
    }

    /// The bar's chips move on its springs; the store, and the list it feeds, change at once.
    private func setChips(_ next: [String]) {
        withAnimation(still ? nil : RanchChipMotion.layout) { shown = next }
        withoutAnimation { chips = next }
    }

    private func withoutAnimation(_ change: () -> Void) {
        var quiet = Transaction()
        quiet.disablesAnimations = true
        withTransaction(quiet, change)
    }

    private func removeRecent(_ term: String) {
        recents.removeAll { $0 == term }
        announce("Removed \(term) from recent searches")
    }

    private func clearRecents() {
        recents = []
        announce("Cleared recent searches")
        fieldFocus += 1
    }

    private func aim(at row: Row) {
        let next = Cursor(id: row.id, query: typed)
        guard cursor != next else { return }
        withAnimation(still ? nil : RanchChipMotion.layout) { cursor = next }
    }

    private func move(by direction: Int) {
        let rows = self.rows
        guard !rows.isEmpty else { return }
        let next = min(max(activeIndex(rows) + direction, 0), rows.count - 1)
        withAnimation(still ? nil : RanchChipMotion.layout) { cursor = Cursor(id: rows[next].id, query: typed) }
    }

    private func announce(_ text: String) {
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
    }

    // MARK: Keys

    /// The keys the field hands over before it acts on them itself. Returns
    /// whether the key was used here.
    private func handle(_ command: Selector, in text: NSTextView) -> Bool {
        let atStart = text.selectedRange() == NSRange(location: 0, length: 0)
        let back = #selector(NSResponder.moveLeft(_:))
        let forward = #selector(NSResponder.moveRight(_:))
        let erase = #selector(NSResponder.deleteBackward(_:))
        let eraseForward = #selector(NSResponder.deleteForward(_:))
        let escape = #selector(NSResponder.cancelOperation(_:))
        if let chip = marked {
            switch command {
            case erase, eraseForward:
                marked = nil
                remove(chip)
                return true
            case back, forward:
                withAnimation(.easeOut(duration: 0.15)) {
                    marked = RanchChipSearch.step(chip, by: command == back ? -1 : 1, in: chips)
                }
                return true
            case escape:
                marked = nil
                return true
            default:
                marked = nil
            }
        }
        let rows = self.rows
        let active = rows.indices.contains(activeIndex(rows)) ? rows[activeIndex(rows)] : nil
        switch command {
        case escape:
            // Clear before closing: one press undoes the typing, the next closes the panel.
            if !query.isEmpty {
                query = ""
            } else if open {
                setOpen(false)
            } else {
                fieldBlur += 1
            }
            return true
        case #selector(NSResponder.moveDown(_:)), #selector(NSResponder.moveUp(_:)):
            if !open {
                setOpen(true)
            } else {
                move(by: command == #selector(NSResponder.moveDown(_:)) ? 1 : -1)
            }
            return true
        case #selector(NSResponder.insertNewline(_:)):
            guard open, let active else { return false }
            add(active.label)
            return true
        case eraseForward:
            guard open, let active, active.kind == .recent else { return false }
            removeRecent(active.label)
            return true
        case erase:
            // Mark first, remove on the second press: one stray key never loses a filter.
            guard atStart, let last = chips.last else { return false }
            withAnimation(.easeOut(duration: 0.15)) { marked = last }
            announce("\(last) selected. Press Delete again to remove it.")
            return true
        case back:
            guard atStart, !chips.isEmpty else { return false }
            withAnimation(.easeOut(duration: 0.15)) { marked = RanchChipSearch.step(nil, by: -1, in: chips) }
            return true
        case #selector(NSResponder.insertTab(_:)), #selector(NSResponder.insertBacktab(_:)):
            setOpen(false)
            return false
        default:
            return false
        }
    }
}

/// A filter in the bar: its words in a soft capsule with a round × to remove
/// it, ringed while the keyboard has marked it for removal.
private struct RanchChip: View {
    let term: String
    let marked: Bool
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(term)
                .font(RanchLook.font(14))
                .foregroundStyle(RanchLook.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: Self.textWidth(term), alignment: .leading)
            RanchChipX(size: 28, action: remove)
                .accessibilityLabel("Remove filter \(term)")
        }
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .frame(height: 36)
        .background(Capsule().fill(RanchLook.ink.opacity(marked ? 0.12 : 0.07)))
        .overlay(Capsule().strokeBorder(RanchLook.ink.opacity(marked ? 0.4 : 0), lineWidth: 2))
        .animation(.easeOut(duration: 0.15), value: marked)
        .help(term)
    }

    /// max-w-40: a long filter is cut short at 160 points.
    static func textWidth(_ term: String) -> CGFloat {
        min(160, ceil((term as NSString).size(withAttributes: [.font: RanchLook.nsFont(14)]).width))
    }
}

/// The round × on a chip or a recent search.
private struct RanchChipX: View {
    let size: CGFloat
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            RanchLucideIcon(icon: .x, size: 14, color: hovering ? RanchLook.ink : RanchChipMotion.muted)
                .frame(width: size, height: size)
                .background(Circle().fill(RanchLook.ink.opacity(hovering ? 0.1 : 0)))
                .contentShape(Circle())
                .animation(.easeOut(duration: 0.15), value: hovering)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// The panel's Clear: small and muted, brightening under the pointer.
private struct RanchChipClearStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RanchHover { hovering in
            configuration.label
                .font(RanchLook.font(12))
                .foregroundStyle(hovering ? RanchLook.ink : RanchChipMotion.muted)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .animation(.easeOut(duration: 0.15), value: hovering)
        }
    }
}

/// A chip arriving grows out of the one before it, from 60 percent with a
/// little blur, on the swap spring; leaving, it folds back on a short ease.
private struct RanchChipReveal: ViewModifier {
    let hidden: Bool
    let leaving: Bool

    func body(content: Content) -> some View {
        content
            .scaleEffect(hidden ? 0.6 : 1, anchor: .leading)
            .animation(leaving ? RanchChipMotion.chipOut : RanchChipMotion.chipIn, value: hidden)
            .blur(radius: hidden ? 3 : 0)
            .animation(leaving ? RanchChipMotion.chipOut : RanchChipMotion.chipFocus, value: hidden)
            .opacity(hidden ? 0 : 1)
            .animation(leaving ? RanchChipMotion.chipOut : RanchChipMotion.chipFade, value: hidden)
    }
}

private extension AnyTransition {
    static let ranchChip = AnyTransition.asymmetric(
        insertion: .modifier(active: RanchChipReveal(hidden: true, leaving: false),
                             identity: RanchChipReveal(hidden: false, leaving: false)),
        removal: .modifier(active: RanchChipReveal(hidden: true, leaving: true),
                           identity: RanchChipReveal(hidden: false, leaving: true)))
}

/// The bar's field: plain text on the glass, in Figtree, handing its keys to
/// the bar before acting on them.
struct RanchChipField: NSViewRepresentable {
    @Binding var text: String
    let placeholder: String
    /// Counts asks to take or give up the cursor.
    let focusAsk: Int
    let blurAsk: Int
    let focused: (Bool) -> Void
    let typed: () -> Void
    let command: (Selector, NSTextView) -> Bool

    final class Field: NSTextField {
        var onFocus: (() -> Void)?
        var onBlur: (() -> Void)?

        override func becomeFirstResponder() -> Bool {
            let became = super.becomeFirstResponder()
            if became { onFocus?() }
            return became
        }

        override func textDidEndEditing(_ notification: Notification) {
            super.textDidEndEditing(notification)
            onBlur?()
        }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: RanchChipField
        var focusAsk: Int
        var blurAsk: Int

        init(_ parent: RanchChipField) {
            self.parent = parent
            focusAsk = parent.focusAsk
            blurAsk = parent.blurAsk
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            parent.text = field.stringValue
            parent.typed()
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            parent.command(selector, textView)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> Field {
        let field = Field()
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = RanchLook.nsFont(16)
        field.textColor = NSColor(RanchLook.ink)
        field.usesSingleLineMode = true
        field.lineBreakMode = .byTruncatingTail
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        field.delegate = context.coordinator
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.setContentHuggingPriority(.required, for: .vertical)
        field.placeholderAttributedString = placeholderText
        field.stringValue = text
        return field
    }

    func updateNSView(_ field: Field, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != text { field.stringValue = text }
        if field.placeholderAttributedString?.string != placeholder { field.placeholderAttributedString = placeholderText }
        field.onFocus = { [focused] in focused(true) }
        field.onBlur = { [focused] in focused(false) }
        if context.coordinator.focusAsk != focusAsk {
            context.coordinator.focusAsk = focusAsk
            DispatchQueue.main.async {
                guard let window = field.window, field.currentEditor() == nil else { return }
                window.makeFirstResponder(field)
            }
        }
        if context.coordinator.blurAsk != blurAsk {
            context.coordinator.blurAsk = blurAsk
            DispatchQueue.main.async {
                guard let window = field.window, field.currentEditor() != nil else { return }
                window.makeFirstResponder(nil)
            }
        }
    }

    private var placeholderText: NSAttributedString {
        NSAttributedString(string: placeholder, attributes: [.font: RanchLook.nsFont(16),
                                                            .foregroundColor: NSColor(RanchChipMotion.muted)])
    }
}

/// F puts the cursor in the search from anywhere on the page, unless a field is being typed in.
final class RanchSearchShortcut: ObservableObject {
    private var monitor: Any?

    func attach(_ open: @escaping () -> Void) {
        detach()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let plain = event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty
            guard plain, !event.isARepeat, event.charactersIgnoringModifiers?.lowercased() == "f",
                  event.window?.title == Ranch.title, !(event.window?.firstResponder is NSText) else { return event }
            open()
            return nil
        }
    }

    func detach() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    deinit { detach() }
}
