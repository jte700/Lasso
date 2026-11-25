// The tour's demos of writing and sharing. Autocomplete: words are typed in
// a document, Lasso's card offers values from the person's files, and Tab
// writes one in as a linked pill. Share: a pill is clicked, Share Source opens
// the composer, one cell is chosen and its link copied, and the page the
// recipient sees slides in.

import Cocoa
import SwiftUI

/// Where the documents' lines sit on the demo canvas.
private enum LoopDemoDoc {
    static let frame = CGRect(x: 10, y: 10, width: 380, height: 230)
    static let textX: CGFloat = 30
    static let lineY: [CGFloat] = [76, 102]
    static let size: CGFloat = 13
}

/// What one of Lasso's suggestions says: the file it is from, the words it
/// would write, and where in the file they are.
private struct LoopDemoSuggestion {
    let file: String
    let value: String
    let place: String
}

// MARK: Autocomplete

struct LoopAutocompleteDemo: View {
    let time: LoopDemoTime

    fileprivate struct Sentence {
        let typed: String
        let after: String
        let accepted: String
        let file: String
        let suggestions: [LoopDemoSuggestion]
        let typing: ClosedRange<Double>
        let offered: Double
        let tab: Double
    }

    private static let sentences = [
        Sentence(typed: "The main span is ", after: ".", accepted: "184 m", file: "deck-loads.xlsx",
                 suggestions: [.init(file: "deck-loads.xlsx", value: "184 m", place: "span_m, G7"),
                               .init(file: "summary.md", value: "184 metres", place: "Findings"),
                               .init(file: "General arrangement.pdf", value: "Main span 184 m", place: "p. 3")],
                 typing: 0.5...1.5, offered: 2.0, tab: 3.45),
        Sentence(typed: "The design live load is ", after: ".", accepted: "9.4 kN/m", file: "summary.md",
                 suggestions: [.init(file: "summary.md", value: "9.4 kN/m", place: "Methods"),
                               .init(file: "loads.xlsx", value: "9.4", place: "live_kN, B12"),
                               .init(file: "Design basis.pdf", value: "Live load 9.4 kN/m", place: "p. 7")],
                 typing: 4.2...5.4, offered: 5.8, tab: 7.05),
    ]

    var body: some View {
        ZStack(alignment: .topLeading) {
            LoopDemoWindow(title: "Bridge memo.docx") { LoopDemoParagraph() }
                .frame(width: LoopDemoDoc.frame.width, height: LoopDemoDoc.frame.height)
                .offset(x: LoopDemoDoc.frame.minX, y: LoopDemoDoc.frame.minY)
            ForEach(Array(Self.sentences.enumerated()), id: \.offset) { index, sentence in
                line(sentence, active: index == current)
                    .offset(x: LoopDemoDoc.textX, y: LoopDemoDoc.lineY[index])
                    .zIndex(time.span(sentence.offered, sentence.tab + 0.15) > 0 ? 2 : 1)
            }
            LoopDemoKey(label: "tab", pressed: Self.sentences.map { time.press($0.tab) }.max() ?? 0)
                .opacity(Self.sentences.map { time.span($0.tab - 0.5, $0.tab + 0.5, edge: 0.18) }.max() ?? 0)
                .offset(x: 322, y: 200)
                .zIndex(3)
        }
        .frame(width: LoopTourDemo.canvas.width, height: LoopTourDemo.canvas.height, alignment: .topLeading)
    }

    /// The sentence being written: the second once the first is done.
    private var current: Int { time.t < Self.sentences[1].typing.lowerBound - 0.3 ? 0 : 1 }

