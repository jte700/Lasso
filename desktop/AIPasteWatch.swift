// Text copied from an AI and pasted elsewhere. When the clipboard changes
// while an AI app (ChatGPT, Claude, Perplexity) or an AI's site in a browser
// (chatgpt.com, claude.ai, gemini.google.com, ...) is in front, its text is
// remembered; a ⌘V of that same clipboard into another app brackets the
// pasted words there and tells Lasso, so a save of the file marks them too.
// Copies from any other app are never read. Switched off in Settings.

import Cocoa
import ApplicationServices

/// An AI that text can be copied from.
struct AISource: Equatable {
    let agentName: String
    let agentId: String
    /// Where it was copied from, as the card says it: the ChatGPT app, claude.ai.
    let tool: String
    let bundleIdentifier: String

    static let apps: [String: (name: String, tool: String)] = [
        "com.openai.chat": ("ChatGPT", "the ChatGPT app"),
        "com.openai.codex": ("ChatGPT", "the ChatGPT app"),
        "com.anthropic.claudefordesktop": ("Claude", "the Claude app"),
        "ai.perplexity.mac": ("Perplexity", "the Perplexity app"),
    ]

    static let browsers: Set<String> = [
        "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.canary",
        "company.thebrowser.Browser", "company.thebrowser.dia", "com.microsoft.edgemac", "com.brave.Browser",
        "org.mozilla.firefox", "com.kagi.kagimacOS", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
    ]

    /// Sites by host; a host's subdomains count as the site.
    static let sites: [String: String] = [
        "chatgpt.com": "ChatGPT", "chat.openai.com": "ChatGPT", "claude.ai": "Claude",
        "gemini.google.com": "Gemini", "aistudio.google.com": "Gemini", "copilot.microsoft.com": "Copilot",
        "perplexity.ai": "Perplexity", "chat.mistral.ai": "Mistral", "grok.com": "Grok",
    ]

    static func app(_ bundleIdentifier: String) -> AISource? {
        guard let known = apps[bundleIdentifier] else { return nil }
        return AISource(agentName: known.name, agentId: "agent:\(known.name.lowercased())", tool: known.tool,
                        bundleIdentifier: bundleIdentifier)
    }

    static func site(_ url: URL, browser: String) -> AISource? {
        guard let host = url.host?.lowercased() else { return nil }
        guard let (site, name) = sites.first(where: { host == $0.key || host.hasSuffix(".\($0.key)") }) else { return nil }
        return AISource(agentName: name, agentId: "agent:\(name.lowercased())", tool: site, bundleIdentifier: browser)
    }
}

final class AIPasteWatch {
    static let shared = AIPasteWatch()

    struct Copied {
        let text: String
        let source: AISource
        let changeCount: Int
        let at: Date
    }

    private var lastChange = NSPasteboard.general.changeCount
    private(set) var copied: Copied?
    private var timer: Timer?
    private var monitor: Any?

