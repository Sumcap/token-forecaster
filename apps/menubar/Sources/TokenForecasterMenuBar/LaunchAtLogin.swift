import Foundation
import ServiceManagement

/// Wraps SMAppService so the menu can reflect and toggle login-item state.
/// Only meaningful once the executable is running from inside a real .app
/// bundle; from a bare SwiftPM binary registration will fail, which we report
/// rather than crash on.
enum LaunchAtLogin {

    static var isSupported: Bool {
        if #available(macOS 13, *) { return true }
        return false
    }

    static var isEnabled: Bool {
        guard #available(macOS 13, *) else { return false }
        return SMAppService.mainApp.status == .enabled
    }

    static var requiresApproval: Bool {
        guard #available(macOS 13, *) else { return false }
        return SMAppService.mainApp.status == .requiresApproval
    }

    /// Returns nil on success, or a human-readable failure reason.
    static func set(_ enabled: Bool) -> String? {
        guard #available(macOS 13, *) else {
            return "Launch at login requires macOS 13 or later."
        }
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}
