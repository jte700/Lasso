// Mounted external storage discovery. Native code supplies trusted volume
// identity and availability; indexing remains an explicit choice in the UI.
import Cocoa
import DiskArbitration

struct ExternalDriveVolume: Codable, Equatable {
    let id: String
    let name: String
    let rootPath: String
}

struct ExternalDriveChange {
    let added: [ExternalDriveVolume]
    let removed: [ExternalDriveVolume]

    var notice: String? {
        if !added.isEmpty && !removed.isEmpty {
            return "External drives changed. Choose what to index or whether to keep disconnected indexes."
        }
        if let first = added.first {
            let subject = added.count == 1 ? first.name : "\(added.count) external drives"
            return "\(subject) connected. Open Lasso to index a drive or choose folders."
        }
        if let first = removed.first {
            let subject = removed.count == 1 ? first.name : "\(removed.count) external drives"
            return "\(subject) disconnected. Open Lasso to keep or remove any saved indexes."
        }
        return nil
    }
}

final class ExternalDriveMonitor {
    var onInventorySynced: ((ExternalDriveChange) -> Void)?

    private let scanQueue = DispatchQueue(label: "com.lasso.external-drive-discovery", qos: .utility)
    private var observers: [NSObjectProtocol] = []
    private var timer: Timer?
    private var request: URLSessionDataTask?
    private var serverURL: URL?
    private var token = ""
    private var generation = UUID()
    private var scanning = false
    private var refreshPending = false
    private var lastAnnounced: [ExternalDriveVolume] = []

    func start(serverURL: URL, token: String) {
        stop()
        self.serverURL = serverURL
        self.token = token
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didMountNotification, NSWorkspace.didUnmountNotification,
                     NSWorkspace.didRenameVolumeNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.refresh()
            })
        }
        // Reconcile after sleep, missed notifications, or a temporary failed request.
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
    }

    func stop() {
        generation = UUID()
        timer?.invalidate()
        timer = nil
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        observers.removeAll()
        request?.cancel()
        request = nil
        serverURL = nil
        token = ""
        scanning = false
        refreshPending = false
    }

    private func refresh() {
        guard serverURL != nil else { return }
        guard !scanning, request == nil else {
            refreshPending = true
            return
        }
        scanning = true
        let current = generation
        scanQueue.async { [weak self] in
            let volumes = Self.mountedExternalVolumes()
            DispatchQueue.main.async {
                guard let self, self.generation == current else { return }
                self.scanning = false
                guard let volumes else { self.finishRefresh(); return }
                // Resend unchanged inventories too: a previous successful HTTP
                // response may have omitted a temporarily unreadable volume.
                self.sync(volumes, generation: current)
            }
        }
    }

    private func sync(_ volumes: [ExternalDriveVolume], generation current: UUID) {
        guard let url = serverURL?.appendingPathComponent("api/drives/sync"),
              let body = try? JSONEncoder().encode(["volumes": volumes]) else { finishRefresh(); return }
        var upload = URLRequest(url: url)
        upload.httpMethod = "POST"
        upload.timeoutInterval = 4
        upload.setValue("application/json", forHTTPHeaderField: "Content-Type")
        upload.setValue(token, forHTTPHeaderField: "x-lasso-drive-token")
        upload.httpBody = body
        request = URLSession.shared.dataTask(with: upload) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self, self.generation == current else { return }
                self.request = nil
                if error == nil, let response = response as? HTTPURLResponse,
                   (200..<300).contains(response.statusCode) {
                    let oldIds = Set(self.lastAnnounced.map(\.id))
                    let newIds = Set(volumes.map(\.id))
                    let change = ExternalDriveChange(
                        added: volumes.filter { !oldIds.contains($0.id) },
                        removed: self.lastAnnounced.filter { !newIds.contains($0.id) })
                    self.lastAnnounced = volumes
                    self.onInventorySynced?(change)
                }
                self.finishRefresh()
            }
        }
        request?.resume()
    }

    private func finishRefresh() {
        if refreshPending {
            refreshPending = false
            refresh()
        }
    }

    /// Volume UUIDs survive renames and mount-path changes. A volume without
    /// a trustworthy persistent identity is omitted instead of matching by path.
    static func mountedExternalVolumes() -> [ExternalDriveVolume]? {
        let keys: Set<URLResourceKey> = [.volumeIsLocalKey, .volumeIsInternalKey,
            .volumeIsRemovableKey, .volumeUUIDStringKey, .volumeNameKey]
        guard let roots = FileManager.default.mountedVolumeURLs(
            includingResourceValuesForKeys: Array(keys), options: [.skipHiddenVolumes]),
              let session = DASessionCreate(kCFAllocatorDefault) else { return nil }
        var volumes: [ExternalDriveVolume] = []
        for root in roots {
            guard root.path != "/", let values = try? root.resourceValues(forKeys: keys),
                  values.volumeIsLocal == true,
                  let disk = DADiskCreateFromVolumePath(kCFAllocatorDefault, session, root as CFURL),
                  let raw = DADiskCopyDescription(disk) else { continue }
            let description = raw as NSDictionary
            let isInternal = description[kDADiskDescriptionDeviceInternalKey] as? Bool
            let removable = (description[kDADiskDescriptionMediaRemovableKey] as? Bool) == true
            guard values.volumeIsInternal == false || isInternal == false || removable || values.volumeIsRemovable == true else { continue }
            guard (description[kDADiskDescriptionVolumeNetworkKey] as? Bool) != true else { continue }
            // Disk images are local/ejectable too, but are not attached storage.
            let transport = (description[kDADiskDescriptionDeviceProtocolKey] as? String ?? "").lowercased()
            let model = (description[kDADiskDescriptionDeviceModelKey] as? String ?? "").lowercased()
            guard !transport.contains("virtual"), !transport.contains("disk image"),
                  !model.contains("disk image") else { continue }
            guard let uuid = values.volumeUUIDString?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !uuid.isEmpty else { continue }
            volumes.append(ExternalDriveVolume(id: "macos-volume:\(uuid.lowercased())",
                name: values.volumeName ?? root.lastPathComponent, rootPath: root.standardizedFileURL.path))
        }
        // A cloned filesystem can advertise the same UUID. Never merge two
        // simultaneously mounted drives, or redirect a remembered index to one.
        let counts = Dictionary(grouping: volumes, by: \.id).mapValues(\.count)
        return volumes.filter { counts[$0.id] == 1 }.sorted { $0.id < $1.id }
    }
}

/// A brief menu-bar notice that never activates Lasso or takes keyboard focus.
final class ExternalDriveNoticePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