    private func line(_ sentence: Sentence, active: Bool) -> some View {
        let typing = time.ramp(sentence.typing.lowerBound, sentence.typing.upperBound, curve: .linear)
        let typed = String(sentence.typed.prefix(Int((Double(sentence.typed.count) * typing).rounded(.down))))
        let offered = time.span(sentence.offered, sentence.tab + 0.15, edge: 0.15)
        let accepted = time.ramp(sentence.tab + 0.12, sentence.tab + 0.42, curve: .back)
        let typingNow = time.t >= sentence.typing.lowerBound && time.t <= sentence.typing.upperBound
        return HStack(spacing: 0) {
            Text(typed)
            // The same views every frame, shown and hidden by opacity, so none is
            // taken out and put back as the demo runs; the slot is only as wide
            // as what it shows.
            ZStack(alignment: .leading) {
                // The highlighted suggestion's rest, written dim after the caret.
                Text(sentence.accepted)
                    .fixedSize()
                    .opacity(accepted > 0 ? 0 : 0.32 * offered)
                LoopDemoPill(text: sentence.accepted, file: sentence.file)
                    .fixedSize()
                    .scaleEffect(min(1.15, max(0.01, accepted)), anchor: .leading)
                    .opacity(accepted > 0 ? 1 : 0)
            }
            .frame(width: slot(sentence, offered: offered, accepted: accepted), height: 17, alignment: .leading)
            // The card floats under the caret without moving the words.
            .overlay(alignment: .topLeading) {
                LoopDemoSuggestionCard(suggestions: sentence.suggestions, tab: time.press(sentence.tab))
                    .opacity(offered)
                    .scaleEffect(0.94 + 0.06 * offered, anchor: .topLeading)
                    .fixedSize()
                    .offset(x: -14, y: 24)
                    .allowsHitTesting(false)
            }
            Text(accepted > 0.5 && time.t >= sentence.tab + 0.5 ? sentence.after : "")
            LoopDemoCaret(blinking: !typingNow, time: time)
                .opacity(active ? 1 : 0)
        }
        .font(LoopLook.font(LoopDemoDoc.size))
        .foregroundStyle(LoopTourLook.ink)
        .fixedSize()
    }
}

extension LoopAutocompleteDemo {
    /// How wide the space after the typed words is: nothing, the dim suggestion, or the pill.
    fileprivate func slot(_ sentence: Sentence, offered: Double, accepted: Double) -> CGFloat {
        if accepted > 0 { return LoopDemoText.width(sentence.accepted, size: LoopDemoDoc.size, weight: .medium) + 28 }
        if offered > 0 { return LoopDemoText.width(sentence.accepted, size: LoopDemoDoc.size) }
        return 0
    }
}

/// Lines of grey standing for what the document already says.
private struct LoopDemoParagraph: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach([300, 210], id: \.self) { width in
                Capsule().fill(LoopTourLook.ink.opacity(0.08)).frame(width: CGFloat(width), height: 6)
            }
        }
        .padding(.leading, 20)
        .padding(.top, 20)
    }
}

private struct LoopDemoCaret: View {
    let blinking: Bool
    let time: LoopDemoTime

    var body: some View {
        LoopTourLook.blue
            .frame(width: 1.5, height: 16)
            .opacity(!blinking || Int(time.t * 2.4) % 2 == 0 ? 1 : 0)
            .padding(.leading, 1)
    }
}

/// Words written from a source, drawn as a pill with the source's type, as Lasso draws them in other apps.
private struct LoopDemoPill: View {
    let text: String
    let file: String

    var body: some View {
        HStack(spacing: 3) {
            LoopFileIcon(url: nil, fileExtension: (file as NSString).pathExtension, size: 11)
            Text(text).font(LoopLook.font(LoopDemoDoc.size, .medium))
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(LoopLook.skySoft.opacity(0.75)))
        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(LoopTourLook.blue.opacity(0.35), lineWidth: 1))
        .padding(.horizontal, 1)
    }
}

