# iPhone system controls: Control Center, Lock Screen, Action Button, Shortcuts

Cybercab Hunter opens its most-used screens straight from iOS. Everything is
native (WidgetKit controls + App Intents); nothing new on the website, the
Worker or the database.

## What there is

| Action | Control | Shortcuts action | Opens |
|---|---|---|---|
| New Sighting | ✅ `NewSightingControl` | **Open Cybercab Hunter Camera** (`OpenSightingCameraIntent`) | The sighting form, then Apple's camera (camera permission asked only here, the first time). No camera on the device: the form. Nothing is taken or submitted automatically. |
| Cybercab Map | ✅ `CybercabMapControl` | **Open Cybercab Map** (`OpenCybercabMapIntent`) | The Zones map on the city last chosen (remembered across launches). Never asks for location. |
| Fleet Stats | ✅ `FleetStatsControl` | **Open Fleet Dashboard** (`OpenFleetDashboardIntent`) | Home (the fleet dashboard), at its top, with its normal loading and caching. |
| Community | ✅ `CommunityControl` | **Open Cybercab Community** (`OpenCommunityIntent`) | The Community tab. |
| Start Sighting Submission | — | **New Cybercab Sighting** (`SubmitSightingIntent`, the existing type, so old shortcuts keep working) | The sighting form (no camera). |
| Open Cybercab Hunter | — | **Open Cybercab Hunter** (`OpenCybercabHunterIntent`) | The app where it was left. |

The four controls appear in Control Center, in the Lock Screen's two bottom
slots and under Settings › Action Button › Controls (all iOS 18, the app's
deployment target, so no availability checks or target change were needed).

## How it works: one navigation path

```
Control Center / Lock Screen / Action Button control ─┐
Shortcuts app / Action Button "Shortcut" / Siri ──────┼─> App Intent (openAppWhenRun)
cybercabhunter-widget://action?do=<action> link ──────┘        │
                                                               ▼
                         QuickActionCenter.request(QuickAction)   (Shared/QuickActions.swift)
                                                               ▼
                         AppRouter.perform(_:)                     (App/AppRouter.swift)
```

- `QuickAction` (Shared/QuickActions.swift) is the one list of destinations.
  The file is compiled into the app and the widget extension, because a
  control's intent type must exist in both; with `openAppWhenRun` iOS always
  runs `perform()` in the app.
- `QuickActionCenter` holds a request that arrives before the app's router
  connects (a cold launch) and delivers it once, when `AppRouter.shared` is
  created.
- `AppRouter.perform(_:)` is the only navigation code. It ignores the same
  action repeated within a second (a double tap, or an intent plus its link),
  lets the latest request win, resets the tab's history rather than pushing
  (no duplicate screens), and bumps `presentationReset` so:
  - RootView closes the Account and notification sheets, so the destination is visible;
  - Sightings closes an **empty** sighting form for a different action. A form
    holding a photo, plate or notes asks **"Leave this sighting?"** first
    (Leave → the requested screen; Keep Editing → nothing changes), because
    switching tabs would otherwise discard the rider's work.
- Signed out: New Sighting opens sign-in. After signing in (within ten
  minutes) the form opens by itself; closing sign-in drops the request.
- The Zones city is saved (`zones.lastCity`), so the map opens where the rider
  left it, also after the app was closed.
- The existing Siri "Open the map" now uses the remembered city too, instead of
  always Austin.

Files: `Shared/QuickActions.swift`, `CybercabHunterWidgets/SystemControls.swift`
(+4 lines in the widget bundle), `App/AppRouter.swift`,
`Features/Root/RootView.swift`, `Features/Sightings/SightingsView.swift`,
`Features/Sightings/SubmitSightingView.swift`, `Features/Zones/ZonesModel.swift`,
`Features/Intents/CybercabIntents.swift` (SubmitSightingIntent moved to Shared).
No Xcode project changes: the folders are synchronized groups.

## Apple limits and decisions

- **App Shortcuts: 10 per app, and the app already has 10** (the Siri
  questions). The new actions are therefore regular App Intents: they are listed
  under Cybercab Hunter in the Shortcuts app's action list and can be used in any
  shortcut, but they don't appear as ready-made tiles. Swapping two of the
  existing ten for "Open Cybercab Hunter Camera" and "Open Cybercab Map" is a
  one-line change each, if wanted.
- **Action Button:** iOS lets the rider assign a *control* (Settings › Action
  Button › Controls: any of the four) or a *shortcut*. Apps can't change the
  Action Button themselves; nothing here tries.
- **Lock Screen:** the same controls fill the two bottom slots (they replace the
  torch/camera buttons). iOS asks for Face ID / passcode before the app opens.
- **Controls show no data**: a fixed SF Symbol and a name, tinted by the system.
  Nothing private ever appears on Control Center or the Lock Screen.
- **No Dynamic Island / Live Activity changes, no background tasks, no analytics.**

## Testing

- Unit (SystemControlsTests, 18): every intent → its destination through the
  router; cold-launch hand-off; duplicate requests; latest wins; link form;
  remembered city; SF Symbols exist.
- UI (SystemControlsUITests): cold launch to each destination; signed in (the
  form) and signed out (sign-in first); running and backgrounded app; duplicate
  requests open one form; map restores the city after relaunch; an empty form
  closes, a draft stays; no location or camera prompt.
- UI tests can't press a control or the Action Button: they send the same
  request (`-quickAction <action>` at launch, or the link delivered by the
  system to the running app, `XCUIDevice.shared.system.open`). A Debug-only
  readout (`quickActionState`) includes the process id, so the running and
  background tests prove the app was not relaunched.
- Control Center gallery (SpringBoard, best effort): all four controls are
  listed under Cybercab Hunter in **Add a Control**.
- **Needs a physical iPhone:** pressing the controls in Control Center and on
  the Lock Screen, the Action Button, the camera itself (the Simulator has none)
  and camera-denied handling (the existing "Camera access is off" alert, with
  Open Settings and the photo library still available).

## On the iPhone (once installed)

**Control Center:** swipe down from the top-right corner › tap **+** (top
left) › **Add a Control** › search "Cybercab" › pick New Sighting, Cybercab
Map, Fleet Stats or Community.

**Lock Screen:** touch and hold the Lock Screen › **Customize** › **Lock
Screen** › tap **−** on the torch or camera button › tap **+** › search
"Cybercab" › pick a control (New Sighting and Cybercab Map are the natural
two).

**Action Button** (iPhone 15 Pro and later, iPhone 16 and later): Settings ›
**Action Button** › swipe to **Controls** › **Choose a Control** › search
"Cybercab". Or swipe to **Shortcut** › pick a shortcut that uses a Cybercab
Hunter action.

**Shortcuts app:** + › **Add Action** › search "Cybercab" (or tap Apps ›
Cybercab Hunter): Open Cybercab Hunter Camera, New Cybercab Sighting, Open
Cybercab Map, Open Fleet Dashboard, Open Cybercab Community, Open Cybercab
Hunter, alongside the existing Siri actions.

If a control doesn't appear right after installing, open the app once.
