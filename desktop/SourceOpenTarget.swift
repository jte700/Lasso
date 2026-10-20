//  Where "Open file" lands, and how the source's own app is asked to go there.
//
//  The server reports the place a preview cites as `openAt`: a worksheet and
//  its physical cell, a PDF page, or a text line. The planner turns that place
//  into one step for the app macOS opens the file with: a script, an editor's
//  line link, or Preview's Go to Page. The file always opens first, so a jump
//  the app or the user refuses still leaves the source open.

import Foundation

/// The cited place in a source. Every field is optional because each kind of
/// file has its own: a sheet and cell, a page, or a line and its words.
struct AssistOpenTarget: Equatable {
    var sheet: String? = nil
    /// One A1 cell, such as "C27".
    var cell: String? = nil
    var page: Int? = nil
    var line: Int? = nil
    /// The cited words, for apps that can only find text (Word).
    var text: String? = nil
    /// Which match of `text` is the cited one, counting from the start.
    var occurrence: Int? = nil

    private static let maximumPage = 1_000_000
    private static let maximumLine = 100_000_000
    private static let maximumSheetLength = 255
    private static let maximumTextLength = 1_200
    private static let maximumOccurrence = 10_000

    init(sheet: String? = nil, cell: String? = nil, page: Int? = nil, line: Int? = nil,
         text: String? = nil, occurrence: Int? = nil) {
        self.sheet = sheet
        self.cell = cell
        self.page = page
        self.line = line
        self.text = text
        self.occurrence = occurrence
    }

    /// Reads the server's `openAt`. Malformed values are dropped, and nil means
    /// no usable place, so the file opens as it would without one.
    init?(json: Any?) {
        guard let json = json as? [String: Any] else { return nil }
        cell = (json["cell"] as? String).flatMap { Self.isCell($0) ? $0 : nil }
        page = Self.integer(json["page"], maximum: Self.maximumPage)
        line = Self.integer(json["line"], maximum: Self.maximumLine)
        text = (json["text"] as? String).map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maximumTextLength)) }
            .flatMap { $0.isEmpty ? nil : $0 }
        occurrence = Self.integer(json["occurrence"], maximum: Self.maximumOccurrence)
        guard cell != nil || page != nil || line != nil || text != nil else { return nil }
        sheet = (json["sheet"] as? String).flatMap { name in
            let valid = !name.isEmpty && name.count <= Self.maximumSheetLength
                && !name.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
            return valid ? name : nil
        }
    }

    private static func isCell(_ value: String) -> Bool {
        value.range(of: "^[A-Z]{1,3}[1-9][0-9]{0,6}$", options: .regularExpression) != nil
    }

    private static func integer(_ value: Any?, maximum: Int) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == number.doubleValue.rounded(),
              number.intValue >= 1, number.intValue <= maximum else { return nil }
        return number.intValue
    }
}

extension AssistDocumentPreview {
    /// A PDF card can follow its cited text to a later page than the indexed
    /// one, and Open file lands on the page the card shows.
    var openTargetAsShown: AssistOpenTarget? {
        guard let shownPage = pdfPage?.pageNumber else { return openTarget }
        var target = openTarget ?? AssistOpenTarget()
        target.page = shownPage
        return target
    }
}

/// Scripts sent to the apps that open sources. Each reads its file, sheet,
/// cell or words from its arguments; nothing is spliced into the source.
enum AssistOpenScript: String, CaseIterable {
    case excel, numbers, word, acrobat, adobeReader

    /// The app each script addresses.
    var appBundleID: String {
        switch self {
        case .excel: return "com.microsoft.Excel"
        case .numbers: return "com.apple.iWork.Numbers"
        case .word: return "com.microsoft.Word"
        case .acrobat: return "com.adobe.Acrobat.Pro"
        case .adobeReader: return "com.adobe.Reader"
        }
    }

    /// Errors that end a wait at once: Lasso may not control the app (-1743,
    /// -1744), or the app stopped answering (-1712).
    private static let stopWaiting = "{-1743, -1744, -1712}"

    /// Waits up to 30 seconds for the app to finish opening the file, which
    /// macOS opened just before; the script then fails if it never appears.
    private static func waitFor(_ element: String) -> String {
        """
        repeat 150 times
        try
        if exists \(element) then exit repeat
        on error waitMessage number waitNumber
        if waitNumber is in \(stopWaiting) then error waitMessage number waitNumber
        end try
        delay 0.2
        end repeat
        """
    }

