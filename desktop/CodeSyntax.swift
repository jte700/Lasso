// Colours for code: keywords, strings, numbers, comments, types, calls and
// the names a line declares, as Xcode's default themes draw them. The
// languages and colours are public/code-syntax.json, which the server's
// source inspector reads too (public/code-syntax.js), so a file looks alike in
// The Ranch, the suggestion card and the inspector. Both read text as UTF-16
// code units, step for step alike, and must agree on every token;
// test/fixtures/code-syntax-cases.json holds them to it.

import Cocoa

enum CodeTokenKind: String, CaseIterable {
    case comment, string, number, keyword, type, function, variable, directive
}

/// A coloured stretch of code, in UTF-16 offsets. Text between tokens is plain.
struct CodeToken: Equatable {
    let range: NSRange
    let kind: CodeTokenKind
}

/// The languages Lasso colours, and the colour of each kind of token.
struct CodeSyntax {
    let languages: [CodeLanguage]
    let palette: CodePalette

    /// The copy bundled with the server's files in Lasso.app, read once.
    static let bundled: CodeSyntax? = {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("app/public/code-syntax.json") else { return nil }
        do {
            return try CodeSyntax(data: Data(contentsOf: url))
        } catch {
            NSLog("Lasso: code is shown without colours, as %@ could not be read: %@", url.path, error.localizedDescription)
            return nil
        }
    }()

    init(data: Data) throws {
        let catalog = try JSONDecoder().decode(Catalog.self, from: data)
        languages = catalog.languages.map(CodeLanguage.init)
        palette = CodePalette(colors: Dictionary(uniqueKeysWithValues: catalog.colors.compactMap { name, color in
            CodeTokenKind(rawValue: name).map { ($0, color) }
        }))
    }

    /// The language a file is written in, from its name or extension, or nil
    /// for prose and data Lasso doesn't colour.
    func language(forFileName fileName: String) -> CodeLanguage? {
        let name = (fileName.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? "").lowercased()
        let extensionName = name.lastIndex(of: ".").map { String(name[name.index(after: $0)...]) } ?? ""
        return languages.first { $0.fileNames.contains(name) }
            ?? (extensionName.isEmpty ? nil : languages.first { $0.extensions.contains(extensionName) })
    }

    fileprivate struct Catalog: Decodable {
        struct Delimiter: Decodable {
            let delimiter: String
            let multiline: Bool?
            let raw: Bool?
        }

        struct Definition: Decodable {
            let name: String
            let extensions: [String]
            let fileNames: [String]?
            let lineComments: [String]?
            let blockComments: [[String]]?
            let strings: [Delimiter]?
            let stringPrefixes: String?
            let keywords: String?
            let types: String?
            let typesAfter: String?
            let declarators: String?
            let capitalizedTypes: Bool?
            let ignoreCase: Bool?
            let identifierSymbols: String?
            let attributePrefixes: [String]?
            let directiveLines: [String]?
            let variablePrefixes: [String]?
            let keySeparators: [String]?
            let markup: Bool?
        }

        let colors: [String: CodeColor]
        let languages: [Definition]
    }
}

/// One kind of token's colour in light and dark, as "#RRGGBB".
struct CodeColor: Decodable, Equatable {
    let light: String
    let dark: String
    let bold: Bool?
}

/// The colour of each kind of token.
struct CodePalette: Equatable {
    let colors: [CodeTokenKind: CodeColor]

    /// The colour for `kind`, following the appearance it is drawn in.
    func color(for kind: CodeTokenKind) -> NSColor {
        guard let color = colors[kind], let light = NSColor(hex: color.light), let dark = NSColor(hex: color.dark) else {
            return .labelColor
        }
        return NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
        }
    }

    /// Colours `tokens` in `text`, whose plain characters are already set in
    /// `font`. Keywords are set in the same face at a heavier weight.
    func apply(_ tokens: [CodeToken], to text: NSMutableAttributedString, font: NSFont) {
        let shown = Dictionary(uniqueKeysWithValues: CodeTokenKind.allCases.map { ($0, color(for: $0)) })
        let heavy = NSFont.monospacedSystemFont(ofSize: font.pointSize, weight: .semibold)
        let length = text.length
        text.beginEditing()
        for token in tokens where NSMaxRange(token.range) <= length {
            text.addAttribute(.foregroundColor, value: shown[token.kind] ?? NSColor.labelColor, range: token.range)
            if colors[token.kind]?.bold == true { text.addAttribute(.font, value: heavy, range: token.range) }
        }
        text.endEditing()
    }
}

