import Testing
import Foundation
import SwiftUI
import UIKit
@testable import CybercabHunter

/// iPhone system entry points: Control Center / Lock Screen controls, the
/// Action Button and Shortcuts all name a QuickAction and reach the app's one
/// router (AppRouter.perform) through QuickActionCenter. The controls
/// themselves live in the widget extension; their intents are the ones here.
@MainActor
@Suite(.serialized)
struct SystemControlsTests {
    /// A clean shared router for each check (the app has one router).
    private func freshRouter() -> AppRouter {
        let r = AppRouter.shared
        r.selectedTab = .home
        r.submitSightingRequested = false
        r.submitSightingWithCamera = false
        r.zonesCity = nil
        r.homePath = NavigationPath()
        r.communityPath = NavigationPath()
        r.perform(.open, now: .distantPast)   // clears the duplicate guard for the next request
        return r
    }

    // MARK: Actions and links

    @Test func everyActionHasALinkThatRoundTrips() {
        for a in QuickAction.allCases {
            #expect(QuickAction(url: a.url) == a, "\(a)")
            #expect(a.url.scheme == "cybercabhunter-widget" && a.url.host() == "action")
        }
        #expect(QuickAction(url: URL(string: "cybercabhunter-widget://action?do=nonsense")!) == nil)
        #expect(QuickAction(url: URL(string: "cybercabhunter-widget://zones?city=dallas")!) == nil, "the widgets' own links are untouched")
        #expect(QuickAction(url: URL(string: "https://cybercabhunter.com/zones")!) == nil)
    }

    @Test func onlyTheCameraActionUsesTheCamera() {
        #expect(QuickAction.allCases.filter(\.usesCamera) == [.camera])
        #expect(QuickAction.allCases.filter(\.opensSightingForm) == [.camera, .newSighting])
    }

    @Test func symbolsAreSystemSymbols() {
        for a in QuickAction.allCases {
            #expect(UIImage(systemName: a.systemImage) != nil, "\(a.systemImage) exists as an SF Symbol")
        }
    }

    // MARK: Each intent opens its destination through the one router

    @Test func cameraIntentOpensTheFormWithTheCamera() async throws {
        let r = freshRouter()
        _ = try await OpenSightingCameraIntent().perform()
        #expect(r.selectedTab == .sightings && r.submitSightingRequested && r.submitSightingWithCamera)
        #expect(r.lastQuickAction?.action == .camera)
    }

    @Test func newSightingIntentOpensTheFormWithoutTheCamera() async throws {
        let r = freshRouter()
        _ = try await SubmitSightingIntent().perform()
        #expect(r.selectedTab == .sightings && r.submitSightingRequested && !r.submitSightingWithCamera)
    }

    @Test func mapIntentOpensZonesWithoutForcingACity() async throws {
        let r = freshRouter()
        _ = try await OpenCybercabMapIntent().perform()
        #expect(r.selectedTab == .zones)
        #expect(r.zonesCity == nil, "Zones keeps the rider's own city")
    }

    @Test func fleetIntentOpensHomeAtItsTop() async throws {
        let r = freshRouter()
        r.selectedTab = .community
        r.homePath.append(ExploreRoute.dmv)
        _ = try await OpenFleetDashboardIntent().perform()
        #expect(r.selectedTab == .home && r.homePath.isEmpty)
    }

    @Test func communityIntentOpensCommunity() async throws {
        let r = freshRouter()
        r.communityPath.append(PostRoute(id: "p1"))
        _ = try await OpenCommunityIntent().perform()
        #expect(r.selectedTab == .community && r.communityPath.isEmpty)
    }

    @Test func openIntentLeavesTheAppAsItWas() async throws {
        let r = freshRouter()
        r.selectedTab = .registry
        _ = try await OpenCybercabHunterIntent().perform()
        #expect(r.selectedTab == .registry)
    }

    @Test func allIntentsOpenTheAppAndNeverRunInTheBackground() {
        #expect(OpenSightingCameraIntent.openAppWhenRun)
        #expect(SubmitSightingIntent.openAppWhenRun)
        #expect(OpenCybercabMapIntent.openAppWhenRun)
        #expect(OpenFleetDashboardIntent.openAppWhenRun)
        #expect(OpenCommunityIntent.openAppWhenRun)
        #expect(OpenCybercabHunterIntent.openAppWhenRun)
    }

