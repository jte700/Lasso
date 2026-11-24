// What Lasso knows about text an AI wrote, as the Mac app holds it: each AI's
// colour, the records the server keeps for a file (written when Claude Code's
// hooks, Lasso's writer or a paste said so, never guessed from the words),
// and the snippets written here before any file was saved with them.

import Cocoa

// MARK: Preferences

enum AIProvenancePreferences {
    static let showKey = "MarkAIWrittenText"
    static let copiesKey = "RememberAICopies"

    /// Brackets around AI-written text in other apps. On unless switched off.
    static var showsMarks: Bool {
        get { UserDefaults.standard.object(forKey: showKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: showKey); changed() }
    }

    /// Text copied from an AI app or site is remembered, to mark where it is pasted.
    static var remembersCopies: Bool {
        get { UserDefaults.standard.object(forKey: copiesKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: copiesKey); changed() }
    }

    private static func changed() {
        NotificationCenter.default.post(name: .aiProvenancePreferencesDidChange, object: nil)
    }
}

extension Notification.Name {
    static let aiProvenancePreferencesDidChange = Notification.Name("LassoAIProvenancePreferencesDidChange")
}

// MARK: Each AI's look

/// An AI as its brackets are drawn: its name and the colour people know it by.
struct AIAgentStyle: Equatable {
    let key: String
    let name: String
    let color: NSColor

    static func of(agentId: String?, name: String) -> AIAgentStyle {
        let said = (agentId?.replacingOccurrences(of: "agent:", with: "") ?? name).lowercased()
        let key = known.keys.first { said.hasPrefix($0) } ?? said
        return AIAgentStyle(key: key, name: name, color: known[key] ?? other)
    }

    /// The brand colours of the AIs Lasso names; any other AI is violet.
    static let known: [String: NSColor] = [
        "claude": rgb(0xD97757),
        "chatgpt": rgb(0x10A37F),
        "gemini": rgb(0x5B8DEF),
        "copilot": rgb(0x3BA7E5),
        "perplexity": rgb(0x20B8CD),
        "mistral": rgb(0xFA7A3C),
        "grok": rgb(0x9A9A9A),
    ]
    static let other = rgb(0xA78BFA)
    /// Lasso's own blue, for what a person wrote.
    static let person = rgb(0x8EC5F4)

    static func rgb(_ hex: Int) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// Each AI's own logo, taken from its Mac app when the app is on this Mac:
/// ChatGPT's knot, Claude's spark. Nothing is fetched or bundled.
enum AIAgentLogo {
    /// The apps that carry each AI's logo, the current one first.
    static let apps: [String: [String]] = [
        "chatgpt": ["com.openai.codex", "com.openai.chat"],
        "claude": ["com.anthropic.claudefordesktop"],
        "perplexity": ["ai.perplexity.mac"],
    ]
    private static var found: [String: NSImage?] = [:]

    static func image(for key: String) -> NSImage? {
        if let known = found[key] { return known }
        let app = apps[key]?.lazy.compactMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }.first
        let image = app.map { NSWorkspace.shared.icon(forFile: $0.path) }
        found[key] = image
        return image
    }
}

// MARK: What was recorded

/// One record of an AI's write: who, how, when, what asked for it, and how much is still as written.
struct AIMarkInfo: Equatable {
    let id: String
    /// edit, command, writer, paste or agent.
    let kind: String
    let agentId: String
    let agentName: String
    let model: String?
    let tool: String?
    let prompt: String?
    let hostApp: String?
    let command: String?
    let askedBy: String?
    let at: Date?
    let written: Int
    let kept: Int
    let editedInside: Int
    /// True for words written here that no saved file holds yet.
    var unsaved = false
    /// The person whose Lasso recorded it, when that was another Mac's: the record came in the document.
    var recordedElsewhereBy: String?
    /// Who has edited inside what it wrote since.
    var editors: [AIEditor] = []

    var style: AIAgentStyle { .of(agentId: agentId, name: agentName) }

    init(id: String, kind: String, agentId: String, agentName: String, model: String?, tool: String?, prompt: String?,
         hostApp: String?, command: String?, askedBy: String?, at: Date?, written: Int, kept: Int, editedInside: Int,
         unsaved: Bool = false, recordedElsewhereBy: String? = nil, editors: [AIEditor] = []) {
        self.id = id
        self.kind = kind
        self.agentId = agentId
        self.agentName = agentName
        self.model = model
        self.tool = tool
        self.prompt = prompt
        self.hostApp = hostApp
        self.command = command
        self.askedBy = askedBy
        self.at = at
        self.written = written
        self.kept = kept
        self.editedInside = editedInside
        self.unsaved = unsaved
        self.recordedElsewhereBy = recordedElsewhereBy
        self.editors = editors
    }