    /// A copy is pasted for this long after it was made.
    private static let copyLife: TimeInterval = 6 * 60 * 60
    /// Shorter copies are a word or two, not an answer.
    private static let shortestCopy = 12
    private static let longestCopy = 200_000

    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.poll() }
        timer?.tolerance = 0.2
        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command),
                  event.charactersIgnoringModifiers?.lowercased() == "v" else { return }
            self?.pasted()
        }
    }

    // MARK: Copies

    private func poll() {
        let board = NSPasteboard.general
        guard board.changeCount != lastChange else { return }
        let change = board.changeCount
        lastChange = change
        copied = nil
        guard AIProvenancePreferences.remembersCopies, let front = NSWorkspace.shared.frontmostApplication,
              let bundle = front.bundleIdentifier else { return }
        if let source = AISource.app(bundle) {
            remember(source, change: change)
        } else if AISource.browsers.contains(bundle) {
            let pid = front.processIdentifier
            AccessibilityWork.queue.async {
                let source = Self.pageURL(pid: pid).flatMap { AISource.site($0, browser: bundle) }
                DispatchQueue.main.async { [weak self] in
                    if let source { self?.remember(source, change: change) }
                }
            }
        }
    }

    private func remember(_ source: AISource, change: Int) {
        let board = NSPasteboard.general
        guard board.changeCount == change else { return }
        // Passwords and other concealed copies are never read.
        let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
        guard !(board.types ?? []).contains(concealed), let text = board.string(forType: .string),
              text.trimmingCharacters(in: .whitespacesAndNewlines).count >= Self.shortestCopy else { return }
        copied = Copied(text: String(text.prefix(Self.longestCopy)), source: source, changeCount: change, at: Date())
    }

    /// The page the browser's window shows: its document, or its web area's address.
    static func pageURL(pid: pid_t) -> URL? {
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
        }
        func url(_ value: CFTypeRef?) -> URL? {
            if let url = value as? URL { return url }
            return (value as? String).flatMap(URL.init(string:))
        }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.3)
        if let window = attribute(application, kAXFocusedWindowAttribute as String), CFGetTypeID(window) == AXUIElementGetTypeID(),
           let found = url(attribute(window as! AXUIElement, kAXDocumentAttribute as String)), found.scheme?.hasPrefix("http") == true {
            return found
        }
        guard var node = attribute(application, kAXFocusedUIElementAttribute as String).flatMap({
            CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil
        }) else { return nil }
        for _ in 0..<40 {
            if (attribute(node, kAXRoleAttribute as String) as? String) == "AXWebArea",
               let found = url(attribute(node, kAXURLAttribute as String)) { return found }
            guard let parent = attribute(node, kAXParentAttribute as String), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            node = parent as! AXUIElement
        }
        return nil
    }

    // MARK: Pastes

    private func pasted() {
        guard let copied, NSPasteboard.general.changeCount == copied.changeCount,
              Date().timeIntervalSince(copied.at) < Self.copyLife,
              let front = NSWorkspace.shared.frontmostApplication,
              front.bundleIdentifier != copied.source.bundleIdentifier,
              AccessibilityWork.mayRead(pid: front.processIdentifier) else { return }
        // The host inserts the words after the key; read them once it has.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            AccessibilityWork.queue.async {
                let context = AccessibilityReader.focusedContext(extending: copied.text.utf16.count + 64)
                let anchor = context.flatMap { Self.anchor(of: copied.text, before: $0) }
                DispatchQueue.main.async {
                    AIAuthorshipHighlighter.shared.recordWritten(
                        kind: "paste", agentName: copied.source.agentName, agentId: copied.source.agentId,
                        tool: copied.source.tool, prompt: nil, text: copied.text, anchor: anchor, element: context?.element)
                }
            }
        }
    }

    /// Where the pasted words sit, ending at or just before the caret: found
    /// whole, or (an app that restyled them) from their opening words to the
    /// caret when that stretch is about as long as what was copied.
    static func anchor(of pasted: String, before context: CaretContext) -> TextAnchor? {
        let raw = Array(context.text.utf16)
        let units = AISnippetReader.normalized(raw)
        let caret = min(max(0, context.cursor), units.count)
        let wanted = AISnippetReader.normalized(Array(pasted.trimmingCharacters(in: .whitespacesAndNewlines).utf16))
        guard !wanted.isEmpty else { return nil }
        let slack = 4
        var range: Range<Int>?
        if let start = TextAnchorResolver.indices(of: wanted, in: units)
            .filter({ $0 + wanted.count <= caret + slack }).max() {
            range = start..<(start + wanted.count)
        } else {
            let opening = Array(wanted.prefix(60))
            if let start = TextAnchorResolver.indices(of: opening, in: units).filter({ $0 < caret }).max() {
                var end = caret
                while end > start, [9, 10, 13, 32].contains(units[end - 1]) { end -= 1 }
                let length = end - start
                if Double(length) >= Double(wanted.count) * 0.8, Double(length) <= Double(wanted.count) * 1.25 {
                    range = start..<end
                }
            }
        }
        guard let range else { return nil }
        return TextAnchor.make(in: raw, range: range, documentOffset: max(0, context.windowStart))
    }
}
