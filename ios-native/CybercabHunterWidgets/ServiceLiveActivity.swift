import ActivityKit
import SwiftUI
import WidgetKit

// The Cybercab Daily Live Activity: Dynamic Island (compact, minimal,
// expanded) and the Lock Screen, showing today's camera detections and
// sightings (Robotaxi service runs 24/7: no countdown). Started, updated and
// ended only by the app (ServiceLiveActivityController), and only when the
// rider has turned it on in the Cybercab Daily card. Data: Shared/DailyActivity.swift;
// views: Shared/ServiceActivityViews.swift.
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
            .keylineTint(d.lit ? ServiceActivityPalette.gold : ServiceActivityPalette.fog)
            .widgetURL(WidgetLink.url("home"))
        }
    }
}

extension ActivityViewContext<ServiceActivityAttributes> {
    /// The state as drawn: stale once its stale date has passed without an
    /// update (nothing polls in the background), or when it carries no day
    /// (an activity from an earlier build, until the app replaces it).
    var display: ServiceActivityDisplay {
        ServiceActivityDisplay(detections: state.detections, sightings: state.sightings, detectionsYesterday: state.detectionsYesterday,
                               updated: state.updated, city: attributes.cityName, stale: isStale || state.day.isEmpty)
    }
}