    /// What a failed jump logs: the app and macOS's error number. The error
    /// text can name the file, sheet or cited words, which stay private.
    func failureSummary(errorOutput: String) -> String {
        guard let match = errorOutput.range(of: "\\((-?[0-9]+)\\)\\s*$", options: .regularExpression) else { return rawValue }
        let number = errorOutput[match].trimmingCharacters(in: CharacterSet(charactersIn: "() \n"))
        return "\(rawValue) (error \(number))"
    }

    var source: String {
        switch self {
        case .excel:
            // `goto` selects the cell on its worksheet and scrolls it into view.
            return """
            on run argv
                set {workbookName, sheetName, cellReference} to argv
                tell application id "\(appBundleID)"
                    \(Self.waitFor("workbook workbookName"))
                    set targetBook to workbook workbookName
                    if sheetName is "" then
                        set targetSheet to active sheet of targetBook
                    else
                        set targetSheet to worksheet sheetName of targetBook
                    end if
                    activate object targetSheet
                    goto reference (range cellReference of targetSheet) scroll false
                end tell
            end run
            """
        case .numbers:
            // Numbers imports the file as a new document named after it, or
            // "<name> 2" when that name is taken, so documents open before the
            // jump are passed over. It is polled gently while it imports.
            return """
            on run argv
                set {fileName, baseName, sheetName, cellReference} to argv
                tell application id "\(appBundleID)"
                    set earlierDocuments to {}
                    try
                        set earlierDocuments to id of every document
                    on error waitMessage number waitNumber
                        if waitNumber is in \(Self.stopWaiting) then error waitMessage number waitNumber
                    end try
                    set targetDocument to missing value
                    repeat 60 times
                        try
                            repeat with candidate in documents
                                if id of candidate is not in earlierDocuments ¬
                                    and my isNamedAfter(name of candidate, fileName, baseName) then
                                    set targetDocument to contents of candidate
                                    exit repeat
                                end if
                            end repeat
                        on error waitMessage number waitNumber
                            if waitNumber is in \(Self.stopWaiting) then error waitMessage number waitNumber
                        end try
                        if targetDocument is not missing value then exit repeat
                        delay 0.5
                    end repeat
                    if targetDocument is missing value then
                        -- The import finished before the first look: use the front copy.
                        repeat with candidate in documents
                            if my isNamedAfter(name of candidate, fileName, baseName) then
                                set targetDocument to contents of candidate
                                exit repeat
                            end if
                        end repeat
                    end if
                    if targetDocument is missing value then error "The document did not open."
                    tell targetDocument
                        try
                            if sheetName is not "" then set active sheet to sheet sheetName
                        end try
                        repeat with candidateTable in tables of active sheet
                            try
                                set selection range of candidateTable to range cellReference of candidateTable
                                return
                            end try
                        end repeat
                    end tell
                    error "No table holds the cited cell."
                end tell
            end run

            on isNamedAfter(candidateName, fileName, baseName)
                if candidateName is fileName or candidateName is baseName then return true
                if candidateName does not start with (baseName & " ") then return false
                try
                    (text ((length of baseName) + 2) thru -1 of candidateName) as integer
                    return true
                on error
                    return false
                end try
            end isNamedAfter
            """
        case .word:
            // The search starts at the beginning of the document and repeats
            // from the end of each match until it reaches the cited one.
            return """
            on run argv
                set {documentName, findText, occurrenceText} to argv
                tell application id "\(appBundleID)"
                    \(Self.waitFor("document documentName"))
                    set targetDocument to document documentName
                    set searchStart to 0
                    repeat (occurrenceText as integer) times
                        select (create range targetDocument start searchStart end searchStart)
                        -- Word reports no result here; a match is selected, a miss leaves the caret.
                        execute find (find object of selection) find text findText ¬
                            match case true match forward true wrap find find stop
                        if selection end of selection is selection start of selection then ¬
                            error "The cited words were not found."
                        set searchStart to selection end of selection
                    end repeat
                end tell
            end run
            """
        case .acrobat, .adobeReader:
            return """
            on run argv
                set {documentName, pageText} to argv
                tell application id "\(appBundleID)"
                    \(Self.waitFor("document documentName"))
                    goto (PDF Window 1 of document documentName) page (pageText as integer)
                end tell
            end run
            """
        }
    }
}

/// One step that takes a source's app to the cited place.
enum AssistOpenPlan: Equatable {
    /// Open the file and stop there.
    case plain
    /// Open an editor's link to the cited line; the file opens plainly if the link cannot.
    case url(URL)
    /// Open the file, then run this script with these arguments.
    case script(AssistOpenScript, arguments: [String])
    /// Open the file, then choose Go to Page in Preview.
    case previewPage(Int)
}

