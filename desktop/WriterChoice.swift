// Who writes when a prompt is handed over, and what counts as a prompt.
//
// ⌥Tab's second row (↓) chooses an AI writer, or None. With one chosen, a
// sentence begun with a backslash ("\Write a message detailing the budget")
// is a prompt: a pill by the caret offers it, and Tab erases it and has the
// writer answer in its place, citing sources through Lasso. With None, a
// backslash is only a backslash. Lasso's own suggestions never involve a
// writer.

import Foundation

/// One choice on the switcher's writer row.
struct WriterAgent: Equatable {
    /// What the server knows the writer by; nil for None.
    let id: String?
    let title: String
    /// The SF Symbol drawn beside the title.
    let symbol: String

    static let none = WriterAgent(id: nil, title: "None", symbol: "pencil.slash")
    static let chatGPT = WriterAgent(id: "chatgpt", title: "ChatGPT", symbol: "sparkles")
    /// None first, then each writer a prompt can be handed to.
    static let all: [WriterAgent] = [.none, .chatGPT]

    /// The writer as the switcher's pill draws an entry.
    var scopeEntry: SourceScopeEntry { SourceScopeEntry(projectId: nil, title: title, symbol: symbol) }
}

struct WriterChoice: Equatable {
    /// Where the choice is kept between launches.
    static let defaultsKey = "LassoWriterAgent"

    let entries = WriterAgent.all
    /// The writer prompts go to; nil for None. A writer no longer offered reads as None.
    private(set) var chosenId: String?

    init(chosenId: String? = nil) {
        self.chosenId = WriterAgent.all.contains { $0.id == chosenId } ? chosenId : nil
    }

    var chosen: WriterAgent { entries.first { $0.id == chosenId } ?? .none }
    var chosenIndex: Int { entries.firstIndex { $0.id == chosenId } ?? 0 }
    /// The chosen writer, or nil while it is None.
    var writer: WriterAgent? { chosenId == nil ? nil : chosen }

    /// Chooses the entry at `index`. Returns whether the choice changed.
    @discardableResult
    mutating func choose(at index: Int) -> Bool {
        guard entries.indices.contains(index), entries[index].id != chosenId else { return false }
        chosenId = entries[index].id
        return true
    }

    /// The entry `steps` away from `index`, going round past the last back to None.
    func index(from index: Int, by steps: Int) -> Int {
        let count = entries.count
        return ((index + steps) % count + count) % count
    }
}

/// A prompt at the end of the text before the caret.
enum WriterPrompt {
    static let mark: Character = "\\"
    /// "\ok" is the least that is offered; a lone backslash or "\a" is not yet a prompt.
    static let shortestInstruction = 2

    struct Found: Equatable {
        /// UTF-16 units from the backslash to the caret: what Tab erases.
        let length: Int
        /// The words after the backslash, as the writer is asked.
        let instruction: String
    }

    /// The prompt `text` ends with: a backslash that starts the line or a
    /// sentence, and everything after it on that line. A backslash inside a
    /// sentence ("C:\Users", "a\b") starts none, and neither does one followed
    /// by another backslash or a bracket. A prompt may run to several
    /// sentences; it ends at the caret.
    static func find(in text: String) -> Found? {
        let lineStart = text.lastIndex(where: \.isNewline).map { text.index(after: $0) } ?? text.startIndex
        var opening: String.Index?
        // Only spaces so far on the line, or since a sentence ended.
        var sentenceStarts = true
        var sentenceEnded = false
        var index = lineStart
        while index < text.endIndex {
            let character = text[index]
            if character.isWhitespace {
                sentenceStarts = sentenceStarts || sentenceEnded
            } else {
                // The first backslash to start a sentence opens the prompt; later ones are part of it.
                if character == mark, sentenceStarts, opening == nil { opening = index }
                sentenceStarts = false
                sentenceEnded = ".!?".contains(character)
            }
            index = text.index(after: index)
        }
        guard let opening else { return nil }
        let instruction = text[text.index(after: opening)...].trimmingCharacters(in: .whitespaces)
        guard instruction.count >= shortestInstruction, let first = instruction.first,
              first.isLetter || first.isNumber else { return nil }
        return Found(length: text[opening...].utf16.count, instruction: instruction)
    }
}

/// An answer arriving as lines of JSON: bytes in, whole lines out.
struct WriterLines {
    private var buffer = Data()

    /// The lines `data` completes, without their line breaks. What follows the last break waits for more.
    mutating func take(_ data: Data) -> [Data] {
        buffer.append(data)
        var lines: [Data] = []
        while let end = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<end]
            if !line.isEmpty { lines.append(Data(line)) }
            buffer = Data(buffer[buffer.index(after: end)...])
        }
        return lines
    }
}

/// The indexed object behind cited words, as a linked phrase records its source.
struct WriterSource {
    let objectId: String
    let versionId: String?
    let snapshotId: String?
    let projectId: String?
    let label: String
    let valueText: String?
    let path: String
    /// The object as the server sent it, for wording where in the file it is.
    let candidate: [String: Any]

    init?(_ candidate: [String: Any]) {
        guard let objectId = candidate["id"] as? String, let path = candidate["path"] as? String else { return nil }
        self.objectId = objectId
        self.path = path
        versionId = candidate["versionId"] as? String
        snapshotId = candidate["snapshotId"] as? String
        projectId = candidate["projectId"] as? String
        label = candidate["label"] as? String ?? (path as NSString).lastPathComponent
        valueText = candidate["valueText"] as? String
        self.candidate = candidate
    }
}

/// Words of an answer still to write; `source` is set for words the writer cited.
struct WriterPiece {
    var text: String
    let source: WriterSource?

    /// Takes from `pending` what can be written now, leaving what must wait.
    /// Until the answer has ended, spaces and line breaks at its end wait for
    /// the words after them: a write is verified by its last characters. The
    /// answer's own last spaces and line breaks are dropped.
    static func batch(from pending: inout [WriterPiece], finished: Bool) -> [WriterPiece] {
        var batch = pending
        var held: [WriterPiece] = []
        while let last = batch.last {
            let kept = String(last.text.reversed().drop(while: \.isWhitespace).reversed())
            if kept.count == last.text.count { break }
            batch.removeLast()
            held.insert(WriterPiece(text: String(last.text.dropFirst(kept.count)), source: nil), at: 0)
            if !kept.isEmpty {
                batch.append(WriterPiece(text: kept, source: last.source))
                break
            }
        }
        pending = finished ? [] : held
        return batch
    }
}