/// Lasso's suggestion card, small: three suggestions, the first highlighted, and its keys.
private struct LoopDemoSuggestionCard: View {
    let suggestions: [LoopDemoSuggestion]
    /// The Tab key's press, shown on its keycap.
    let tab: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(suggestions.enumerated()), id: \.offset) { index, suggestion in
                HStack(spacing: 7) {
                    LoopFileIcon(url: nil, fileExtension: (suggestion.file as NSString).pathExtension, size: 14)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(suggestion.value).font(LoopLook.font(11.5, .medium)).foregroundStyle(.white)
                        Text("\(suggestion.file) \u{00B7} \(suggestion.place)")
                            .font(LoopLook.font(9)).foregroundStyle(Color.white.opacity(0.5))
                    }
                    .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .frame(height: 30)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.white.opacity(index == 0 ? 0.11 : 0)))
            }
            HStack(spacing: 5) {
                keycap("tab", pressed: tab)
                Text("Insert").foregroundStyle(Color.white.opacity(0.5))
                keycap("esc", pressed: 0).padding(.leading, 6)
                Text("Dismiss").foregroundStyle(Color.white.opacity(0.5))
                Spacer(minLength: 0)
            }
            .font(LoopLook.font(9))
            .padding(.horizontal, 8)
            .frame(height: 22)
        }
        .padding(4)
        .frame(width: 222)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(LoopLook.rgb(0x1E1E1C)))
        .shadow(color: .black.opacity(0.22), radius: 12, y: 6)
    }

    private func keycap(_ label: String, pressed: Double) -> some View {
        Text(label)
            .font(LoopLook.font(8.5, .medium)).foregroundStyle(Color.white.opacity(0.85))
            .padding(.horizontal, 4)
            .frame(height: 14)
            .background(RoundedRectangle(cornerRadius: 3.5, style: .continuous).fill(Color.white.opacity(0.14 + 0.3 * pressed)))
            .scaleEffect(1 - 0.12 * pressed)
    }
}

// MARK: Share

struct LoopShareDemo: View {
    let time: LoopDemoTime

    private static let lead = "The main span is "
    private static let composer = CGRect(x: 55, y: 34, width: 290, height: 182)
    private static let link = "mylasso.ca/s/7Kq2"
    // The moments it is driven through.
    private static let pillClick = 0.95
    private static let menuClick = 1.75
    private static let scopeClick = 2.6
    private static let copyClick = 3.4
    private static let copied = 3.55
    private static let away = 4.6
    private static let page = 4.85

    /// The middle of the pill the pointer clicks, worked out from the words before it.
    private var pill: CGPoint {
        let before = LoopDemoText.width(Self.lead, size: LoopDemoDoc.size)
        let width = LoopDemoText.width("184 m", size: LoopDemoDoc.size, weight: .medium) + 22
        return CGPoint(x: LoopDemoDoc.textX + before + width / 2, y: LoopDemoDoc.lineY[0] + 9)
    }

    private var menuOrigin: CGPoint { CGPoint(x: pill.x - 30, y: pill.y + 14) }

    private var pointer: LoopDemoPath {
        let start = CGPoint(x: 340, y: 226)
        let share = CGPoint(x: menuOrigin.x + 64, y: menuOrigin.y + 4 + 24 + 12)
        let scope = CGPoint(x: Self.composer.minX + 14 + 262 * 0.75, y: Self.composer.minY + 74)
        let copy = CGPoint(x: Self.composer.maxX - 56, y: Self.composer.maxY - 24)
        return LoopDemoPath(keys: [(0, start), (0.3, start), (0.85, pill), (1.15, pill), (1.6, share), (1.95, share),
                                    (2.45, scope), (2.75, scope), (3.25, copy), (3.7, copy), (4.3, CGPoint(x: 395, y: 248))])
    }

