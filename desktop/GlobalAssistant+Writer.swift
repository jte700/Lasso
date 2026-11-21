// A backslash prompt handed to the AI writer chosen with ⌥Tab ↓.
//
// While a prompt ends at the caret, the pill (WriterPill.swift) stands where
// the card would. Tab erases the prompt and sends its words to the local
// server, which has the writer answer through Lasso (src/writing). The answer
// arrives a few words at a time and is written at the caret the same way
// Tab writes a suggestion: each write is read back before the next, and every
// phrase the writer cited is linked to its source like an accepted
// suggestion, so it is drawn as a pill and opens in the Source Inspector.
// Until the first words arrive, the pill says what the writer is doing as a
// moving line (WriterPill.swift, ThinkingMotion.swift).
// Escape stops the writer; ⌘Z straight after takes the answer back and puts
// the prompt where it was.

import Cocoa
import ApplicationServices

/// What the assistant keeps for AI writing.
struct WriterState {
    /// The writer prompts go to, kept between launches.
    var choice = WriterChoice(chosenId: UserDefaults.standard.string(forKey: WriterChoice.defaultsKey))
    /// The prompt the pill offers, in the field as it was last read.
    var offered: (prompt: WriterPrompt.Found, context: CaretContext)?
    /// The answer being written.
    var session: WriterSession?
    /// Set while the card is closed to make way for the pill, which stays.
    var keepsPill = false
    /// When the chosen writer was last started ahead of a prompt.
    var preparedAt = Date.distantPast
}

/// One prompt and its answer, from Tab until the last word is written.
final class WriterSession {
    let agent: WriterAgent
    let element: AXUIElement
    /// The erased prompt, backslash included, which ⌘Z or a failure puts back.
    var prompt = ""
    var stream: WriterStream?
    var pending: [WriterPiece] = []
    /// A write is on its way into the field.
    var isWriting = false
    /// The writer has said all it will.
    var isFinished = false
    var failure: String?
    /// The field as read after Lasso's last write; nil until the prompt is erased.
    var expected: CaretContext?
    var written = ""
    var referenceIds: [String] = []
    /// A write the field would not take is tried once more.
    var refusals = 0
    /// The line the answer begins on, as an Accessibility rectangle, which
    /// the pill sits under while the writer thinks and if it cannot answer.
    var place: CGRect?

    init(agent: WriterAgent, element: AXUIElement) {
        self.agent = agent
        self.element = element
    }

    /// What can be written now (see `WriterPiece.batch`).
    func takeBatch() -> [WriterPiece] {
        WriterPiece.batch(from: &pending, finished: isFinished)
    }
}

extension GlobalAssistant {
    private static let preparedFor: TimeInterval = 8 * 60

    /// The pill offers a prompt and Tab would hand it over.
    var writerPromptReady: Bool {
        writer.offered != nil && writer.session == nil && WriterPillController.shared.phase == .ready
            && WriterPillController.shared.isShown
    }

    // MARK: Choosing the writer

    /// Return in the switcher keeps the writer its second row shows.
    func chooseWriter(at index: Int) {
        guard writer.choice.choose(at: index) else { return }
        UserDefaults.standard.set(writer.choice.chosenId, forKey: WriterChoice.defaultsKey)
        withdrawWriterPrompt()
        // A writer just chosen is started now, and says here if it is not set up.
        if let agent = writer.choice.writer { prepareWriter(agent, sayingWhy: true) }
    }

    /// Starts the writer on the server ahead of a prompt, so the first words come sooner.
    private func prepareWriter(_ agent: WriterAgent, sayingWhy: Bool = false) {
        guard let serverURL, let id = agent.id,
              sayingWhy || Date().timeIntervalSince(writer.preparedAt) > Self.preparedFor else { return }
        writer.preparedAt = Date()
        WriterStream.prepare(serverURL: serverURL, agent: id) { [weak self] problem in
            guard let self, let problem else { return }
            // A writer that is not set up is asked again in half a minute, not on every key.
            self.writer.preparedAt = Date().addingTimeInterval(30 - Self.preparedFor)
            if sayingWhy, self.writer.session == nil {
                WriterPillController.shared.fail(problem, agent: agent, at: self.context?.caretRect)
            }
        }
    }

