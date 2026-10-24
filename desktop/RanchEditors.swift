// Which app edits a file. The Ranch only shows files; its Edit button hands
// the file to the app that would change it: the Mac's default for the file
// (Excel, Word, Numbers, Fusion), or Google Docs, Sheets or Slides on the web
// for a file kept in Google Drive.

import Cocoa

struct RanchEditor: Identifiable {
    enum Target: Equatable {
        case application(URL)
        case web(URL)
    }

    let id: String
    let name: String
    let target: Target

    /// Sized for a toolbar button or menu item.
    var icon: NSImage? {
        switch target {
        case .application(let app):
            let icon = NSWorkspace.shared.icon(forFile: app.path)
            icon.size = NSSize(width: 16, height: 16)
            return icon
        case .web: return NSImage(systemSymbolName: "globe", accessibilityDescription: nil)
        }
    }

    /// False only when macOS could not hand the file over.
    @discardableResult
    func open(_ file: URL) -> Bool {
        switch target {
        case .application(let app):
            NSWorkspace.shared.open([file], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error { NSLog("The Ranch could not open %@ in %@: %@", file.path, app.path, error.localizedDescription) }
            }
            return true
        case .web(let page):
            return NSWorkspace.shared.open(page)
        }
    }
}

enum RanchEditors {
    /// Files Google Drive for desktop keeps for documents that live only on the web.
    private static let googleNative: [String: String] = [
        "gdoc": "Google Docs", "gsheet": "Google Sheets", "gslides": "Google Slides",
        "gdraw": "Google Drawings", "gform": "Google Forms",
    ]
    /// Google's web editor for a Drive file of each kind.
    private static let googleEditors: [String: String] = [
        "xlsx": "Google Sheets", "xls": "Google Sheets", "csv": "Google Sheets", "tsv": "Google Sheets", "ods": "Google Sheets",
        "docx": "Google Docs", "doc": "Google Docs", "rtf": "Google Docs", "odt": "Google Docs", "txt": "Google Docs",
        "pptx": "Google Slides", "ppt": "Google Slides", "odp": "Google Slides",
    ]
    /// What to install when no app on this Mac edits the file.
    private static let suggestedApps: [String: String] = [
        "f3d": "Autodesk Fusion", "f3z": "Autodesk Fusion", "step": "Autodesk Fusion or FreeCAD", "stp": "Autodesk Fusion or FreeCAD",
        "iges": "Autodesk Fusion or FreeCAD", "igs": "Autodesk Fusion or FreeCAD", "sldprt": "SOLIDWORKS", "sldasm": "SOLIDWORKS",
        "ipt": "Autodesk Inventor", "iam": "Autodesk Inventor", "dwg": "AutoCAD", "dxf": "AutoCAD", "rvt": "Autodesk Revit",
        "ifc": "a BIM app such as Revit or BIMcollab", "3dm": "Rhino", "catpart": "CATIA", "x_t": "Parasolid-based CAD",
        "xlsx": "Microsoft Excel or Numbers", "docx": "Microsoft Word or Pages", "pptx": "Microsoft PowerPoint or Keynote",
    ]
    private static let driveItemAttribute = "com.google.drivefs.item-id#S"
    private static let googleHosts: Set<String> = ["docs.google.com", "drive.google.com", "sheets.google.com", "slides.google.com"]
    /// Models and drawings, which only CAD software edits.
    private static let cadExtensions: Set<String> = [
        "step", "stp", "iges", "igs", "stl", "obj", "3mf", "ply", "f3d", "f3z", "sldprt", "sldasm", "slddrw", "ipt", "iam",
        "catpart", "catproduct", "x_t", "x_b", "3dm", "dxf", "dwg", "ifc", "rvt", "dgn", "landxml",
    ]
    /// Makers whose apps edit models and drawings.
    private static let cadMakers = [
        "com.autodesk.", "org.freecad", "com.mcneel.", "com.ptc.", "com.bentley.", "com.graphisoft.", "net.nemetschek.",
        "com.vectorworks", "com.trimble.", "com.sketchup.", "com.dassault", "com.solidworks", "com.siemens.", "org.librecad",
        "com.bricsys.", "com.shapr3d.", "com.onshape", "com.ultimaker.", "com.prusa3d.", "com.bambulab.", "org.blenderfoundation.",
    ]
    /// Apps that claim CAD files without editing them, such as Image Playground for DXF.
    private static let cadViewers: Set<String> = [
        "com.apple.GenerativePlaygroundApp", "com.apple.Preview", "com.apple.TextEdit", "com.apple.dt.Xcode", "com.apple.Photos",
    ]