    var body: some View {
        let menu = time.span(Self.pillClick + 0.05, Self.menuClick + 0.1, edge: 0.12)
        let sheet = time.span(1.95, Self.away + 0.25, edge: 0.25)
        let shown = time.ramp(Self.page, Self.page + 0.55, curve: .out)
        ZStack(alignment: .topLeading) {
            LoopDemoWindow(title: "Bridge memo.docx") { LoopDemoParagraph() }
                .frame(width: LoopDemoDoc.frame.width, height: LoopDemoDoc.frame.height)
                .offset(x: LoopDemoDoc.frame.minX, y: LoopDemoDoc.frame.minY)
            sentence.offset(x: LoopDemoDoc.textX, y: LoopDemoDoc.lineY[0])
            LoopDemoReferenceMenu(highlight: time.ramp(1.5, 1.6))
                .opacity(menu)
                .scaleEffect(0.95 + 0.05 * menu, anchor: .topLeading)
                .offset(x: menuOrigin.x, y: menuOrigin.y)
            Color.black.opacity(0.12 * sheet)
                .frame(width: LoopDemoDoc.frame.width, height: LoopDemoDoc.frame.height)
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                .offset(x: LoopDemoDoc.frame.minX, y: LoopDemoDoc.frame.minY)
            composer
                .frame(width: Self.composer.width, height: Self.composer.height)
                .opacity(sheet)
                .scaleEffect(0.96 + 0.04 * sheet)
                .offset(x: Self.composer.minX, y: Self.composer.minY)
            LoopDemoSharedPage(link: Self.link)
                .frame(width: 292, height: 196)
                .opacity(shown)
                .offset(x: 66 + 250 * (1 - shown), y: 26)
            LoopDemoPointer(at: pointer.point(time), clicks: [Self.pillClick, Self.menuClick, Self.scopeClick, Self.copyClick],
                             time: time, opacity: 1 - time.ramp(4.0, 4.3))
        }
        .frame(width: LoopTourDemo.canvas.width, height: LoopTourDemo.canvas.height, alignment: .topLeading)
    }

    private var sentence: some View {
        HStack(spacing: 0) {
            Text(Self.lead)
            LoopDemoPill(text: "184 m", file: "deck-loads.xlsx")
                .brightness(time.span(Self.pillClick - 0.05, Self.pillClick + 0.2) * -0.06)
            Text(".")
        }
        .font(LoopLook.font(LoopDemoDoc.size))
        .foregroundStyle(LoopTourLook.ink)
        .fixedSize()
    }

    private var composer: some View {
        let scoped = time.ramp(Self.scopeClick, Self.scopeClick + 0.25)
        let done = time.t >= Self.copied
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 9) {
                LoopFileIcon(url: nil, fileExtension: "xlsx", size: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Share deck-loads.xlsx").font(LoopLook.font(12.5, .medium)).foregroundStyle(LoopTourLook.ink)
                    Text("Sheet 1, row G7, span_m").font(LoopLook.font(10)).foregroundStyle(LoopTourLook.ink3)
                }
            }
            LoopDemoScope(scoped: scoped)
            LoopDemoSheetPreview(scoped: scoped)
            HStack(spacing: 8) {
                Text(done ? Self.link : "Link not made yet")
                    .font(LoopLook.font(9.5)).foregroundStyle(done ? LoopTourLook.ink : LoopTourLook.ink3)
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(LoopTourLook.chip))
                HStack(spacing: 4) {
                    if done { Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)) }
                    Text(done ? "Copied" : "Copy Link")
                }
                .font(LoopLook.font(11, .semibold)).foregroundStyle(.white)
                .frame(width: 84, height: 26)
                .background(Capsule().fill(done ? LoopTourLook.green : LoopTourLook.ink))
                .scaleEffect(1 - 0.07 * time.press(Self.copyClick))
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white))
        .shadow(color: .black.opacity(0.16), radius: 18, y: 8)
    }
}

/// The menu a pill opens: Inspect Source, Share Source and Change Source.
private struct LoopDemoReferenceMenu: View {
    /// How far Share Source is highlighted.
    let highlight: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(["Inspect Source", "Share Source\u{2026}", "Change Source"].enumerated()), id: \.offset) { index, title in
                Text(title)
                    .font(LoopLook.font(11))
                    .foregroundStyle(index == 1 && highlight > 0.5 ? Color.white : LoopTourLook.ink)
                    .padding(.horizontal, 8)
                    .frame(width: 136, height: 24, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(LoopTourLook.blue.opacity(index == 1 ? highlight : 0)))
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.white))
        .shadow(color: .black.opacity(0.16), radius: 10, y: 4)
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(LoopTourLook.line, lineWidth: 0.5))
    }
}