    // MARK: The prompt at the caret

    /// A field just read ends in a prompt and a writer is chosen: the pill
    /// offers it and no card is asked for. Says whether it does.
    func offersWriterPrompt(in captured: CaretContext, caret: CGRect?) -> Bool {
        guard writer.session == nil else { return false }
        guard let agent = writer.choice.writer, let prompt = WriterPrompt.find(in: captured.text) else {
            withdrawWriterPrompt()
            return false
        }
        // The card and anything asked for it give way; the pill stays through that.
        writer.keepsPill = true
        hide()
        writer.keepsPill = false
        writer.offered = (prompt, captured)
        WriterPillController.shared.show(.ready, agent: agent, at: caret ?? captured.caretRect)
        prepareWriter(agent)
        publishKeyRouting()
        return true
    }

    /// The pill no longer offers a prompt. One that is answering, or saying why it could not, is left alone.
    func withdrawWriterPrompt() {
        guard !writer.keepsPill, writer.offered != nil else { return }
        writer.offered = nil
        if writer.session == nil, WriterPillController.shared.phase == .ready { WriterPillController.shared.hide() }
    }

    func performWriterKey(_ action: KeyAction) {
        switch action {
        case .writePrompt: writePrompt()
        case .dismissWriterPrompt: dismissWriterPrompt()
        case .stopWriter: stopWriter()
        default: break
        }
    }

    /// Escape on the pill: it stays away for the rest of this sentence.
    private func dismissWriterPrompt() {
        if let offered = writer.offered {
            escapeQuiet.escaped(at: offered.context.text, throughSentence: true)
            escapedElement = offered.context.element
        }
        dismiss()
    }

    // MARK: Writing

    /// Tab on the pill: the prompt is erased, and its words go to the writer.
    private func writePrompt() {
        guard writer.session == nil, let offered = writer.offered, serverURL != nil,
              let agent = writer.choice.writer else { return }
        let session = WriterSession(agent: agent, element: offered.context.element)
        writer.session = session
        writer.offered = nil
        hide()
        undoableInsertion = nil
        session.place = offered.context.caretRect.map(CaretLine.line)
        // The pill that offered the prompt turns at once to what the writer is doing.
        WriterPillController.shared.think(agent: agent, at: session.place)
        markOwnWrite()
        let element = offered.context.element
        AccessibilityWork.queue.async { [weak self] in
            // The prompt is read once more: a last letter may have been typed since the pill was placed.
            guard let fresh = AccessibilityReader.focusedContext(), CFEqual(fresh.element, element),
                  let prompt = WriterPrompt.find(in: fresh.text) else {
                DispatchQueue.main.async { self?.endWriter(session, saying: "The prompt is no longer at the caret.") }
                return
            }
            let erased = String(decoding: Array(fresh.text.utf16).suffix(prompt.length), as: UTF16.self)
            // Read before it goes: the backslash's place is where the answer begins.
            let start = AccessibilityReader.characterRect(in: element, at: fresh.absoluteCaret - prompt.length)
            AccessibilityReader.erase(length: prompt.length, at: fresh.absoluteCaret, in: element, expected: fresh) { after in
                DispatchQueue.main.async {
                    self?.promptErased(session, prompt: erased, instruction: prompt.instruction, after: after, start: start)
                }
            }
        }
    }