    init?(json: [String: Any]) {
        guard let id = json["id"] as? String, let agent = json["agent"] as? [String: Any],
              let agentId = agent["id"] as? String, let agentName = agent["name"] as? String else { return nil }
        let initiated = json["initiatedBy"] as? [String: Any]
        let asked = json["askedBy"] as? [String: Any]
        let askedBy = asked.map { $0["you"] as? Bool == true ? "You" : Self.text($0["name"]) }
            ?? (initiated?["type"] as? String == "HUMAN_SELF" ? "You" : Self.text(initiated?["name"]))
        let recorded = json["recordedBy"] as? [String: Any]
        let editors = (json["editors"] as? [[String: Any]] ?? []).compactMap { editor in
            Self.text(editor["name"]).map { AIEditor(name: $0, you: editor["you"] as? Bool ?? false) }
        }
        self.init(id: id, kind: json["kind"] as? String ?? "edit", agentId: agentId, agentName: agentName,
                  model: Self.text(json["model"]), tool: Self.text(json["tool"]), prompt: Self.text(json["prompt"]),
                  hostApp: Self.text(json["hostApp"]), command: Self.text(json["command"]),
                  askedBy: askedBy,
                  at: (json["at"] as? String).flatMap(AIDates.parse),
                  written: json["written"] as? Int ?? 0, kept: json["kept"] as? Int ?? 0,
                  editedInside: json["editedInside"] as? Int ?? 0,
                  recordedElsewhereBy: recorded?["you"] as? Bool == false ? Self.text(recorded?["name"]) : nil,
                  editors: editors)
    }

    private static func text(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The share of what it wrote that is still as written, 0 to 1.
    var keptShare: Double {
        let whole = max(written, kept + editedInside, 1)
        return min(1, Double(kept) / Double(whole))
    }
}

enum AIDates {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let whole = ISO8601DateFormatter()

    static func parse(_ text: String) -> Date? { fractional.date(from: text) ?? whole.date(from: text) }
}

/// One AI-written part of a saved file, with what finds it again in an app showing the file.
struct AISpan: Equatable {
    let markId: String
    /// The whole part, with the words either side.
    let anchor: TextAnchor
    /// Each of its lines, for apps that break lines differently.
    let pieces: [TextAnchor]
}

/// The server's answer for one file.
struct AIAuthorshipAnswer: Equatable {
    let path: String
    let spans: [AISpan]
    let marks: [String: AIMarkInfo]

    static func parse(_ data: Data, path: String) -> AIAuthorshipAnswer? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        guard root["found"] as? Bool == true else { return AIAuthorshipAnswer(path: path, spans: [], marks: [:]) }
        var marks: [String: AIMarkInfo] = [:]
        for case let mark as [String: Any] in root["marks"] as? [Any] ?? [] {
            if let info = AIMarkInfo(json: mark) { marks[info.id] = info }
        }
        let spans: [AISpan] = (root["spans"] as? [Any] ?? []).compactMap { item in
            guard let span = item as? [String: Any], let markId = span["markId"] as? String,
                  let text = span["text"] as? String, !text.isEmpty else { return nil }
            let start = span["start"] as? Int ?? 0
            let pieces: [TextAnchor] = (span["pieces"] as? [Any] ?? []).compactMap { item in
                guard let piece = item as? [String: Any], let text = piece["text"] as? String, !text.isEmpty else { return nil }
                return TextAnchor(text: text, prefixContext: piece["prefix"] as? String ?? "",
                                  suffixContext: piece["suffix"] as? String ?? "", approximateOffset: start)
            }
            return AISpan(markId: markId,
                          anchor: TextAnchor(text: text, prefixContext: span["prefix"] as? String ?? "",
                                             suffixContext: span["suffix"] as? String ?? "", approximateOffset: start),
                          pieces: pieces)
        }
        return AIAuthorshipAnswer(path: path, spans: spans, marks: marks)
    }
}

// MARK: Talking to the server