/// Whole file or just this cell, the thumb sliding to the cell as it is chosen.
private struct LoopDemoScope: View {
    let scoped: Double

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(LoopTourLook.chip)
            Capsule().fill(Color.white)
                .shadow(color: .black.opacity(0.1), radius: 2, y: 1)
                .frame(width: 127)
                .offset(x: 3 + 129 * scoped)
            HStack(spacing: 0) {
                Text("Whole file").frame(maxWidth: .infinity)
                    .foregroundStyle(LoopTourLook.ink.opacity(1 - 0.45 * scoped))
                Text("Just this cell").frame(maxWidth: .infinity)
                    .foregroundStyle(LoopTourLook.ink.opacity(0.55 + 0.45 * scoped))
            }
            .font(LoopLook.font(11, .medium))
        }
        .frame(width: 262, height: 28)
    }
}

/// Three rows of the sheet; choosing just the cell greys out the rest.
private struct LoopDemoSheetPreview: View {
    let scoped: Double

    private static let rows = [["G6", "182", "441"], ["G7", "184", "449"], ["G8", "186", "457"]]

    var body: some View {
        VStack(spacing: 2) {
            ForEach(Array(Self.rows.enumerated()), id: \.offset) { row, values in
                HStack(spacing: 2) {
                    ForEach(Array(values.enumerated()), id: \.offset) { column, value in
                        let cited = row == 1 && column == 1
                        Text(value)
                            .font(LoopLook.font(9.5, cited ? .medium : .regular))
                            .foregroundStyle(LoopTourLook.ink.opacity(cited ? 1 : 0.7 * (1 - 0.8 * scoped)))
                            .frame(maxWidth: .infinity, minHeight: 15)
                            .background(RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .fill(cited ? LoopLook.skySoft.opacity(0.4 + 0.5 * scoped) : LoopTourLook.chip))
                    }
                }
            }
        }
        .frame(width: 262)
    }
}

/// The page the person the link was sent to opens: just the cell, and where it came from.
private struct LoopDemoSharedPage: View {
    let link: String

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach([0xF26A5E, 0xF5BF4F, 0x62C554], id: \.self) { hex in
                    Circle().fill(LoopLook.rgb(hex)).frame(width: 7, height: 7)
                }
                HStack(spacing: 4) {
                    Image(systemName: "lock.fill").font(.system(size: 7))
                    Text(link).font(LoopLook.font(9.5))
                }
                .foregroundStyle(LoopTourLook.ink2)
                .padding(.horizontal, 10)
                .frame(height: 18)
                .background(Capsule().fill(LoopTourLook.chip))
                .frame(maxWidth: .infinity)
                Spacer().frame(width: 24)
            }
            .padding(.horizontal, 10)
            .frame(height: 28)
            LoopTourLook.line.frame(height: 1)
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    LoopFileIcon(url: nil, fileExtension: "xlsx", size: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("deck-loads.xlsx").font(LoopLook.font(12.5, .medium)).foregroundStyle(LoopTourLook.ink)
                        Text("Shared with you \u{00B7} one cell").font(LoopLook.font(10)).foregroundStyle(LoopTourLook.ink3)
                    }
                }
                VStack(spacing: 2) {
                    cells(["member", "span_m", "dead_kN"], header: true)
                    cells(["", "", ""], header: false)
                    cells(["G7", "184", ""], header: false, cited: 1)
                    cells(["", "", ""], header: false)
                }
                Text("Sheet 1, row G7 \u{00B7} shared from Lasso")
                    .font(LoopLook.font(9.5)).foregroundStyle(LoopTourLook.ink3)
            }
            .padding(14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color.white))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
    }

    private func cells(_ values: [String], header: Bool, cited: Int? = nil) -> some View {
        HStack(spacing: 2) {
            ForEach(Array(values.enumerated()), id: \.offset) { column, value in
                let shown = header ? column == 1 : !value.isEmpty
                Text(shown ? value : "")
                    .font(LoopLook.font(9.5, column == cited ? .medium : .regular))
                    .foregroundStyle(header ? LoopTourLook.ink3 : LoopTourLook.ink)
                    .frame(maxWidth: .infinity, minHeight: 16)
                    .background(RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(column == cited ? LoopLook.skySoft.opacity(0.9) : shown && !header ? LoopTourLook.chip
                              : LoopTourLook.ink.opacity(header ? 0 : 0.035)))
            }
        }
    }
}