    /// The app the Edit button uses.
    static func primary(for file: URL) -> RanchEditor? {
        let fileExtension = file.pathExtension.lowercased()
        if let name = googleNative[fileExtension], let page = googleNativePage(file) {
            return RanchEditor(id: "web:" + page.absoluteString, name: name, target: .web(page))
        }
        if cadExtensions.contains(fileExtension) { return cadEditor(for: file) }
        if let app = NSWorkspace.shared.urlForApplication(toOpen: file) {
            return RanchEditor(id: app.path, name: appName(app), target: .application(app))
        }
        // A text file no app claims, such as a STEP export on a Mac without CAD
        // software, can still be read and changed in TextEdit.
        if isText(file), let editor = NSWorkspace.shared.urlForApplication(toOpen: .plainText) {
            return RanchEditor(id: editor.path, name: appName(editor), target: .application(editor))
        }
        return nil
    }

    /// A CAD app that claims the file, or the default app when it is not just
    /// a viewer. Nothing, rather than an app that cannot edit a model.
    private static func cadEditor(for file: URL) -> RanchEditor? {
        let fallback = NSWorkspace.shared.urlForApplication(toOpen: file)
        let claiming = NSWorkspace.shared.urlsForApplications(toOpen: file)
        let bundle = { (app: URL) in Bundle(url: app)?.bundleIdentifier ?? "" }
        let chosen = ([fallback].compactMap { $0 } + claiming).first { app in cadMakers.contains { bundle(app).hasPrefix($0) } }
            ?? fallback.flatMap { cadViewers.contains(bundle($0)) ? nil : $0 }
        return chosen.map { RanchEditor(id: $0.path, name: appName($0), target: .application($0)) }
    }

    /// Every other app that can open the file, and Google's editor for a Drive file.
    static func alternatives(for file: URL, excluding primary: RanchEditor?) -> [RanchEditor] {
        let apps = NSWorkspace.shared.urlsForApplications(toOpen: file)
            .filter { $0.path != primary?.id }
            .map { RanchEditor(id: $0.path, name: appName($0), target: .application($0)) }
        var seen = Set<String>()
        let unique = apps.filter { seen.insert($0.name).inserted }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        guard primary.map({ if case .web = $0.target { return false } else { return true } }) ?? true,
              let name = googleEditors[file.pathExtension.lowercased()], let page = driveItemID(file).flatMap(googleOpenURL)
        else { return unique }
        return [RanchEditor(id: "web:" + page.absoluteString, name: name, target: .web(page))] + unique
    }

    /// "Install Autodesk Fusion to edit .f3d files." when nothing here can.
    static func missingEditorHint(for file: URL) -> String {
        let fileExtension = file.pathExtension.lowercased()
        let label = fileExtension.isEmpty ? "this file" : ".\(fileExtension) files"
        guard let app = suggestedApps[fileExtension] else { return "No app on this Mac edits \(label)." }
        return "No app on this Mac edits \(label). Install \(app) to edit it."
    }

    /// A .gdoc, .gsheet or .gslides file names its document as JSON, or
    /// Google Drive marks it with the item's id.
    static func googleNativePage(_ file: URL) -> URL? {
        if let data = try? Data(contentsOf: file, options: .mappedIfSafe), data.count < 64 * 1024,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            // Only Google's own editors: a file from mail could name any page.
            if let text = json["url"] as? String, let url = URL(string: text), url.scheme == "https",
               let host = url.host?.lowercased(), googleHosts.contains(host) { return url }
            if let id = json["doc_id"] as? String ?? json["resource_id"] as? String,
               let url = googleOpenURL(id) { return url }
        }
        return driveItemID(file).flatMap(googleOpenURL)
    }

    private static func googleOpenURL(_ id: String) -> URL? {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_:"))
        guard !id.isEmpty, id.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return URL(string: "https://drive.google.com/open?id=" + id)
    }

    /// Google Drive for desktop's id for a file in its folder, if it has one.
    static func driveItemID(_ file: URL) -> String? {
        file.withUnsafeFileSystemRepresentation { path -> String? in
            guard let path else { return nil }
            let size = getxattr(path, driveItemAttribute, nil, 0, 0, 0)
            guard size > 0, size < 512 else { return nil }
            var buffer = [UInt8](repeating: 0, count: size)
            guard getxattr(path, driveItemAttribute, &buffer, size, 0, 0) == size else { return nil }
            return String(bytes: buffer, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    static func appName(_ app: URL) -> String {
        (FileManager.default.displayName(atPath: app.path) as NSString).deletingPathExtension
    }

    private static func isText(_ file: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return false }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 4096), !head.isEmpty else { return false }
        return !head.contains(0)
    }
}