private extension NSColor {
    /// "#RRGGBB".
    convenience init?(hex: String) {
        guard hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                  blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }
}

/// One language's rules, as code-syntax.json gives them, ready to read text with.
struct CodeLanguage {
    struct Delimiter {
        let units: [UInt16]
        let multiline: Bool
        let raw: Bool
    }

    let name: String
    let extensions: Set<String>
    let fileNames: Set<String>
    fileprivate let lineComments: [[UInt16]]
    fileprivate let blockComments: [(open: [UInt16], close: [UInt16])]
    fileprivate let strings: [Delimiter]
    fileprivate let stringPrefixes: Set<UInt16>
    fileprivate let keywords: Set<String>
    fileprivate let types: Set<String>
    fileprivate let typesAfter: Set<UInt16>
    fileprivate let declarators: Set<String>
    fileprivate let capitalizedTypes: Bool
    fileprivate let ignoreCase: Bool
    fileprivate let identifierSymbols: Set<UInt16>
    fileprivate let attributePrefixes: [[UInt16]]
    fileprivate let directiveLines: [[UInt16]]
    fileprivate let variablePrefixes: [[UInt16]]
    fileprivate let keySeparators: Set<UInt16>
    fileprivate let markup: Bool

    fileprivate init(_ definition: CodeSyntax.Catalog.Definition) {
        let ignoreCase = definition.ignoreCase == true
        func words(_ list: String?) -> Set<String> {
            Set((list ?? "").split(whereSeparator: \.isWhitespace).map { ignoreCase ? $0.lowercased() : String($0) })
        }
        func units(_ text: String) -> [UInt16] { Array(text.utf16) }
        name = definition.name
        extensions = Set(definition.extensions)
        fileNames = Set(definition.fileNames ?? [])
        lineComments = (definition.lineComments ?? []).map(units)
        blockComments = (definition.blockComments ?? []).compactMap { pair in
            pair.count == 2 ? (units(pair[0]), units(pair[1])) : nil
        }
        // Longest first, so """ is not read as an empty "" and a quote.
        strings = (definition.strings ?? [])
            .map { Delimiter(units: units($0.delimiter), multiline: $0.multiline == true, raw: $0.raw == true) }
            .sorted { $0.units.count > $1.units.count }
        stringPrefixes = Set((definition.stringPrefixes ?? "").utf16)
        keywords = words(definition.keywords)
        types = words(definition.types)
        typesAfter = Set((definition.typesAfter ?? "").utf16)
        declarators = words(definition.declarators)
        capitalizedTypes = definition.capitalizedTypes == true
        self.ignoreCase = ignoreCase
        identifierSymbols = Set((definition.identifierSymbols ?? "").utf16)
        attributePrefixes = (definition.attributePrefixes ?? []).map(units)
        directiveLines = (definition.directiveLines ?? []).map(units)
        variablePrefixes = (definition.variablePrefixes ?? []).map(units).sorted { $0.count > $1.count }
        keySeparators = Set((definition.keySeparators ?? []).joined().utf16)
        markup = definition.markup == true
    }

    /// The coloured stretches of `text`, in order and never overlapping.
    func tokens(in text: String) -> [CodeToken] {
        var reader = CodeReader(units: Array(text.utf16), language: self)
        return reader.read()
    }

