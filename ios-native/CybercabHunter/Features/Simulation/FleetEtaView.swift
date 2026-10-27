import SwiftUI

/// Fleet ETA (simulation.html?view=eta, js/fleet-compare.js): Cybercab vs
/// Model Y, and the fare and pickup-wait ESTIMATES for a trip under a demand
/// scenario, for Austin or Dallas. Ranges with their basis and confidence;
/// "Insufficient data" when there is none; never a Tesla quote.
struct FleetEtaView: View {
    @Bindable var model: SimulationModel
    @Environment(SessionStore.self) private var session

    private let cities = [ServiceArea(key: "austin", name: "Austin"), ServiceArea(key: "dallas", name: "Dallas")]

    var body: some View {
        // Ages, open / closed and the assumed scenario follow the clock (the site ticks every 30 s).
        TimelineView(.periodic(from: .now, by: 30)) { tl in
            content(now: tl.date)
        }
        .task(id: model.city) { await model.loadEta(model.city, api: session.api) }
    }

    @ViewBuilder private func content(now: Date) -> some View {
        let city = model.city
        let name = SimulationCalc.cityName[city] ?? city
        VStack(alignment: .leading, spacing: 18) {
            SimHero(eyebrow: "Fleet comparison", title: "FLEET ETA", titleID: "etaTitle",
                    text: "Cybercab and Model Y robotaxis in \(name): what a ride costs, when they run, and how long a pickup might take.") {
                CityPicker(cities: cities, selection: $model.city)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("etaCityPicker")
                    .padding(.top, 4)
                if city == "austin" { fleetLine(now: now) }
            }
            if model.failed(city) && model.eta(city) == nil {
                InlineMessage(text: "Fleet ETA data unavailable. The estimates can't be loaded right now, so no numbers are shown.", systemImage: "wifi.exclamationmark")
                    .accessibilityIdentifier("etaError")
                Button("Try again") { Task { await model.loadEta(city, api: session.api, force: true) } }.font(.inter(14, .semibold))
            } else if model.eta(city) == nil {
                PanelSkeleton(height: 220)
            }
            mixSection(city: city, now: now)
            if let eta = model.eta(city) { estimates(eta, city: city, now: now) }
            methodSection(now: now)
            FareReportForm(model: model)
        }
    }

    // MARK: Fleet count line and mix

    @ViewBuilder private func fleetLine(now: Date) -> some View {
        if let n = model.cybercabCount("austin"), let e = model.eta("austin") {
            HStack(spacing: 6) {
                Text("\(Format.plural(n, "Cybercab", "Cybercabs")) on the registry · counted \(SimulationCalc.ago(e.computedAt, now: now) ?? "at an unknown time")")
                if SimulationCalc.isStale(e.computedAt, now: now) { StaleBadge(text: "Stale") }
            }
            .font(.inter(12)).foregroundStyle(Color.chFog)
            .accessibilityIdentifier("etaFleetLine")
        } else if model.failed("austin") {
            Text("Fleet count unavailable").font(.inter(12)).foregroundStyle(Color.chFog)
        } else if model.eta("austin")?.pendingFirstRun == true {
            Text("Fleet count pending the first daily update").font(.inter(12)).foregroundStyle(Color.chFog)
        }
    }

