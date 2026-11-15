// How each kind of text document looks in the passage picker. The text is
// never changed, only dressed, so a highlight still maps to it exactly:
// Markdown keeps its markers (dimmed) under rendered headings, code and
// emphasis; a Word document is set in a document face; a text file is
// fixed-width; a deck's and a transcript's labels sit back.

import Cocoa

enum PassageTextStyling {
    static func styled(_ document: PassageDocument, look: PassageTextLook) -> NSAttributedString {
        let styled: NSMutableAttributedString
        switch look {
        case .page: styled = page(document)
        case .markdown: styled = markdown(document.text)
        case .plain: styled = plain(document.text)
        case .slides, .transcript: styled = outline(document, look: look)
        }
        if document.truncated {
            styled.append(NSAttributedString(string: "\n\nThe rest of this file is too long to show here.",
                attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.tertiaryLabelColor]))
        }
        return styled
    }

    private static func paragraph(lineSpacing: CGFloat, after: CGFloat) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = lineSpacing
        style.paragraphSpacing = after
        return style
    }

    /// A transcript or a deck's outline: the words in the system face, labels dimmed, slide titles bold.
    private static func outline(_ document: PassageDocument, look: PassageTextLook) -> NSMutableAttributedString {
        let styled = NSMutableAttributedString(string: document.text, attributes: [
            .font: NSFont.systemFont(ofSize: 13.5), .foregroundColor: NSColor.labelColor,
            .paragraphStyle: paragraph(lineSpacing: 3, after: look == .transcript ? 6 : 3)])
        let length = styled.length
        for heading in document.headings where NSMaxRange(heading) <= length {
            styled.addAttribute(.font, value: NSFont.systemFont(ofSize: 16, weight: .semibold), range: heading)
        }
        let label = look == .transcript ? NSFont.monospacedDigitSystemFont(ofSize: 11.5, weight: .medium)
            : NSFont.systemFont(ofSize: 11, weight: .semibold)
        for range in document.decorations where NSMaxRange(range) <= length {
            styled.addAttributes([.foregroundColor: NSColor.secondaryLabelColor, .font: label], range: range)
        }
        return styled
    }

    /// The face a Word document is most likely set in, of those on this Mac.
    static func documentFont(size: CGFloat, bold: Bool = false) -> NSFont {
        for name in ["Aptos", "Calibri", "Helvetica Neue"] {
            if let font = NSFont(name: name, size: size) {
                return bold ? NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask) : font
            }
        }
        return bold ? NSFont.boldSystemFont(ofSize: size) : NSFont.systemFont(ofSize: size)
    }

    /// A Word document in the face it is most likely set in, headings larger, in the system's ink.
    private static func page(_ document: PassageDocument) -> NSMutableAttributedString {
        let styled = NSMutableAttributedString(string: document.text, attributes: [
            .font: documentFont(size: 13), .foregroundColor: NSColor.labelColor,
            .paragraphStyle: paragraph(lineSpacing: 2.5, after: 2)])
        let length = styled.length
        for heading in document.headings where NSMaxRange(heading) <= length {
            styled.addAttribute(.font, value: documentFont(size: 16, bold: true), range: heading)
        }
        return styled
    }

    /// A text file as a text editor shows it, in the fixed-width face.
    private static func plain(_ text: String) -> NSMutableAttributedString {
        NSMutableAttributedString(string: text, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: NSColor.labelColor,
            .paragraphStyle: paragraph(lineSpacing: 2.5, after: 0)])
    }

    private static let inlineCode = try! NSRegularExpression(pattern: "`[^`\\n]+`")
    private static let strong = try! NSRegularExpression(pattern: "(\\*\\*|__)(?=\\S)(.+?)(?<=\\S)\\1")
    private static let emphasis = try! NSRegularExpression(pattern: "(?<![*\\w])([*_])(?=\\S)([^*_\\n]+?)(?<=\\S)\\1(?![*\\w])")
    private static let heading = try! NSRegularExpression(pattern: "^(#{1,6})\\s+")
    private static let listMarker = try! NSRegularExpression(pattern: "^\\s*(?:[-*+]|\\d+[.)])\\s+")

    /// Markdown as a reader shows it, its own markers kept but dimmed.
    private static func markdown(_ text: String) -> NSMutableAttributedString {
        let body = NSFont.systemFont(ofSize: 13.5)
        let code = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        let dim = NSColor.tertiaryLabelColor
        let styled = NSMutableAttributedString(string: text, attributes: [
            .font: body, .foregroundColor: NSColor.labelColor, .paragraphStyle: paragraph(lineSpacing: 3, after: 4)])
        let whole = text as NSString
        var inFence = false
        whole.enumerateSubstrings(in: NSRange(location: 0, length: whole.length), options: [.byLines, .substringNotRequired]) { _, line, _, _ in
            let content = whole.substring(with: line)
            if content.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                inFence.toggle()
                styled.addAttributes([.font: code, .foregroundColor: dim], range: line)
                return
            }
            if inFence {
                styled.addAttributes([.font: code, .backgroundColor: NSColor.quaternaryLabelColor.withAlphaComponent(0.25)], range: line)
                return
            }
            let local = NSRange(location: 0, length: (content as NSString).length)
            if let match = heading.firstMatch(in: content, range: local) {
                let level = match.range(at: 1).length
                let size: CGFloat = [22, 18.5, 16, 14.5, 13.5, 13.5][min(level, 6) - 1]
                styled.addAttribute(.font, value: NSFont.systemFont(ofSize: size, weight: level <= 2 ? .bold : .semibold), range: line)
                styled.addAttribute(.foregroundColor, value: dim, range: NSRange(location: line.location, length: match.range.length))
                return
            }
            if content.hasPrefix(">") {
                styled.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor, range: line)
            }
            if let marker = listMarker.firstMatch(in: content, range: local) {
                styled.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor,
                                    range: NSRange(location: line.location, length: marker.range.length))
            }
            for match in strong.matches(in: content, range: local) {
                styled.addAttribute(.font, value: NSFont.systemFont(ofSize: 13.5, weight: .semibold), range: shifted(match.range, line))
                dimMarkers(match, styled, line, dim)
            }
            for match in emphasis.matches(in: content, range: local) {
                styled.addAttribute(.font, value: NSFontManager.shared.convert(body, toHaveTrait: .italicFontMask), range: shifted(match.range, line))
                dimMarkers(match, styled, line, dim)
            }
            for match in inlineCode.matches(in: content, range: local) {
                styled.addAttributes([.font: code, .backgroundColor: NSColor.quaternaryLabelColor.withAlphaComponent(0.3)],
                                     range: shifted(match.range, line))
            }
        }
        return styled
    }

    private static func shifted(_ range: NSRange, _ line: NSRange) -> NSRange {
        NSRange(location: line.location + range.location, length: range.length)
    }

    /// The `**` or `_` around emphasised words, dimmed.
    private static func dimMarkers(_ match: NSTextCheckingResult, _ styled: NSMutableAttributedString, _ line: NSRange, _ dim: NSColor) {
        let marker = match.range(at: 1).length
        styled.addAttribute(.foregroundColor, value: dim, range: NSRange(location: line.location + match.range.location, length: marker))
        styled.addAttribute(.foregroundColor, value: dim, range: NSRange(location: line.location + NSMaxRange(match.range) - marker, length: marker))
    }
}