    /// Each line's tokens, with offsets into that line. The lines are read as
    /// one text, so a comment or string that spans lines colours every line it covers.
    func lineTokens(_ lines: [String]) -> [[CodeToken]] {
        let tokens = self.tokens(in: lines.joined(separator: "\n"))
        var result: [[CodeToken]] = []
        var offset = 0
        var index = 0
        for line in lines {
            let end = offset + line.utf16.count
            var own: [CodeToken] = []
            while index < tokens.count, tokens[index].range.location < end {
                let token = tokens[index]
                let start = max(token.range.location, offset)
                let stop = min(NSMaxRange(token.range), end)
                if stop > start { own.append(CodeToken(range: NSRange(location: start - offset, length: stop - start), kind: token.kind)) }
                if NSMaxRange(token.range) > end { break }
                index += 1
            }
            result.append(own)
            offset = end + 1
        }
        return result
    }
}

private enum Unit {
    static let newline: UInt16 = 10
    static let tab: UInt16 = 9
    static let carriageReturn: UInt16 = 13
    static let space: UInt16 = 32
    static let dollar: UInt16 = 36
    static let paren: UInt16 = 40
    static let star: UInt16 = 42
    static let plus: UInt16 = 43
    static let minus: UInt16 = 45
    static let dot: UInt16 = 46
    static let zero: UInt16 = 48
    static let less: UInt16 = 60
    static let greater: UInt16 = 62
    static let backslash: UInt16 = 92
    static let brace: UInt16 = 123
    static let closeParen: UInt16 = 41
    static let closeBrace: UInt16 = 125
    /// `{ , - ( ;`, which with a line's start may come before a key.
    static let keyOpeners: Set<UInt16> = [123, 44, 45, 40, 59]
    /// `/`, `!` and `?`, which may follow a tag's `<`.
    static let tagMarks: Set<UInt16> = [47, 33, 63]

    static func isDigit(_ unit: UInt16?) -> Bool { unit.map { $0 >= 48 && $0 <= 57 } ?? false }

    /// Letters, `_`, and anything past ASCII, so a name in any script stays whole.
    static func isLetter(_ unit: UInt16?) -> Bool {
        guard let unit else { return false }
        return (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) || unit == 95 || unit >= 128
    }

    static func isSpace(_ unit: UInt16?) -> Bool { unit == space || unit == tab || unit == carriageReturn }
}

/// Reads one text from start to end, noting what each stretch is. Mirrors
/// CodeReader in public/code-syntax.js; a missing unit (past either end) is nil
/// where the script's is -1.
private struct CodeReader {
    let units: [UInt16]
    let language: CodeLanguage
    private var tokens: [CodeToken] = []
    /// After `def`, `let mut` or `export function`, the next name is the one declared.
    private var declaring = false
    /// In markup, between a tag's `<` and `>`.
    private var inTag = false

    init(units: [UInt16], language: CodeLanguage) {
        self.units = units
        self.language = language
    }

    mutating func read() -> [CodeToken] {
        var index = 0
        var lineStart = true
        while index < units.count {
            let unit = units[index]
            if unit == Unit.newline { lineStart = true; declaring = false; index += 1; continue }
            if Unit.isSpace(unit) { index += 1; continue }
            let firstOnLine = lineStart
            lineStart = false
            index = comment(index) ?? directive(index, firstOnLine: firstOnLine) ?? string(index)
                ?? (language.markup ? markup(index) : code(index))
        }
        return tokens
    }

    private mutating func code(_ index: Int) -> Int {
        variable(index) ?? attribute(index) ?? number(index) ?? word(index) ?? punctuation(index)
    }

    private mutating func comment(_ index: Int) -> Int? {
        if let block = language.blockComments.first(where: { starts(with: $0.open, at: index) }) {
            let close = find(block.close, from: index + block.open.count)
            return push(index, close.map { $0 + block.close.count } ?? units.count, .comment)
        }
        return language.lineComments.contains { starts(with: $0, at: index) } ? push(index, endOfLine(index), .comment) : nil
    }

    private mutating func directive(_ index: Int, firstOnLine: Bool) -> Int? {
        firstOnLine && language.directiveLines.contains { starts(with: $0, at: index) }
            ? push(index, endOfLine(index), .directive) : nil
    }

    private mutating func string(_ index: Int) -> Int? {
        // In markup, quotes are strings only inside a tag; between tags they are prose.
        if language.markup && !inTag { return nil }
        guard let delimiter = string(at: index) else { return nil }
        let end = scanString(index, delimiter)
        return push(index, end, isKey(index, end) ? .variable : .string)
    }

