import ActivityKit
import SwiftUI
import WidgetKit

// The Cybercab service-status Live Activity: Dynamic Island (compact,
// minimal, expanded) and the Lock Screen. Started, updated and ended only by
// the app (ServiceLiveActivityController), and only when the rider has turned
// it on in the Live now card. Views: Shared/ServiceActivityViews.swift.
struct ServiceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ServiceActivityAttributes.self) { context in
            ServiceLockScreen(d: context.display)
                .activityBackgroundTint(ServiceActivityPalette.background)
                .activitySystemActionForegroundColor(ServiceActivityPalette.gold)
                .widgetURL(WidgetLink.url("home"))
        } dynamicIsland: { context in
            let d = context.display
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { ServiceExpandedLeading(d: d) }
                DynamicIslandExpandedRegion(.bottom) { ServiceExpandedBottom(d: d) }
            } compactLeading: {
                ServiceCompactLeading(d: d)
            } compactTrailing: {
                ServiceCompactTrailing(d: d)
            } minimal: {
                ServiceMinimal(d: d)
            }
            .keylineTint(d.live ? ServiceActivityPalette.gold : ServiceActivityPalette.parked)
            .widgetURL(WidgetLink.url("home"))
        }
    }
}

extension ActivityViewContext<ServiceActivityAttributes> {
    /// The state as drawn: stale once its `until` has passed without an update
    /// (the app wasn't opened at the change, and nothing polls in the background).
    var display: ServiceActivityDisplay {
        ServiceActivityDisplay(live: state.live, since: state.since, until: state.until, stale: isStale,
                               openLabel: attributes.openLabel, closeLabel: attributes.closeLabel)
    }
}