    private func mixSection(city: String, now: Date) -> some View {
        let cy = model.cybercabCount(city)
        let my = SimulationCalc.modelYFleet[city] ?? 0
        let total = cy.map { $0 + my }
        let share = cy.flatMap { c in total.flatMap { $0 > 0 ? Int((Double(c) / Double($0) * 100).rounded()) : nil } }
        let e = model.eta(city)
        let note: String = {
            guard cy != nil else { return model.failed(city) ? "Count unavailable" : e?.pendingFirstRun == true ? "Count pending the first daily update" : "Count loading" }
            let ago = SimulationCalc.ago(e?.computedAt, now: now) ?? "at an unknown time"
            return city == "austin" ? "Every Cybercab on the public registry, counted \(ago)" : "Documented in Dallas by Cybercab Hunter, counted \(ago)"
        }()
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("FLEET MIX · \((SimulationCalc.cityName[city] ?? city).uppercased())").font(.inter(11, .semibold)).tracking(1.8).foregroundStyle(Color.brandGold)
                Text("CYBERCAB VS MODEL Y").font(.inter(19, .bold)).tracking(0.2).foregroundStyle(Color.chInk)
                (Text(total.map(String.init) ?? "—").foregroundStyle(Color.chInk) + Text(" robotaxis in all").foregroundStyle(Color.chFog))
                    .font(.inter(14)).padding(.top, 4)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.chModelY.opacity(0.75))
                    Capsule().fill(Color.brandGold).frame(width: g.size.width * CGFloat(share ?? 0) / 100)
                }
            }
            .frame(height: 10)
            .accessibilityHidden(true)
            HStack {
                Text("\(share.map { "\($0)%" } ?? "—") Cybercab").foregroundStyle(Color.brandGold)
                Spacer()
                Text("\(share.map { "\(100 - $0)%" } ?? "—") Model Y").foregroundStyle(Color(hex: 0xF08A84))
            }
            .font(.inter(13))
            mixCard("Cybercab", value: cy.map(String.init) ?? "—", pct: share, color: .brandGold, car: "CybercabRender", note: note)
            mixCard("Model Y", value: String(my), pct: share.map { 100 - $0 }, color: .chModelY, car: "ModelYRender", note: "A fixed figure: Cybercab Hunter has no live Model Y count.")
        }
        .padding(16)
        .background(Color.chSurface, in: .rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.08)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("etaMix")
    }

    /// One model in the mix: its count, share and note, with the car in the bottom-right corner (as on the site).
    private func mixCard(_ title: String, value: String, pct: Int?, color: Color, car: String, note: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) { Circle().fill(color).frame(width: 8, height: 8); Text(title.uppercased()).font(.inter(11, .semibold)).tracking(1).foregroundStyle(color == .chModelY ? Color(hex: 0xF08A84) : color) }
            Text(value).statNumber(30, color: .chInk)
            Text("\(pct.map { "\($0)%" } ?? "—") of the fleet").font(.inter(13)).foregroundStyle(Color.chMist)
            Text(note).font(.inter(12)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, TintCard<EmptyView>.headingInset)
        .padding(14)
        // The car wholly inside the card, centred on its right (never cropped).
        .overlay(alignment: .trailing) {
            Image(car).resizable().aspectRatio(contentMode: .fit).frame(width: TintCard<EmptyView>.carWidth)
                .shadow(color: .black.opacity(0.45), radius: 8, y: 6)
                .padding(.trailing, 12)
                .accessibilityHidden(true)
        }
        .background {
            ZStack {
                Color.chSurface2.opacity(0.6)
                LinearGradient(colors: [color.opacity(0.10), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)
            }
            .clipShape(.rect(cornerRadius: 14))
        }
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(color.opacity(0.3)))
        .accessibilityElement(children: .combine)
    }

    // MARK: Ride, hours & wait

    @ViewBuilder private func estimates(_ eta: FleetEta, city: String, now: Date) -> some View {
        let tier = model.scenario(for: city, at: now)
        VStack(alignment: .leading, spacing: 14) {
            SimSectionHead(eyebrow: "Fares · Hours · Pickup wait", title: "Ride, hours & wait").padding(.top, 6)
            HStack(spacing: 6) {
                Text(eta.pendingFirstRun == true ? "First daily update pending: published-report estimates for now"
                     : "Estimates recomputed \(centralTime(eta.computedAt)) CT (daily)")
                if eta.pendingFirstRun != true && SimulationCalc.isStale(eta.computedAt, now: now) {
                    StaleBadge(text: "Stale, \(SimulationCalc.ago(eta.computedAt, now: now) ?? "")")
                }
            }
            .font(.inter(12)).foregroundStyle(Color.chFog)
            .accessibilityIdentifier("etaUpdated")

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("Demand scenario").font(.inter(13)).foregroundStyle(Color.chFog).fixedSize()
                    ForEach(SimulationCalc.tiers, id: \.self) { t in
                        PillToggle(title: SimulationCalc.tierLabel[t] ?? t, selected: tier == t, compact: true) { model.userScenario = t }
                            .accessibilityIdentifier("scenario-\(t)")
                    }
                }
                Text(assumedText(eta, city: city, now: now)).font(.inter(12)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("etaAssumed")
            }

            VStack(alignment: .leading, spacing: 14) {
            SliderRow(label: "Trip distance", value: Binding(get: { model.miles[city] ?? 5 }, set: { model.miles[city] = $0 }),
                      range: 0.5...20, step: 0.5, format: { Format.one($0) }, unit: "mi", id: "etaMiles")
            Text("Pickup area").font(.inter(14, .medium)).foregroundStyle(Color.chMist)
            Menu {
                Picker("Pickup area", selection: Binding(get: { model.area[city] ?? "" }, set: { model.area[city] = $0 })) {
                    Text("Anywhere in \(SimulationCalc.cityName[city] ?? city)").tag("")
                    ForEach(eta.areas ?? []) { a in Text(a.label).tag(a.key) }
                }
            } label: {
                HStack {
                    Text(eta.areaLabel(model.area[city]) ?? "Anywhere in \(SimulationCalc.cityName[city] ?? city)").font(.inter(14)).foregroundStyle(Color.chInk)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 11)).foregroundStyle(Color.chFog)
                }
                .padding(.horizontal, 12).frame(minHeight: 40)
                .background(Color.chSurface2, in: .rect(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
            }
            .accessibilityLabel("Pickup area")
            .accessibilityIdentifier("etaArea")
            }
            .padding(16)
            .background(Color.chSurface, in: .rect(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.08)))

            ForEach(["cybercab", "model_y"], id: \.self) { vt in
                vehicleCard(eta, city: city, vehicle: vt, tier: tier, now: now)
            }
            VStack(alignment: .leading, spacing: 18) {
                fleetAvailability(eta, city: city)
                serviceDay(city: city, now: now)
            }
            .padding(16)
            .background(Color.chSurface, in: .rect(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.08)))
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "info.circle").font(.system(size: 13)).foregroundStyle(Color.chFog).padding(.top, 1)
                Text(calibration(eta, city: city)).font(.inter(12.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("etaCalibration")
            if let rs = eta.recentReports, !rs.isEmpty { recentReports(rs) }
        }
    }

    private func vehicleCard(_ eta: FleetEta, city: String, vehicle vt: String, tier: String, now: Date) -> some View {
        let color: Color = vt == "cybercab" ? .brandGold : .chModelY
        let bv = eta.byVehicle(vt)
        let fareModel = eta.fareModel(for: vt)
        let miles = model.miles[city] ?? 5
        let area = (model.area[city] ?? "").isEmpty ? nil : model.area[city]
        let areaName = eta.areaLabel(area)
        let status = SimulationCalc.serviceStatus(now)
        let ink: Color = vt == "cybercab" ? .brandGold : Color(hex: 0xF08A84)
        return TintCard(color: color, car: vt == "cybercab" ? "CybercabRender" : "ModelYRender") {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) { Circle().fill(color).frame(width: 8, height: 8); Text((SimulationCalc.vehicleLabel[vt] ?? vt).uppercased()).font(.inter(12, .semibold)).tracking(1.8).foregroundStyle(ink) }
                Text(basisTag(fareModel, use: bv?.use)).font(.inter(11, .semibold)).foregroundStyle(Color.chMist)
                    .padding(.horizontal, 9).padding(.vertical, 4).overlay(Capsule().strokeBorder(Color.chHair2))
            }
            .frame(maxWidth: .infinity, minHeight: 66, alignment: .topLeading)
            .padding(.trailing, TintCard<EmptyView>.headingInset)
            // Estimated fare
            VStack(alignment: .leading, spacing: 6) {
                IconLabel(icon: "dollarsign", text: "Estimated fare", color: ink).padding(.bottom, 2)
                if let m = fareModel, let r = SimulationCalc.fareRange(m, miles: miles, tier: tier, area: area) {
                    Text(SimulationCalc.dollarRange(r) ?? "—").statNumber(30, color: .chInk).accessibilityIdentifier("etaFare-\(vt)")
                    let typeName = bv?.use == "all" ? "All robotaxis" : bv?.use == "external" ? "All vehicle types" : (SimulationCalc.vehicleLabel[vt] ?? vt)
                    Text("\(Format.one(miles)) mi · \(SimulationCalc.tierLabel[tier] ?? tier) demand\(areaName.map { " · \($0)" } ?? "") · \(typeName)")
                        .font(.inter(12)).foregroundStyle(Color.chMist)
                    HStack(spacing: 6) {
                        ConfidencePill(level: bv?.confidence.level ?? "low")
                        Text(m.basis == "external" ? "Modeled from published reports" : "Observed · \(Format.plural(m.n, "ride", "rides"))").font(.inter(11.5)).foregroundStyle(Color.chFog)
                    }
                    let lines = fareLines(eta, model: m, use: bv?.use, vehicle: vt, miles: miles, area: area, areaName: areaName, city: city, note: bv?.note)
                    if !lines.isEmpty { Text(lines).font(.inter(11.5)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true) }
                } else {
                    Text("Insufficient data").font(.inter(19, .bold)).foregroundStyle(Color.chInk).accessibilityIdentifier("etaFare-\(vt)")
                    ConfidencePill(level: "insufficient")
                    Text(bv?.note ?? "Not enough data for an estimate.").font(.inter(11.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, 12)
            // Hours
            VStack(alignment: .leading, spacing: 6) {
                IconLabel(icon: "clock", text: "Hours", color: ink)
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(SimulationCalc.clockLabel(SimulationCalc.openMinute)) - \(SimulationCalc.clockLabel(SimulationCalc.closeMinute))").font(.inter(16, .semibold)).foregroundStyle(Color.chInk)
                        Text("Central, daily").font(.inter(13)).foregroundStyle(Color.chFog)
                    }
                    Spacer()
                    HStack(spacing: 6) {
                        Circle().fill(status.open ? Color.chOK : Color.chFog).frame(width: 6, height: 6)
                        Text(status.label).font(.inter(12, .semibold)).foregroundStyle(status.open ? Color.chOK : Color.chFog)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .overlay(Capsule().strokeBorder((status.open ? Color.chOK : Color.chFog).opacity(0.5)))
                }
            }
            .padding(.vertical, 14)
            .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1) }
            .padding(.top, 14)
            // Estimated pickup wait
            VStack(alignment: .leading, spacing: 6) {
                IconLabel(icon: "mappin.and.ellipse", text: "Estimated pickup wait", color: ink).padding(.bottom, 2)
                waitBlock(eta, city: city, vehicle: vt, tier: tier, area: area, areaName: areaName)
            }
            .padding(.top, 14)
            .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("etaCard-\(vt)")
    }

    @ViewBuilder private func waitBlock(_ eta: FleetEta, city: String, vehicle vt: String, tier: String, area: String?, areaName: String?) -> some View {
        let w = eta.waits
        if vt == "cybercab" && !eta.service.cybercabService {
            Text("Insufficient data").font(.inter(19, .bold)).foregroundStyle(Color.chInk)
            ConfidencePill(level: "insufficient")
            Text("No evidence of Cybercabs in public service in \(SimulationCalc.cityName[city] ?? city) yet, so no Cybercab pickup estimate.")
                .font(.inter(11.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
        } else if w.use == "none" || w.model == nil {
            Text("Insufficient data").font(.inter(19, .bold)).foregroundStyle(Color.chInk)
            ConfidencePill(level: "insufficient")
            Text(w.note ?? "Not enough data for an estimate.").font(.inter(11.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
        } else if let r = SimulationCalc.waitRange(w.model, tier: tier, area: area) {
            Text(SimulationCalc.minuteRange(r) ?? "—").statNumber(26, color: .chInk).accessibilityIdentifier("etaWait-\(vt)")
            Text("\(SimulationCalc.tierLabel[tier] ?? tier) demand\(areaName.map { " · \($0)" } ?? "") · any Tesla robotaxi").font(.inter(12)).foregroundStyle(Color.chMist)
            ConfidencePill(level: w.confidence.level)
            Text(waitBasis(w, area: area, areaName: areaName, city: city)).font(.inter(11.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func fleetAvailability(_ eta: FleetEta, city: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Fleet availability").font(.inter(15, .semibold)).foregroundStyle(Color.chInk).padding(.bottom, 4)
            if let f = eta.fleet {
                let d = f.documented
                row("Documented by Cybercab Hunter", "\(d.cybercab) Cybercab\((d.modelY ?? 0) > 0 ? " · \(d.modelY!) Model Y" : "")\((d.unknown ?? 0) > 0 ? " · \(d.unknown!) other" : "")", tag: "Registry")
                row("Different cars seen, last 7 days", String(f.observed7d), tag: "Sightings + rides")
                row("Different cars seen, last 30 days", String(f.observed30d), tag: "Sightings + rides")
                if let u = f.unidentified30d, u.sightings > 0 || u.cameraDetections > 0 {
                    row("Seen but not identifiable, 30 days", "\(u.sightings) sightings · \(u.cameraDetections) camera detections", tag: "Not counted as cars", assumed: true)
                }
                if let dmv = f.dmv { row("Registered with the Texas DMV (\(dmv.snapshotDate))", "\(dmv.total) (\(dmv.cybercab) Cybercab, \(dmv.modelY) Model Y)", tag: "Statewide") }
                if let x = f.external {
                    row("In service per \(x.source.components(separatedBy: " (").first ?? x.source) (\(x.asOf))", "about \(x.total)\(x.cybercab.map { $0 > 0 ? " (\($0) Cybercab)" : " (no Cybercab)" } ?? " (no Cybercab)")", tag: "External", assumed: true)
                }
                row("Free to pick you up right now", "Not known", tag: "No public data", assumed: true)
            } else {
                Text("Fleet data unavailable").font(.inter(13)).foregroundStyle(Color.chFog)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("etaFleet")
    }

    private func row(_ dt: String, _ dd: String, tag: String, assumed: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(dt).font(.inter(12)).foregroundStyle(Color.chFog)
            HStack(spacing: 6) {
                Text(dd).font(.inter(13.5, .semibold)).foregroundStyle(Color.chInk)
                Text(tag).font(.inter(10, .semibold)).foregroundStyle(assumed ? Color.chFog : Color.brandGold)
                    .padding(.horizontal, 6).padding(.vertical, 2).overlay(Capsule().strokeBorder(assumed ? Color.chHair2 : Color.brandGold.opacity(0.4)))
            }
        }
    }

    private func serviceDay(city: String, now: Date) -> some View {
        let s = SimulationCalc.serviceStatus(now)
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(city == "dallas" ? "SERVICE DAY · BOTH MODELS" : "SERVICE DAY").font(.inter(10.5, .bold)).tracking(0.8).foregroundStyle(Color.chCaption)
                Spacer()
                Text(s.label).font(.inter(11, .bold)).foregroundStyle(s.open ? Color.chOK : Color.chFog).accessibilityIdentifier("etaServiceStatus")
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.06))
                    Capsule().fill(Color.brandGold.opacity(0.5))
                        .frame(width: g.size.width * CGFloat(SimulationCalc.closeMinute - SimulationCalc.openMinute) / 1440)
                        .offset(x: g.size.width * CGFloat(SimulationCalc.openMinute) / 1440)
                    Rectangle().fill(Color.chInk).frame(width: 2, height: 14)
                        .offset(x: g.size.width * CGFloat(s.minuteOfDay) / 1440 - 1)
                }
            }
            .frame(height: 14)
            .accessibilityHidden(true)
            HStack { Text("12 AM"); Spacer(); Text("6 AM"); Spacer(); Text("12 PM"); Spacer(); Text("6 PM"); Spacer(); Text("12 AM") }
                .font(.inter(9.5)).foregroundStyle(Color.chCaption)
                .accessibilityHidden(true)
            Text("It's \(SimulationCalc.clockLabel(s.minuteOfDay)) in \(SimulationCalc.cityName[city] ?? city) now.").font(.inter(12)).foregroundStyle(Color.chFog)
        }
    }

    private func recentReports(_ rs: [FleetEta.Report]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("RECENT REVIEWED RIDER REPORTS").font(.inter(10.5, .bold)).tracking(0.8).foregroundStyle(Color.chCaption)
            ForEach(Array(rs.enumerated()), id: \.offset) { _, r in
                Text(reportLine(r)).font(.inter(12.5)).foregroundStyle(Color.chMist)
            }
        }
        .accessibilityIdentifier("etaRecentReports")
    }

    // MARK: How the estimates work

    private func methodSection(now: Date) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                Group {
                    (Text("Cybercab Hunter is an independent tracking site.").bold() + Text(" It has no live Tesla pricing or dispatch data, and nothing here is a Tesla quote. Every number is an estimate with a range, labelled with where it comes from and how much to trust it."))
                    heading("Where the numbers come from")
                    bullet("Logged rides:", "fares and distances from ride receipts riders share with the site (one entry per physical ride, from public vehicles only). Each is a ride somebody actually paid for.")
                    bullet("Rider reports:", "app quotes, pickup waits and \"no cars available\" moments riders report below. They count only after a moderator reviews them.")
                    bullet("Published reports, used only where the site has too little data:", "Tesla's reported fare structure over time (historical; not assumed to be current), RobotaxiTracker's published 90-day medians, Obi's day-to-day price range, and reported Austin wait times. These estimates are marked \"Modeled from published reports\" and are always low confidence.")
                    heading("How the fare estimate works")
                    Text("A trip's typical fare is a base amount plus a rate per mile, fitted to the logged fares with a method that ignores extreme values, so one unusually expensive ride cannot move it. Recent rides count more: a ride 30 days old counts half as much as one from today, and fares older than 180 days are not used. Impossible values (for example $200 for a mile) are dropped. Cybercab and Model Y are priced separately once each has enough rides with a known vehicle type; until then they share one estimate, and no discount is assumed for either.")
                    heading("Quiet, Typical and Busy")
                    Text("These are Cybercab Hunter's own demand scenarios, not labels Tesla uses. Tesla's prices have become more responsive to demand, so the same trip can cost more at a busy time. Each scenario is fitted from the spread of real fares: Quiet sits at the cheaper quarter of observed fares, Typical at the middle, Busy toward the top (80th percentile). The range shown is what remains uncertain once the scenario is known. The scenario assumed for the current time comes from fares, quoted waits and \"no cars available\" reports at comparable times, and is used only if it predicted held-out rides better than always assuming Typical. Pickup waits get the same treatment.")
                }
                Group {
                    heading("Why the registered fleet is not the available fleet")
                    Text("A registration shows a car was registered, not that it is driving. A sighting or camera detection shows a car was seen, not that it was free to pick someone up. So the page keeps four numbers apart: cars documented by the site, different cars seen recently (each car counted once, however often it was seen), cars registered with the Texas DMV (statewide), and cars available to pick you up, which nobody outside Tesla can see. None of them is used as \"cars waiting for you\".")
                    heading("Confidence")
                    Text("High: many recent observations, and at least 70% of recent rides the model had not seen fell inside its range. Medium: a moderate number of reasonably recent observations. Low: few or old observations, or built from published reports. Insufficient data: no estimate is shown. The accuracy check under each city is recomputed every day on the newest observations, which are held out from the fit.")
                    heading("Updates")
                    Text("The estimates are recomputed once a day. Austin and Dallas are computed separately from their own data; Austin's prices or waits are never applied to Dallas.")
                    heading("Fleet-geometry check")
                    Text("The previous version of this page estimated waits from fleet size alone: the nearest free car is on average 0.5 ÷ √(free cars per square mile) away, times a road detour factor, over an average speed, plus a minute to dispatch. It ignores demand and queues, so it is no longer the headline estimate. For the selected city it gives ") + Text(geometryText(now: now)).bold() + Text(", from these inputs:")
                    geometryInputs(now: now)
                    heading("Published fare history")
                    Text("Historical context only; Tesla does not publish its current formula.")
                    ForEach(historyLines(), id: \.self) { Text("• " + $0) }
                }
            }
            .font(.inter(12.5)).foregroundStyle(Color.chMist)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 8)
        } label: {
            Text("How are these estimates calculated?").font(.inter(14.5, .semibold)).foregroundStyle(Color.chInk)
        }
        .tint(.brandGold)
        .glassCard()
        .accessibilityIdentifier("etaMethod")
    }

    private func heading(_ s: String) -> some View { Text(s.uppercased()).font(.inter(10.5, .bold)).tracking(0.8).foregroundStyle(Color.chCaption).padding(.top, 4) }
    private func bullet(_ b: String, _ rest: String) -> some View { (Text("• ") + Text(b).bold() + Text(" " + rest)) }

    private func geometryText(now: Date) -> String {
        let city = model.city, tier = model.scenario(for: city, at: now), name = SimulationCalc.cityName[city] ?? city
        switch SimulationCalc.geometry(fleetSize: model.cybercabCount(city), tier: tier, city: city) {
        case .ok(let lo, let likely, let hi, let capped): return "\(lo)-\(capped ? "\(hi)+" : "\(hi)") min (most likely \(likely)) for the \(name) Cybercabs under \(SimulationCalc.tierLabel[tier] ?? tier) demand"
        case .fewCars: return "too few free cars to estimate"
        case .noData: return "not available (no fleet count)"
        }
    }

    private func geometryInputs(now: Date) -> some View {
        let idle = SimulationCalc.idleShare[model.scenario(for: model.city, at: now)] ?? [0.3, 0.5, 0.6]
        return VStack(alignment: .leading, spacing: 4) {
            inputRow("Cybercabs documented", model.cybercabCount(model.city).map(String.init) ?? "Unavailable", "Live")
            inputRow("Cars in service at a time", "40% to 80%", "Assumed")
            inputRow("In-service cars that are free", "\(Int(idle[0] * 100))% to \(Int(idle[2] * 100))%", "Assumed")
            inputRow("Average speed to the pickup", "18 to 28 mph", "Assumed")
        }
    }
    private func inputRow(_ k: String, _ v: String, _ tag: String) -> some View {
        HStack { Text(k).foregroundStyle(Color.chFog); Spacer(); Text(v).bold(); Text(tag).font(.inter(10)).foregroundStyle(Color.chCaption) }
    }

    private func historyLines() -> [String] {
        guard let e = model.eta(model.city)?.fares.external else { return [] }
        var out = (e.rateHistory ?? []).map { "\($0.asOf): \($0.text)" }
        if let t = e.tracker { out.append("\(t.source), \(t.window) (\(t.asOf)): median fare \(money(t.medianFare)), \(money(t.perMile))/mi, \(Format.one(t.avgMiles)) mi average, \(Format.int(t.rides)) priced rides") }
        if let o = e.obi { out.append("\(o.source): average price \(money(o.low)) to \(money(o.high)) depending on the day") }
        return out
    }

    // MARK: Text (js/fleet-compare.js)

    private func money(_ v: Double) -> String { String(format: "$%.2f", v) }
    private func centralTime(_ iso: String?) -> String {
        guard let d = Format.instant(iso) else { return "—" }
        return d.formatted(Date.FormatStyle(timeZone: SimulationCalc.central).month(.abbreviated).day().hour().minute())
    }

    private func basisTag(_ m: FleetEta.FareModel?, use: String?) -> String {
        guard let m else { return "Insufficient data" }
        if m.basis == "external" { return "Modeled" }
        return use == "all" ? "All robotaxis · \(m.n)" : "Observed · \(m.n)"
    }

    private func assumedText(_ eta: FleetEta, city: String, now: Date) -> String {
        let a = SimulationCalc.assumedTier(eta, at: now)
        let slot = eta.slotTiers?[a.slot.key]
        let validated = slot.map { ($0.fareN ?? 0) > 0 || ($0.waitN ?? 0) > 0 || !$0.reasons.isEmpty } ?? false
        var text = "Assumed now: \(SimulationCalc.tierLabel[a.tier] ?? a.tier) \(a.slot.day)-\(a.slot.part) demand"
        if !a.reasons.isEmpty { text += " (\(a.reasons.joined(separator: "; ")))" }
        else if !validated { text += " (time-of-day differences not yet shown to improve accuracy)" }
        if let pick = model.userScenario, pick != a.tier { text = "Showing \(SimulationCalc.tierLabel[pick] ?? pick) (your pick). " + text }
        return text + ". Cybercab Hunter's scenario, not a Tesla label."
    }

    private func fareLines(_ eta: FleetEta, model m: FleetEta.FareModel, use: String?, vehicle vt: String, miles: Double, area: String?, areaName: String?, city: String, note: String?) -> String {
        var lines: [String] = []
        if let note { lines.append(note) }
        let stats = m.basis == "observed" ? m.stats : nil
        if let s = stats, let mf = s.medianFare, let pm = s.perMile, let mm = s.medianMiles {
            lines.append("Logged \(use == "all" ? "" : (SimulationCalc.vehicleLabel[vt] ?? "") + " ")rides: median \(money(mf)), \(money(pm))/mi, typical trip \(Format.one(mm)) mi.")
            if miles > mm * 3 { lines.append("Longer than most logged trips (typical \(Format.one(mm)) mi), so this is an extrapolation.") }
        }
        if area != nil && FleetEta.lookup(m.areaMult, area) == nil {
            lines.append("Not enough fares from \(areaName ?? "this area") to adjust for it, so this is the \(SimulationCalc.cityName[city] ?? city)-wide estimate.")
        }
        return lines.joined(separator: " ")
    }

    private func waitBasis(_ w: FleetEta.Waits, area: String?, areaName: String?, city: String) -> String {
        var parts: [String] = []
        if w.use == "observed", let m = w.model {
            parts.append("Modeled from \(Format.plural(m.n, "pickup wait", "pickup waits")) riders reported from the app (quoted ETAs), not separated by vehicle type.")
            if area != nil { parts.append(FleetEta.lookup(m.areaMult, area) != nil ? "Adjusted for \(areaName ?? "this area")." : "Not enough reports from \(areaName ?? "this area"), so \(SimulationCalc.cityName[city] ?? city)-wide.") }
        } else {
            if let n = w.note { parts.append(n) }
            if let s = w.model?.sources, !s.isEmpty { parts.append("Sources: \(s.joined(separator: "; ")).") }
        }
        if let a = w.actualVsQuoted, let d = a.medianDelay {
            parts.append("Riders who timed their pickup: the car arrived a median \(Format.one(abs(d))) min \(d >= 0 ? "after" : "before") the app's quote (\(a.n) rides).")
        }
        if let u = w.unavailability, u.n >= 6, let share = u.share, share > 0 {
            parts.append("The app showed no car available in \(Int((share * 100).rounded()))% of \(u.n) reports.")
        }
        return parts.joined(separator: " ")
    }

    private func calibration(_ eta: FleetEta, city: String) -> String {
        var parts: [String] = []
        if let fc = eta.fareCheck("all") {
            var s = "Accuracy check, fares: on the newest \(fc.nTest) logged rides (held out from the fit), \(Int((fc.withinRange * 100).rounded()))% fell inside the shown range; typical error \(money(fc.medianAe)) (\(Int(((fc.mape ?? 0) * 100).rounded()))% on average)."
            if let prev = FleetEta.lookup(fc.baselines, "previous_measured_rate"), let mae = fc.mae {
                s += " The previous page's per-mile formula was off by \(money(prev.mae)) on average on the same rides, against \(money(mae)) now."
            }
            parts.append(s)
            if let w = (FleetEta.lookup(eta.fares.models, "all") ?? nil)?.widenedBy, w > 1 { parts.append("Ranges were widened \(Format.one(w))x because fewer held-out rides than expected fell inside.") }
        } else {
            parts.append("Accuracy check, fares: not enough logged \(SimulationCalc.cityName[city] ?? city) rides yet to test the estimate on rides it wasn't fitted to.")
        }
        if let wc = eta.waits.check {
            parts.append("Waits: \(Int((wc.withinRange * 100).rounded()))% of the newest \(wc.nTest) reported waits fell inside the range (typical error \(Format.one(wc.medianAe)) min).")
        } else {
            parts.append("Waits: not enough rider-reported waits yet to check.")
        }
        return parts.joined(separator: " ")
    }

    private func reportLine(_ r: FleetEta.Report) -> String {
        let day = r.day.flatMap { Format.calendarDate($0) }.map { $0.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).month(.abbreviated).day()) }
        let bits = [day, r.area, SimulationCalc.vehicleLabel[r.vehicle ?? "unknown"] ?? "Robotaxi"].compactMap { $0 }
        var what = r.noCars == true ? "no cars available" : ""
        if let f = r.fare { what = "\(r.kind == "quote" ? "quoted" : "paid") \(money(f))\(r.miles.map { " for \(Format.one($0)) mi" } ?? "")" }
        if let q = r.quotedWait { what += "\(what.isEmpty ? "" : ", ")\(q) min wait quoted" }
        if let a = r.actualWait { what += "\(what.isEmpty ? "" : ", ")\(a) min actual wait" }
        return "\(bits.joined(separator: " · ")): \(what)"
    }
}