    private mutating func markup(_ index: Int) -> Int {
        let current = unit(index)
        if current == Unit.less {
            let start = index + (unit(index + 1).map(Unit.tagMarks.contains) == true ? 2 : 1)
            if Unit.isLetter(unit(start)) {
                inTag = true
                return push(start, scanName(start), .keyword)
            }
        } else if current == Unit.greater {
            inTag = false
        } else if inTag && Unit.isLetter(current) {
            return push(index, scanName(index), .variable)
        }
        return index + 1
    }

    /// `$name`, `${name}`, `$(name)`, `@ivar`: the whole reference.
    private mutating func variable(_ index: Int) -> Int? {
        guard let prefix = language.variablePrefixes.first(where: { starts(with: $0, at: index) }) else { return nil }
        let after = index + prefix.count
        let open = unit(after)
        if open == Unit.brace || open == Unit.paren {
            let close = find([open == Unit.brace ? Unit.closeBrace : Unit.closeParen], from: after)
            let line = endOfLine(after)
            return push(index, close.map { $0 > line ? line : $0 + 1 } ?? line, .variable)
        }
        return isIdentifier(open) ? push(index, scanName(after), .variable) : nil
    }

    /// `@dataclass`, `@functools.wraps`, `#selector`.
    private mutating func attribute(_ index: Int) -> Int? {
        guard let prefix = language.attributePrefixes.first(where: { starts(with: $0, at: index) }),
              isIdentifierStart(unit(index + prefix.count)) else { return nil }
        var end = index + prefix.count
        while isIdentifier(unit(end)) || (unit(end) == Unit.dot && isIdentifierStart(unit(end + 1))) { end += 1 }
        return push(index, end, .directive)
    }

    /// 42, 3.5, .5, 1_000, 0xFF, 1e-9, 640px.
    private mutating func number(_ index: Int) -> Int? {
        let current = unit(index)
        guard Unit.isDigit(current)
                || (current == Unit.dot && Unit.isDigit(unit(index + 1)) && !isIdentifier(previous(index))) else { return nil }
        let hex = current == Unit.zero && unit(index + 1).map { $0 | 32 } == 120   // 0x or 0X
        var end = index + 1
        var dotted = current == Unit.dot
        while end < units.count {
            let next = units[end]
            if Unit.isLetter(next) || Unit.isDigit(next) { end += 1; continue }
            if next == Unit.dot && !dotted && Unit.isDigit(unit(end + 1)) { dotted = true; end += 1; continue }
            // An exponent's sign: 1e-9, 2.5E+3.
            let exponent = unit(end - 1).map { $0 | 32 } == 101
            if (next == Unit.plus || next == Unit.minus) && exponent && !hex && Unit.isDigit(unit(end + 1)) { end += 1; continue }
            break
        }
        return push(index, end, .number)
    }

    private mutating func word(_ index: Int) -> Int? {
        guard isIdentifierStart(unit(index)) else { return nil }
        let end = scanName(index + 1)
        // Python's f"…" and r'…': the prefix belongs to the string.
        if let prefixed = stringPrefix(index, end) {
            declaring = false
            return push(index, scanString(end, prefixed), .string)
        }
        if let kind = classify(index, end) { push(index, end, kind) }
        return end
    }

    private mutating func classify(_ index: Int, _ end: Int) -> CodeTokenKind? {
        let word = String(decoding: units[index..<end], as: UTF16.self)
        let lookup = language.ignoreCase ? word.lowercased() : word
        let kind: CodeTokenKind?
        if isKey(index, end) {
            kind = .variable
        } else if previous(index) != Unit.dot && language.keywords.contains(lookup) {
            // After a dot it is a member, such as `.type` or `.get()`, never a keyword.
            kind = .keyword
        } else if declaring {
            kind = .variable
        } else if isBuiltinType(lookup, index) || (language.capitalizedTypes && isCapitalized(index, end)) {
            kind = .type
        } else if nextSolid(end) == Unit.paren {
            kind = .function
        } else {
            kind = nil
        }
        declaring = kind == .keyword && (declaring || language.declarators.contains(lookup))
        return kind
    }

