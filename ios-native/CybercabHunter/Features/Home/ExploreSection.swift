import SwiftUI

/// The website's other pages, reached from Home (the five tabs stay as they
/// are): Simulation, News and the Texas DMV roster, each a native screen
/// pushed in Home's own navigation stack.
enum ExploreRoute: Hashable {
    case simulation(SimulationModel.View)
    case news
    case dmv
}

struct ExploreSection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: "Explore")
            VStack(spacing: 10) {
                card(.simulation(.roi), icon: "chart.line.uptrend.xyaxis", title: "Simulation", text: "Fleet ROI and Fleet ETA: fare and pickup-wait estimates for Austin and Dallas.", id: "exploreSimulation")
                card(.news, icon: "newspaper.fill", title: "News", text: "Every Cybercab and robotaxi headline, linked to the original reporting.", id: "exploreNews")
                card(.dmv, icon: "doc.text.magnifyingglass", title: "Texas DMV roster", text: "Every VIN Tesla Robotaxi, LLC lists with the Texas DMV, from the daily snapshot.", id: "exploreDMV")
            }
        }
    }

    private func card(_ route: ExploreRoute, icon: String, title: String, text: String, id: String) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 18, weight: .semibold)).foregroundStyle(Color.brandGold)
                    .frame(width: 40, height: 40).background(Color.brandGold.opacity(0.12), in: .rect(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.inter(16, .bold)).foregroundStyle(Color.chInk)
                    Text(text).font(.inter(12.5)).foregroundStyle(Color.chFog).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.chCaption)
            }
            .padding(14)
            .background(Color.chSurface, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}

/// The destinations of Home's Explore row.
struct ExploreDestination: View {
    let route: ExploreRoute
    var body: some View {
        switch route {
        case .simulation(let view): SimulationView(initialView: view)
        case .news: NewsView()
        case .dmv: DMVRosterView()
        }
    }
}
