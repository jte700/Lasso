// A native source picker. Choosing a result only previews it; insertion remains
// an explicit action after focus has returned to the user's document.
import Cocoa

final class SourceChooserController: NSObject, NSTableViewDataSource, NSTableViewDelegate,
                                     NSSearchFieldDelegate, NSWindowDelegate {
    static let shared = SourceChooserController()
    private var panel: NSPanel?
    private let search = NSSearchField()
    private let documents = NSPopUpButton()
    private let table = NSTableView()
    private let status = NSTextField(labelWithString: "")
    private let choose = NSButton(title: "Preview source", target: nil, action: nil)
    private var objects: [[String: Any]] = []
    private var matches: [[String: Any]] = []
    private var request: URLSessionDataTask?
    private var generation = 0
    private var completion: (([String: Any]?) -> Void)?
    private var host: NSRunningApplication?
    var isVisible: Bool { panel?.isVisible == true }

    func show(serverURL: URL, sourceProjectId: String?, sourcePath: String?,
              completion: @escaping ([String: Any]?) -> Void) {
        self.completion = completion
        host = NSWorkspace.shared.frontmostApplication
        let panel = existingPanel()
        search.stringValue = ""
        objects = []; matches = []; table.reloadData()
        choose.isEnabled = false
        documents.removeAllItems(); documents.addItem(withTitle: "All documents")
        status.stringValue = "Loading sources…"
        panel.center()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(search)
        generation += 1
        let token = generation
        request?.cancel()
        request = URLSession.shared.dataTask(with: serverURL.appendingPathComponent("api/workspace/source-library")) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self, token == self.generation, self.isVisible else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let objects = payload["objects"] as? [[String: Any]] else {
                    self.status.stringValue = "Sources could not be loaded. Close and try again."
                    return
                }
                self.objects = objects.sorted {
                    let left = ($0["path"] as? String ?? "") + ($0["label"] as? String ?? "")
                    let right = ($1["path"] as? String ?? "") + ($1["label"] as? String ?? "")
                    return left.localizedStandardCompare(right) == .orderedAscending
                }
                var seen = Set<String>()
                for object in self.objects {
                    guard let path = object["path"] as? String, let project = object["projectId"] as? String else { continue }
                    let key = project + "|" + path
                    guard seen.insert(key).inserted else { continue }
                    let name = object["projectName"] as? String ?? "Directory"
                    self.documents.addItem(withTitle: name + " · " + path)
                    self.documents.lastItem?.representedObject = key
                    if sourcePath == path && sourceProjectId == project {
                        self.documents.selectItem(at: self.documents.numberOfItems - 1)
                    }
                }
                self.filter()
            }
        }
        request?.resume()
    }

    private func existingPanel() -> NSPanel {
        if let panel { return panel }
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 590, height: 430),
                            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Choose a source"
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 590, height: 430))
        documents.frame = NSRect(x: 18, y: 383, width: 554, height: 28)
        documents.target = self; documents.action = #selector(filter)
        documents.setAccessibilityLabel("Source document")
        search.frame = NSRect(x: 18, y: 343, width: 554, height: 28)
        search.placeholderString = "Find a row, value, or source"
        search.delegate = self
        search.setAccessibilityLabel("Search sources")
        let scroll = NSScrollView(frame: NSRect(x: 18, y: 66, width: 554, height: 263))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("source")))
        table.tableColumns[0].width = 534
        table.headerView = nil
        table.rowHeight = 49
        table.usesAlternatingRowBackgroundColors = true
        table.delegate = self; table.dataSource = self
        table.target = self; table.doubleAction = #selector(accept)
        scroll.documentView = table
        status.frame = NSRect(x: 20, y: 22, width: 300, height: 20)
        status.font = .systemFont(ofSize: 11)
        status.textColor = .secondaryLabelColor
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancel.bezelStyle = .rounded
        cancel.keyEquivalent = "\u{1b}"
        cancel.frame = NSRect(x: 346, y: 15, width: 88, height: 32)
        choose.frame = NSRect(x: 436, y: 15, width: 138, height: 32)
        choose.bezelStyle = .rounded
        choose.keyEquivalent = "\r"
        choose.target = self; choose.action = #selector(accept)
        [documents, search, scroll, status, cancel, choose].forEach { content.addSubview($0) }
        panel.contentView = content
        self.panel = panel
        return panel
    }

    @objc private func filter() {
        let path = documents.selectedItem?.representedObject as? String
        let query = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let results = objects.filter { object in
            if let path, (object["projectId"] as? String ?? "") + "|" + (object["path"] as? String ?? "") != path { return false }
            let content = [object["label"], object["valueText"], object["path"]]
                .compactMap { $0 as? String }.joined(separator: " ")
            return query.isEmpty || query.split(separator: " ").allSatisfy {
                content.localizedCaseInsensitiveContains(String($0))
            }
        }
        matches = Array(results.prefix(300))
        table.reloadData()
        if !matches.isEmpty { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
        choose.isEnabled = !matches.isEmpty
        status.stringValue = results.isEmpty ? "No matching sources" : results.count > 300
            ? "Showing 300 results. Search to narrow them." : "\(results.count) sources · ↑↓ to select"
    }

    func numberOfRows(in tableView: NSTableView) -> Int { matches.count }
    func tableViewSelectionDidChange(_ notification: Notification) { choose.isEnabled = table.selectedRow >= 0 }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let object = matches[row]
        let cell = NSTableCellView(frame: NSRect(x: 0, y: 0, width: 530, height: 49))
        let label = NSTextField(labelWithString: object["label"] as? String ?? "Source")
        label.frame = NSRect(x: 10, y: 25, width: 514, height: 18)
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.lineBreakMode = .byTruncatingTail
        let anchor = object["anchor"] as? [String: Any] ?? [:]
        let detail = [object["projectName"], object["path"], anchor["column"], object["valueText"]]
            .compactMap { $0 as? String }.filter { !$0.isEmpty }.joined(separator: " · ")
        let subtitle = NSTextField(labelWithString: detail)
        subtitle.frame = NSRect(x: 10, y: 7, width: 514, height: 15)
        subtitle.font = .systemFont(ofSize: 10)
        subtitle.textColor = .secondaryLabelColor
        subtitle.lineBreakMode = .byTruncatingTail
        cell.textField = label
        cell.addSubview(label); cell.addSubview(subtitle)
        return cell
    }
    func controlTextDidChange(_ notification: Notification) { filter() }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.moveDown(_:)) || selector == #selector(NSResponder.moveUp(_:)) {
            let delta = selector == #selector(NSResponder.moveDown(_:)) ? 1 : -1
            let index = max(0, min(matches.count - 1, table.selectedRow + delta))
            if !matches.isEmpty {
                table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
                table.scrollRowToVisible(index)
            }
            return true
        }
        if selector == #selector(NSResponder.insertNewline(_:)) { accept(); return true }
        if selector == #selector(NSResponder.cancelOperation(_:)) { cancel(); return true }
        return false
    }
    @objc private func accept() {
        guard table.selectedRow >= 0, table.selectedRow < matches.count else { return }
        finish(matches[table.selectedRow])
    }
    @objc private func cancel() { finish(nil) }
    func windowShouldClose(_ sender: NSWindow) -> Bool { cancel(); return false }
    private func finish(_ object: [String: Any]?) {
        generation += 1; request?.cancel()
        panel?.orderOut(nil)
        let callback = completion; completion = nil
        host?.activate(options: [])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { callback?(object) }
    }
}