    // MARK: One navigation path, no duplicates, no lost cold-launch requests

    @Test func aRequestBeforeTheAppConnectsIsDeliveredOnce() {
        QuickActionCenter.reset()
        QuickActionCenter.request(.map)
        #expect(QuickActionCenter.pending == .map, "a cold launch: kept until the router connects")
        var got: [QuickAction] = []
        QuickActionCenter.connect { got.append($0) }
        #expect(got == [.map] && QuickActionCenter.pending == nil)
        QuickActionCenter.request(.fleet)
        #expect(got == [.map, .fleet], "connected: delivered at once")
        QuickActionCenter.reset()
        AppRouter.shared.connectQuickActions()   // back to the app's router
    }

    @Test func aDoubleTapNavigatesOnce() {
        let r = freshRouter()
        let t = Date()
        #expect(r.perform(.community, now: t))
        let before = r.presentationReset
        #expect(!r.perform(.community, now: t.addingTimeInterval(0.4)), "the same action within a second is ignored")
        #expect(r.presentationReset == before)
        #expect(r.perform(.map, now: t.addingTimeInterval(0.5)), "a different action goes through")
        #expect(r.perform(.community, now: t.addingTimeInterval(1.6)), "the same action later goes through")
        #expect(r.selectedTab == .community)
    }

    @Test func theLastRequestWins() {
        let r = freshRouter()
        let t = Date()
        r.perform(.map, now: t)
        r.perform(.fleet, now: t.addingTimeInterval(0.1))
        #expect(r.selectedTab == .home && r.lastQuickAction?.action == .fleet)
    }

    @Test func eachRequestAsksOpenSheetsToClose() {
        let r = freshRouter()
        let before = r.presentationReset
        r.perform(.fleet, now: Date().addingTimeInterval(5))
        #expect(r.presentationReset == before &+ 1)
    }

    @Test func theLinkFormGoesThroughTheSameRouter() {
        let r = freshRouter()
        #expect(r.open(widgetURL: QuickAction.community.url))
        #expect(r.selectedTab == .community && r.lastQuickAction?.action == .community)
        #expect(r.open(widgetURL: URL(string: "cybercabhunter-widget://action?do=unknown")!), "an unknown action still opens the app (Home)")
        #expect(r.selectedTab == .home)
        #expect(r.open(widgetURL: URL(string: "cybercabhunter-widget://zones?city=dallas")!) && r.zonesCity == "dallas", "existing widget links unchanged")
        r.zonesCity = nil
    }

    @Test func aDraftIsNeverLostWithoutAsking() {
        let r = freshRouter()
        r.sightingFormHasDraft = true
        defer { r.sightingFormHasDraft = false; r.draftConflict = nil }
        r.selectedTab = .sightings
        #expect(!r.perform(.map, now: Date().addingTimeInterval(10)), "held: the form asks first")
        #expect(r.draftConflict == .map && r.selectedTab == .sightings)
        #expect(r.perform(.map, now: Date().addingTimeInterval(11), leavingDraft: true), "the rider chose Leave")
        #expect(r.selectedTab == .zones)
        r.draftConflict = nil
        #expect(r.perform(.newSighting, now: Date().addingTimeInterval(12)), "a sighting request with a draft open keeps the form (no conflict)")
        #expect(r.draftConflict == nil)
    }

    // MARK: The map's city: per app session, Austin on a fresh launch

    @Test func zonesCityHoldsForTheSessionOnly() {
        let before = ZonesModel.sessionCity
        defer { ZonesModel.sessionCity = before }
        ZonesModel.sessionCity = "austin"   // what a new process starts with
        #expect(ZonesModel().city == "austin", "a fresh launch opens Austin")
        let m = ZonesModel()
        m.city = "dallas"
        #expect(ZonesModel().city == "dallas", "the rest of the session (a rebuilt screen, back from the background) keeps Dallas")
        #expect(UserDefaults.standard.string(forKey: ZonesModel.legacyCityKey) == nil, "nothing saved for the next launch")
    }

    @Test func siriOpenTheMapNoLongerForcesAustin() {
        let r = freshRouter()
        r.open(AppDestination.map)
        #expect(r.selectedTab == .zones && r.zonesCity == nil)
    }
}