enum AIAuthorshipClient {
    /// The AI-written parts of the file at `path`.
    static func fetch(serverURL: URL, path: String, completion: @escaping (AIAuthorshipAnswer?) -> Void) {
        var components = URLComponents(url: serverURL.appendingPathComponent("api/ai-authorship"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "path", value: path)]
        guard let url = components?.url else { completion(nil); return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 4
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let answer = (response as? HTTPURLResponse)?.statusCode == 200 ? data.flatMap { AIAuthorshipAnswer.parse($0, path: path) } : nil
            DispatchQueue.main.async { completion(answer) }
        }.resume()
    }

    /// Tells the server what an AI wrote here; the mark's id comes back.
    static func record(serverURL: URL, _ body: [String: Any], completion: ((String?) -> Void)? = nil) {
        var request = URLRequest(url: serverURL.appendingPathComponent("api/ai-marks"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body.compactMapValues { $0 })
        request.timeoutInterval = 6
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let root = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
            let id = (response as? HTTPURLResponse)?.statusCode == 201 ? (root?["mark"] as? [String: Any])?["id"] as? String : nil
            DispatchQueue.main.async { completion?(id) }
        }.resume()
    }
}

/// Someone who edited inside what an AI wrote: a person, or another AI.
struct AIEditor: Equatable {
    let name: String
    /// This Mac's own person.
    let you: Bool
}

/// Whether Lasso writes its AI record into Word documents, whether prompts go in, and the name it signs with.
struct AIRecordSettings: Equatable {
    var name: String
    var carry: Bool
    var includePrompts: Bool

    init?(json: [String: Any]) {
        guard let name = json["name"] as? String, let carry = json["carry"] as? Bool,
              let includePrompts = json["includePrompts"] as? Bool else { return nil }
        self.name = name
        self.carry = carry
        self.includePrompts = includePrompts
    }

    /// Read from the server, or changed there when `changes` is given; nil when it could not be reached.
    static func exchange(serverURL: URL, changes: [String: Any]? = nil, completion: @escaping (AIRecordSettings?) -> Void) {
        var request = URLRequest(url: serverURL.appendingPathComponent("api/ai-record"))
        request.timeoutInterval = 4
        if let changes {
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: changes)
        }
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let root = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
            let settings = (response as? HTTPURLResponse)?.statusCode == 200 ? root.flatMap(AIRecordSettings.init(json:)) : nil
            DispatchQueue.main.async { completion(settings) }
        }.resume()
    }
}

// MARK: Snippets written here

/// Words an AI wrote into another app while Lasso watched: the writer's
/// answer, or a paste of text copied from an AI. Kept until the words go.
struct AISnippet: Codable, Equatable {
    let id: String
    var markId: String?
    let kind: String
    let agentId: String
    let agentName: String
    let model: String?
    let tool: String?
    let prompt: String?
    let hostBundleIdentifier: String
    let hostApplication: String
    let documentContext: String
    let documentPath: String?
    var anchor: TextAnchor
    let createdAt: Date

    var info: AIMarkInfo {
        AIMarkInfo(id: markId ?? id, kind: kind, agentId: agentId, agentName: agentName, model: model, tool: tool,
                   prompt: prompt, hostApp: hostApplication, command: nil, askedBy: "You", at: createdAt,
                   written: anchor.text.count, kept: anchor.text.count, editedInside: 0, unsaved: documentPath == nil)
    }
}

final class AISnippetStore {
    private(set) var snippets: [AISnippet] = []
    private let url: URL
    private static let most = 500

    init(url: URL) {
        self.url = url
        if let data = try? Data(contentsOf: url) {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            snippets = (try? decoder.decode([AISnippet].self, from: data)) ?? []
        }
    }

    func add(_ snippet: AISnippet) {
        snippets.append(snippet)
        if snippets.count > Self.most { snippets.removeFirst(snippets.count - Self.most) }
        save()
    }

    func update(id: String, _ change: (inout AISnippet) -> Void) {
        guard let index = snippets.firstIndex(where: { $0.id == id }) else { return }
        change(&snippets[index])
        save()
    }

    func remove(id: String) {
        snippets.removeAll { $0.id == id }
        save()
    }

    func hasSnippets(bundleIdentifier: String) -> Bool {
        snippets.contains { $0.hostBundleIdentifier == bundleIdentifier }
    }

    func snippets(forContext context: String, bundleIdentifier: String) -> [AISnippet] {
        snippets.filter { $0.documentContext == context && $0.hostBundleIdentifier == bundleIdentifier }
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(snippets) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}