enum AssistOpenPlanner {
    /// Word searches at most 255 characters.
    private static let wordSearchLimit = 255
    /// Words kept from a long passage, leaving room for escaped search codes.
    private static let wordSearchPrefix = 200

    /// Editors that open `<scheme>://file/<path>:<line>` links.
    private static let fileLinkSchemes = [
        "com.microsoft.VSCode": "vscode",
        "com.microsoft.VSCodeInsiders": "vscode-insiders",
        "com.vscodium": "vscodium",
        "com.todesktop.230313mzl4w4u92": "cursor",
    ]
    /// Editors that open `<scheme>://open?url=<file>&line=<line>` links.
    private static let openLinkSchemes = [
        "com.barebones.bbedit": "x-bbedit",
        "com.macromates.TextMate": "txmt",
    ]

    static func plan(fileURL: URL, target: AssistOpenTarget?, appBundleID: String?) -> AssistOpenPlan {
        guard let target, let appBundleID else { return .plain }
        let name = fileURL.lastPathComponent
        switch appBundleID {
        case "com.microsoft.Excel":
            guard let cell = target.cell else { return .plain }
            return .script(.excel, arguments: [name, target.sheet ?? "", cell])
        case "com.apple.iWork.Numbers":
            guard let cell = target.cell else { return .plain }
            return .script(.numbers, arguments: [name, fileURL.deletingPathExtension().lastPathComponent,
                                                 target.sheet ?? "", cell])
        case "com.microsoft.Word":
            guard let words = target.text.flatMap(wordFindText) else { return .plain }
            return .script(.word, arguments: [name, words, String(target.occurrence ?? 1)])
        case "com.apple.Preview":
            return target.page.map { .previewPage($0) } ?? .plain
        case "com.adobe.Acrobat.Pro", "com.adobe.Reader":
            guard let page = target.page else { return .plain }
            return .script(appBundleID == "com.adobe.Reader" ? .adobeReader : .acrobat, arguments: [name, String(page)])
        default:
            guard let line = target.line,
                  let link = lineLink(fileURL: fileURL, line: line, appBundleID: appBundleID) else { return .plain }
            return .url(link)
        }
    }

    /// The first line of a passage, as Word's search reads it: within its
    /// length limit and with its ^ search codes escaped.
    static func wordFindText(_ text: String) -> String? {
        guard let firstLine = text.split(whereSeparator: \.isNewline)
            .map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) else { return nil }
        var words = firstLine
        if words.count > wordSearchPrefix {
            let prefix = words.prefix(wordSearchPrefix)
            let cut = prefix.lastIndex(where: { $0 == " " }) ?? prefix.endIndex
            words = String(prefix[..<cut]).trimmingCharacters(in: .whitespaces)
        }
        let escaped = words.replacingOccurrences(of: "^", with: "^^").replacingOccurrences(of: "\t", with: "^t")
        return escaped.count <= wordSearchLimit ? escaped : nil
    }

    private static func lineLink(fileURL: URL, line: Int, appBundleID: String) -> URL? {
        var components = URLComponents()
        if let scheme = fileLinkSchemes[appBundleID] {
            components.scheme = scheme
            components.host = "file"
            components.path = "\(fileURL.path):\(line)"
        } else if let scheme = openLinkSchemes[appBundleID] {
            components.scheme = scheme
            components.host = "open"
            components.queryItems = [URLQueryItem(name: "url", value: fileURL.absoluteString),
                                     URLQueryItem(name: "line", value: String(line))]
        } else {
            return nil
        }
        return components.url
    }
}

/// What carrying out a plan needs from macOS, injectable for tests.
struct AssistOpenActions {
    var openFile: (URL) -> Bool
    var openURL: (URL) -> Bool
    var runScript: (AssistOpenScript, [String]) -> Void
    var goToPreviewPage: (Int, URL) -> Void
}

enum AssistSourceOpening {
    /// True when the file opened. The jump that follows is best effort: its
    /// failure leaves the file open where its app put it.
    static func perform(_ plan: AssistOpenPlan, fileURL: URL, actions: AssistOpenActions) -> Bool {
        switch plan {
        case .plain:
            return actions.openFile(fileURL)
        case .url(let link):
            return actions.openURL(link) || actions.openFile(fileURL)
        case .script(let script, let arguments):
            guard actions.openFile(fileURL) else { return false }
            actions.runScript(script, arguments)
            return true
        case .previewPage(let page):
            guard actions.openFile(fileURL) else { return false }
            actions.goToPreviewPage(page, fileURL)
            return true
        }
    }
}