    private mutating func punctuation(_ index: Int) -> Int {
        // `function* name` still declares `name`.
        if unit(index) != Unit.star { declaring = false }
        return index + 1
    }

    private func unit(_ at: Int) -> UInt16? { at >= 0 && at < units.count ? units[at] : nil }

    private func previous(_ index: Int) -> UInt16? { index > 0 ? unit(index - 1) : Unit.newline }

    private func starts(with prefix: [UInt16], at index: Int) -> Bool {
        guard !prefix.isEmpty, index + prefix.count <= units.count else { return false }
        return units[index..<(index + prefix.count)].elementsEqual(prefix)
    }

    private func find(_ needle: [UInt16], from start: Int) -> Int? {
        var index = start
        while index + needle.count <= units.count {
            if starts(with: needle, at: index) { return index }
            index += 1
        }
        return nil
    }

    @discardableResult
    private mutating func push(_ start: Int, _ end: Int, _ kind: CodeTokenKind) -> Int {
        if end > start { tokens.append(CodeToken(range: NSRange(location: start, length: end - start), kind: kind)) }
        return end
    }

    private func endOfLine(_ at: Int) -> Int { find([Unit.newline], from: at) ?? units.count }

    private func isIdentifierStart(_ unit: UInt16?) -> Bool {
        Unit.isLetter(unit) || (unit == Unit.dollar && language.identifierSymbols.contains(Unit.dollar))
    }

    private func isIdentifier(_ unit: UInt16?) -> Bool {
        Unit.isLetter(unit) || Unit.isDigit(unit) || unit.map(language.identifierSymbols.contains) == true
    }

    private func scanName(_ at: Int) -> Int {
        var end = at
        while isIdentifier(unit(end)) { end += 1 }
        return end
    }

    private func isCapitalized(_ start: Int, _ end: Int) -> Bool {
        (65...90).contains(units[start]) && units[start..<end].contains { (97...122).contains($0) }
    }

    private func string(at index: Int) -> CodeLanguage.Delimiter? {
        language.strings.first { starts(with: $0.units, at: index) }
    }

    private func stringPrefix(_ index: Int, _ end: Int) -> CodeLanguage.Delimiter? {
        guard end - index <= 2, units[index..<end].allSatisfy(language.stringPrefixes.contains) else { return nil }
        return string(at: end)
    }

    private func scanString(_ at: Int, _ delimiter: CodeLanguage.Delimiter) -> Int {
        var index = at + delimiter.units.count
        while index < units.count {
            let current = units[index]
            if current == Unit.backslash && !delimiter.raw { index += 2; continue }
            if starts(with: delimiter.units, at: index) { return index + delimiter.units.count }
            if current == Unit.newline && !delimiter.multiline { return index }
            index += 1
        }
        return units.count
    }

    /// The next character on this line that isn't a space, or nil at its end.
    private func nextSolid(_ at: Int) -> UInt16? {
        var index = at
        while Unit.isSpace(unit(index)) { index += 1 }
        return unit(index) == Unit.newline ? nil : unit(index)
    }

    /// The character before `at` on its line that isn't a space, or nil at the line's start.
    private func previousSolid(_ at: Int) -> UInt16? {
        var index = at
        while Unit.isSpace(unit(index - 1)) { index -= 1 }
        return unit(index - 1) == Unit.newline ? nil : unit(index - 1)
    }

    /// `string` in `name: string`, but not `number` the variable where the language says where types go.
    private func isBuiltinType(_ lookup: String, _ index: Int) -> Bool {
        guard language.types.contains(lookup) else { return false }
        return language.typesAfter.isEmpty || previousSolid(index).map(language.typesAfter.contains) == true
    }

    /// A name that starts a line, an entry or a declaration, followed by `:` or `=`.
    private func isKey(_ start: Int, _ end: Int) -> Bool {
        guard let separator = nextSolid(end), language.keySeparators.contains(separator) else { return false }
        return previousSolid(start).map(Unit.keyOpeners.contains) ?? true
    }
}
