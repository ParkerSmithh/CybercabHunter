// Apple's app schemas (App Intents `.system`, `.photos`, `.mail`… domains) and
// Cybercab Hunter: none is adopted.
//
// • `.system.searchInApp` was adopted (Oct 23, 2026) and withdrawn: Siri AI
//   routes loose requests to an app's search schema ("give me a rundown of the
//   Cybercab Hunter data" arrived as a search for that sentence), and a
//   search-schema intent can't run in the background (the App Intents compiler:
//   "'ShowInAppSearchResultsIntent' does not support '.background'"), so every
//   such request opened the app. Requests for a summary must be answered in
//   Siri; vehicle look-ups go through FindVehicleIntent / OpenVehicleIntent.
// • `.system.open` isn't adopted: the App Intents compiler allows one OpenIntent
//   per entity type, VehicleEntity's is OpenVehicleIntent (needed back to
//   iOS 18), and the schema exists only on iOS 27.
// • No other domain describes a vehicle tracker, and none covers questions
//   about statistics.