    private func promptErased(_ session: WriterSession, prompt: String, instruction: String, after: CaretContext?,
                              start: CGRect?) {
        markOwnWrite()
        if let after {
            session.prompt = prompt
            session.expected = after
        }
        // Escape came while the prompt was being erased: it goes back where it was.
        guard writer.session === session else { restorePrompt(of: session); return }
        guard let after, let serverURL, let agent = session.agent.id else {
            endWriter(session, saying: "Lasso could not write in this field.")
            return
        }
        // The caret is back where the prompt began, and the pill moves with it.
        session.place = start ?? after.caretRect.map(CaretLine.line) ?? session.place
        WriterPillController.shared.move(to: session.place)
        let stream = WriterStream(serverURL: serverURL, agent: agent, prompt: instruction,
                                  onlyProjectId: sourceScope.chosenProjectId) { [weak self, weak session] event in
            guard let self, let session, self.writer.session === session else { return }
            self.writerEvent(event, in: session)
        }
        session.stream = stream
        stream.start()
    }

    private func writerEvent(_ event: WriterStream.Event, in session: WriterSession) {
        switch event {
        case .status(let status, let detail):
            // Once words are being written they are what shows, whatever is looked up meanwhile.
            guard session.written.isEmpty, !session.isWriting, session.pending.isEmpty else { return }
            WriterPillController.shared.lookup(status: status, detail: detail)
        case .text(let text):
            session.pending.append(.init(text: text, source: nil))
        case .cite(let text, let source):
            session.pending.append(.init(text: text, source: source))
        case .done:
            session.isFinished = true
        case .failed(let why):
            // What has not been written yet is not written after a failure.
            session.pending = []
            session.failure = why
            session.isFinished = true
        }
        writeNext(of: session)
    }

    /// Writes what has arrived, one verified write at a time.
    private func writeNext(of session: WriterSession) {
        guard writer.session === session, !session.isWriting, let expected = session.expected else { return }
        let batch = session.takeBatch()
        let text = batch.map(\.text).joined()
        guard !text.isEmpty else {
            if session.isFinished { endWriter(session, saying: session.failure) }
            return
        }
        session.isWriting = true
        // The first words take the place of what the writer was doing.
        if session.written.isEmpty { WriterPillController.shared.hide() }
        markOwnWrite()
        let element = session.element
        AccessibilityWork.queue.async { [weak self] in
            AccessibilityReader.replace(length: 0, at: expected.absoluteCaret, with: text, in: element,
                                        expected: expected, expectedPrefix: "") { applied in
                // Read wide enough to hold the whole write, for its cited phrases, and as the next write will find it.
                let wide = AccessibilityReader.context(of: element, extending: text.utf16.count)
                let next = AccessibilityReader.focusedContext()
                DispatchQueue.main.async {
                    self?.wrote(batch, text: text, applied: applied, wide: wide, next: next, in: session)
                }
            }
        }
    }

    private func wrote(_ batch: [WriterPiece], text: String, applied: Bool, wide: CaretContext?,
                       next: CaretContext?, in session: WriterSession) {
        session.isWriting = false
        markOwnWrite()
        guard let next, CFEqual(next.element, session.element) else {
            // The field lost focus or can no longer be read. What was written stays.
            if writer.session === session { endWriter(session, saying: "The writer stopped: the text field changed.") }
            return
        }
        let landed = applied || Self.holds(text, atEndOf: wide?.text ?? next.text)
        if landed {
            session.written += text
            session.refusals = 0
            if applied, let wide { link(batch, of: text, in: wide, session: session) }
        } else if session.expected.map({ $0.text == next.text && $0.absoluteCaret == next.absoluteCaret }) == true,
                  session.refusals == 0 {
            // Nothing changed: the field did not take the write. It is tried once more.
            session.refusals += 1
            session.pending.insert(contentsOf: batch, at: 0)
        } else {
            // The writer's place was typed in or moved from. What was written stays.
            if writer.session === session { endWriter(session, saying: "The writer stopped: the text was changed while it wrote.") }
            return
        }
        session.expected = next
        guard writer.session === session else { return }
        writeNext(of: session)
    }

