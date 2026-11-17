// A prompt sent to the local server, and its answer read as it arrives.
//
// The server answers /api/writing with one JSON object a line (see
// src/writing/service.js): words to write, cited words with the indexed
// object they came from, what the writer is doing meanwhile, and how it
// ended. Events are delivered on the main thread, in order. Cancelling
// closes the connection, which stops the writer.

import Foundation

final class WriterStream: NSObject, URLSessionDataDelegate {
    enum Event {
        /// The writer began a lookup: "searching" or "reading", and for what.
        case status(String, detail: String)
        case text(String)
        case cite(String, source: WriterSource?)
        case done
        case failed(String)
    }

    private let request: URLRequest
    private let onEvent: (Event) -> Void
    private var session: URLSession?
    private var lines = WriterLines()
    private var status = 200
    private var refusal = Data()
    /// An ending was delivered, or the stream was cancelled: nothing more is.
    private var ended = false

    /// `onEvent` runs on the main thread. `onlyProjectId` is the folder chosen with ⌥Tab, or nil for All.
    init(serverURL: URL, agent: String, prompt: String, onlyProjectId: String?, onEvent: @escaping (Event) -> Void) {
        var request = URLRequest(url: serverURL.appendingPathComponent("api/writing"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        // The longest the writer may go quiet between events.
        request.timeoutInterval = 180
        var body: [String: Any] = ["agent": agent, "prompt": prompt]
        if let onlyProjectId { body["onlyProjectId"] = onlyProjectId }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        self.request = request
        self.onEvent = onEvent
    }

    func start() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session
        session.dataTask(with: request).resume()
    }

    func cancel() {
        ended = true
        session?.invalidateAndCancel()
        session = nil
    }

    /// The server started this writer ahead of a prompt; `completion` is told, on the main thread, why it could not.
    static func prepare(serverURL: URL, agent: String, completion: @escaping (String?) -> Void) {
        var request = URLRequest(url: serverURL.appendingPathComponent("api/writing/agents/\(agent)/prepare"))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let answer = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            let problem = answer?["ready"] as? Bool == false ? answer?["message"] as? String : nil
            DispatchQueue.main.async { completion(problem) }
        }.resume()
    }

    static func event(_ line: Data) -> Event? {
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let type = object["type"] as? String else { return nil }
        switch type {
        case "status": return .status(object["status"] as? String ?? "", detail: object["detail"] as? String ?? "")
        case "text": return (object["text"] as? String).map { .text($0) }
        case "cite":
            guard let text = object["text"] as? String else { return nil }
            return .cite(text, source: (object["source"] as? [String: Any]).flatMap(WriterSource.init))
        case "done": return .done
        case "error": return .failed(object["message"] as? String ?? "The writer could not answer.")
        default: return nil
        }
    }

    private func deliver(_ event: Event) {
        guard !ended else { return }
        switch event {
        case .done, .failed: ended = true
        default: break
        }
        onEvent(event)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        status = (response as? HTTPURLResponse)?.statusCode ?? 200
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        // A refusal is one JSON object, not lines of events.
        guard status == 200 else { refusal.append(data); return }
        for line in lines.take(data) {
            if let event = Self.event(line) { deliver(event) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if status != 200 {
            let answer = (try? JSONSerialization.jsonObject(with: refusal)) as? [String: Any]
            let message = (answer?["error"] as? [String: Any])?["message"] as? String
            deliver(.failed(message ?? "Lasso could not start the writer."))
        } else {
            // The connection closed with no ending: the server stopped, or the writer went quiet for too long.
            deliver(.failed("The writer stopped answering."))
        }
        session.finishTasksAndInvalidate()
        self.session = nil
    }
}
