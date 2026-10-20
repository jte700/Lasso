import ServiceManagement

/// Opens Lasso when the user logs in, so suggestions and highlights are
/// available after a restart without adding the app to Login Items by hand.
enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    /// macOS may hold a new login item until the user allows it in System Settings.
    static var needsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }

    static func setEnabled(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }

    static func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}