    /// Whether the field now ends with the write's first and last words, in
    /// that order, within the write's length: an app that restyles what is
    /// inserted (a list it formats, quotes it curls) took it all the same.
    static func holds(_ text: String, atEndOf field: String) -> Bool {
        let words = text.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        guard let first = words.first, let last = words.last else { return false }
        let tail = String(field.suffix(text.count + text.count / 4 + 16))
        guard let start = tail.range(of: first) else { return false }
        return tail.range(of: last, options: .backwards, range: start.lowerBound..<tail.endIndex) != nil
    }

    /// Links each cited phrase of a write to its source, in the field as read back.
    private func link(_ batch: [WriterPiece], of text: String, in wide: CaretContext, session: WriterSession) {
        let units = Array(wide.text.utf16)
        let written = Array(text.utf16)
        guard units.count >= written.count else { return }
        let start = units.count - written.count
        var offset = 0
        for piece in batch {
            let pieceUnits = Array(piece.text.utf16)
            defer { offset += pieceUnits.count }
            guard let source = piece.source else { continue }
            // The pill hugs the words, not the spaces a citation was given with.
            let leading = pieceUnits.prefix(while: { $0 == 32 || $0 == 10 }).count
            let trailing = pieceUnits.reversed().prefix(while: { $0 == 32 || $0 == 10 }).count
            let range = (start + offset + leading)..<(start + offset + pieceUnits.count - trailing)
            guard range.lowerBound < range.upperBound,
                  CompletionTransaction.equivalentHostText(Array(units[range]),
                                                           Array(pieceUnits[leading..<(pieceUnits.count - trailing)])) else { continue }
            let location = Self.sourceLocation(source.candidate)
            if let id = DependencyHighlighter.shared.recordVerifiedInsertion(
                objectId: source.objectId, versionId: source.versionId, snapshotId: source.snapshotId,
                projectId: source.projectId, label: source.label, valueText: source.valueText ?? location,
                sourcePath: source.path, sourceLocation: location, document: units, range: range,
                documentOffset: max(0, wide.windowStart), element: session.element) {
                session.referenceIds.append(id)
            }
        }
    }

    /// Escape while the writer answers, or Lasso switching off: it stops, and what it has written stays.
    func stopWriter() {
        guard let session = writer.session else { return }
        session.pending = []
        endWriter(session, saying: nil)
    }

    /// The answer is over: complete, stopped, or failed with `why`.
    private func endWriter(_ session: WriterSession, saying why: String?) {
        guard writer.session === session else { return }
        writer.session = nil
        session.stream?.cancel()
        session.stream = nil
        let nothingWritten = session.written.isEmpty && !session.isWriting
        // Said by the caret: where the answer ends, or where it would have begun.
        let caret = session.expected?.caretRect ?? session.place
        if let why {
            WriterPillController.shared.fail(why, agent: session.agent, at: caret)
        } else if nothingWritten, session.isFinished {
            WriterPillController.shared.fail("\(session.agent.title) wrote nothing for that.", agent: session.agent, at: caret)
        } else {
            WriterPillController.shared.hide()
        }
        // A prompt that got no answer, or was stopped before its first word,
        // goes back where it was, to send again or change.
        if nothingWritten { restorePrompt(of: session) }
        // ⌘Z takes the whole answer back, with its links, and puts the prompt where it was.
        if !session.written.isEmpty, let expected = session.expected, expected.absoluteCaret >= 0 {
            var answer = AcceptedInsertion(element: session.element, caret: expected.absoluteCaret,
                                           inserted: session.written, replaced: session.prompt)
            answer.referenceId = session.referenceIds.first
            answer.furtherReferenceIds = Array(session.referenceIds.dropFirst())
            undoableInsertion = answer
        }
        publishKeyRouting()
    }

    private func restorePrompt(of session: WriterSession) {
        guard !session.prompt.isEmpty, let expected = session.expected else { return }
        let element = session.element
        let prompt = session.prompt
        markOwnWrite()
        AccessibilityWork.queue.async {
            AccessibilityReader.replace(length: 0, at: expected.absoluteCaret, with: prompt, in: element,
                                        expected: expected, expectedPrefix: "", completion: nil)
        }
    }
}
