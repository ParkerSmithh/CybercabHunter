import AppIntents
import SwiftUI
import WidgetKit

// Controls (iOS 18+, the app's deployment target): the same four appear in
// Control Center, in the Lock Screen's two customizable bottom slots, and in
// Settings › Action Button › Controls. Each is a button whose intent opens the
// app (openAppWhenRun, Shared/QuickActions.swift) and hands its QuickAction to
// AppRouter.perform(_:), the one navigation path for every system entry point.
// They show no account data and fetch nothing: a static symbol and a name.

/// Kinds are stable identifiers: renaming one removes it from people's Control
/// Center, so they never change.
enum ControlKind {
    static let newSighting = "com.cybercabhunter.control.new-sighting"
    static let map = "com.cybercabhunter.control.map"
    static let fleet = "com.cybercabhunter.control.fleet"
    static let community = "com.cybercabhunter.control.community"
}

/// New Sighting: the sighting form with the camera (the rider takes the photo).
struct NewSightingControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: ControlKind.newSighting) {
            ControlWidgetButton(action: OpenSightingCameraIntent()) {
                Label(QuickAction.camera.title, systemImage: QuickAction.camera.systemImage)
            }
        }
        .displayName("New Sighting")
        .description("Opens Cybercab Hunter's camera to photograph a Cybercab. Nothing is submitted until you tap Submit.")
    }
}

/// Cybercab Map: the Zones map on the last city (no location needed).
struct CybercabMapControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: ControlKind.map) {
            ControlWidgetButton(action: OpenCybercabMapIntent()) {
                Label(QuickAction.map.title, systemImage: QuickAction.map.systemImage)
            }
        }
        .displayName("Cybercab Map")
        .description("Opens the Zones map on the city you last looked at.")
    }
}

/// Fleet Stats: Home's fleet dashboard.
struct FleetStatsControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: ControlKind.fleet) {
            ControlWidgetButton(action: OpenFleetDashboardIntent()) {
                Label(QuickAction.fleet.title, systemImage: QuickAction.fleet.systemImage)
            }
        }
        .displayName("Fleet Stats")
        .description("Opens the Cybercab Hunter fleet dashboard.")
    }
}

/// Community: the Community tab.
struct CommunityControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: ControlKind.community) {
            ControlWidgetButton(action: OpenCommunityIntent()) {
                Label(QuickAction.community.title, systemImage: QuickAction.community.systemImage)
            }
        }
        .displayName("Community")
        .description("Opens Cybercab Hunter Community.")
    }
}
