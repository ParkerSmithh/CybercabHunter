import AppIntents

// Apple's app schemas that genuinely describe Cybercab Hunter (iOS 27: the
// `.system` domain, which any app that searches its content can adopt). It
// puts the action in the toolbox Siri AI draws on, so Siri can map everyday
// wording ("search Cybercab Hunter for XVF1524") without a fixed phrase. No other domain fits a vehicle tracker,
// so none is adopted (and none covers questions about statistics).

/// Search Cybercabs by plate or VIN: the Cars tab's own search.
@available(iOS 27.0, *)
@AppIntent(schema: .system.searchInApp)
struct SearchCybercabsIntent: ShowInAppSearchResultsIntent {
    static let searchScopes: [StringSearchScope] = [.general]
    var criteria: StringSearchCriteria

    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.searchRegistry(criteria.term)
        return .result()
    }
}

// `.system.open` isn't adopted: the App Intents compiler allows one OpenIntent
// per entity type, VehicleEntity's is OpenVehicleIntent (needed back to iOS 18),
// and the schema exists only on iOS 27. Adopting it means an iOS 27 minimum.