/// "High confidence" / "Insufficient data", coloured by level.
struct ConfidencePill: View {
    let level: String
    var body: some View {
        let color: Color = level == "high" ? .chOK : level == "medium" ? .brandGold : level == "low" ? Color(hex: 0xF5B83D) : .chFog
        Text(SimulationCalc.confidenceLabel[level] ?? level).font(.inter(10.5, .bold)).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 3).overlay(Capsule().strokeBorder(color.opacity(0.5)))
    }
}

struct StaleBadge: View {
    let text: String
    var body: some View {
        Text(text).font(.inter(10, .bold)).foregroundStyle(Color(hex: 0xF5B83D))
            .padding(.horizontal, 6).padding(.vertical, 2).overlay(Capsule().strokeBorder(Color(hex: 0xF5B83D, opacity: 0.5)))
    }
}

/// "Report a fare or wait · optional, helps calibrate" (POST /api/fare-reports).
struct FareReportForm: View {
    @Bindable var model: SimulationModel
    @Environment(SessionStore.self) private var session
    @Environment(\.openSignIn) private var openSignIn

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 12) {
                Text("Saw a price or pickup time in the Tesla app, or just took a ride? Reports are unverified until a moderator reviews them, and only reviewed reports feed the estimates. Only an area and the hour are stored, never addresses. Sign-in required; 10 reports a day.")
                    .font(.inter(12.5)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                if session.user == nil || model.reportNeedsSignIn {
                    Button("Sign in to report") { openSignIn() }.font(.inter(13, .semibold)).accessibilityIdentifier("fareReportSignIn")
                }
                let areas = model.eta(model.report.city)?.areas ?? []
                Picker("City", selection: $model.report.city) { Text("Austin").tag("austin"); Text("Dallas").tag("dallas") }
                Picker("What you saw", selection: $model.report.kind) { Text("A quote in the app (before booking)").tag("quote"); Text("A ride I took").tag("completed") }
                Picker("Vehicle", selection: $model.report.vehicle) { Text("Not sure").tag("unknown"); Text("Cybercab").tag("cybercab"); Text("Model Y").tag("model_y") }
                Picker("Pickup area", selection: $model.report.pickup) { areaOptions(areas) }
                Picker("Drop-off area", selection: $model.report.dropoff) { areaOptions(areas) }
                DatePicker("When", selection: $model.report.observedAt, in: Date.now.addingTimeInterval(-30 * 86400)...Date.now)
                field("Price ($)", $model.report.fare, .decimalPad)
                field("Trip distance (mi)", $model.report.miles, .decimalPad)
                field("Trip time (min, optional)", $model.report.duration, .numberPad)
                field("Pickup wait the app quoted (min)", $model.report.quotedWait, .numberPad)
                field("Actual wait, request to pickup (min)", $model.report.actualWait, .numberPad)
                Toggle("The app said no cars were available", isOn: $model.report.noCars).tint(.brandGold)
                Button(model.sendingReport ? "Sending..." : "Send report") { Task { await model.sendReport(api: session.api, signedIn: session.user != nil) } }
                    .buttonStyle(GoldButtonStyle(small: true))
                    .disabled(model.sendingReport)
                    .accessibilityIdentifier("fareReportSend")
                if !model.reportStatus.isEmpty {
                    Text(model.reportStatus).font(.inter(12.5)).foregroundStyle(Color.chFog).accessibilityIdentifier("fareReportStatus")
                }
            }
            .font(.inter(14))
            .padding(.top, 8)
            .task(id: model.report.city) { await model.loadEta(model.report.city, api: session.api) }
        } label: {
            (Text("Report a fare or wait").foregroundStyle(Color.chInk) + Text(" · optional, helps calibrate").foregroundStyle(Color.chCaption))
                .font(.inter(14.5, .semibold))
        }
        .tint(.brandGold)
        .glassCard()
        .accessibilityIdentifier("fareReport")
    }

    @ViewBuilder private func areaOptions(_ areas: [FleetEta.Area]) -> some View {
        Text("Not sure").tag("")
        ForEach(areas) { Text($0.label).tag($0.key) }
        Text("Elsewhere in \(SimulationCalc.cityName[model.report.city] ?? "")").tag("other")
    }

    private func field(_ label: String, _ text: Binding<String>, _ kb: UIKeyboardType) -> some View {
        HStack {
            Text(label).foregroundStyle(Color.chMist)
            Spacer()
            TextField("", text: text).keyboardType(kb).multilineTextAlignment(.trailing).frame(width: 90)
                .padding(.horizontal, 8).frame(minHeight: 36)
                .background(Color.chBackground, in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.chHair2))
        }
    }
}
