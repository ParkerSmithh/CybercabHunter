import SwiftUI

struct PushDestination: Identifiable {
    let id = UUID()
    let url: URL
}
struct PushDestinationView: View {
    let destination: PushDestination
    @Environment(SessionStore.self) private var session
    @State private var days: [DailyReport.Day] = []
    @State private var sighting: PublicSighting?
    @State private var article: URL?
    @State private var message = "Loading…"
    var body: some View {
        Group {
            if let sighting { SightingViewer(sighting: sighting) }
            else if let article { SafariView(url: article) }
            else if destination.url.path == "/news" { Text(message).foregroundStyle(.secondary) }
            else if destination.url.path == "/sightings" { Text(message).foregroundStyle(.secondary) }
            else if destination.url.path == "/heatmap" { ZonesView(initialHeat: true, initialCity: URLComponents(url: destination.url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "city" })?.value) }
            else if destination.url.path == "/dmv" { DMVRosterView() }
            else {
                List {
                    ForEach(days, id: \.date) { day in
                        Section(day.date) {
                            LabeledContent("New Cybercabs", value: day.registry.map(String.init) ?? "Unavailable")
                            LabeledContent("DMV additions", value: day.dmv.map(String.init) ?? "Unavailable")
                            LabeledContent("Sightings", value: day.sightings.map(String.init) ?? "Unavailable")
                            LabeledContent("Camera detections", value: day.cameras.map(String.init) ?? "Unavailable")
                        }
                    }
                    if days.isEmpty { Text(message).foregroundStyle(.secondary) }
                }.navigationTitle("Cybercab Daily").appBackground()
            }
        }
        .task { await load() }
    }
    private func load() async {
        let query = URLComponents(url: destination.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if destination.url.path == "/sightings", let id = query.first(where: { $0.name == "sighting" })?.value {
            sighting = try? await session.api.get("/api/push/sighting", query: [URLQueryItem(name: "id", value: id)], authenticated: true, fresh: true)
            message = "This sighting is no longer public or its photo has expired."
        } else if destination.url.path == "/news", let id = query.first(where: { $0.name == "article" })?.value {
            struct Article: Decodable, Sendable { let url: String }
            if let result: Article = try? await session.api.get("/api/push/news", query: [URLQueryItem(name: "article", value: id)], authenticated: true, fresh: true),
               let url = URL(string: result.url), ["http", "https"].contains(url.scheme) { article = url }
            message = "This news article is no longer available."
        } else if let date = query.first(where: { $0.name == "daily" })?.value {
            struct Report: Decodable, Sendable { let days: [DailyReport.Day] }
            do {
                let report: Report = try await session.api.get("/api/push/report", query: [URLQueryItem(name: "date", value: date), URLQueryItem(name: "days", value: query.first(where: { $0.name == "days" })?.value ?? "1")], authenticated: true, fresh: true)
                days = report.days; message = "This report is unavailable."
            } catch { message = "Couldn't load this report. Sign in and try again." }
        }
    }
}
