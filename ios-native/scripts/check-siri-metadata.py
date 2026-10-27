#!/usr/bin/env python3
"""Validate exported App Intents routing metadata, not Siri voice recognition.

Usage: python3 ios-native/scripts/check-siri-metadata.py <extract.actionsdata>
The input must come from a completed build; this does not build or install.
"""
import json
import re
import sys
from pathlib import Path


def exact_phrase_owners(metadata, target):
    """Finite exported template/enum matches only; not Siri semantic routing.

    Include enum synonyms so a different template cannot hide an exact alias
    collision with a protected literal. Dynamic entity names are not enumerable.
    """
    owners = set()
    for shortcut in metadata["autoShortcuts"]:
        owner = shortcut["actionIdentifier"]
        parameters = {p["name"]: p for p in metadata["actions"][owner].get("parameters", [])}
        for phrase in shortcut["phraseTemplates"]:
            text = phrase["key"]
            tokens = [t for t in re.findall(r"\$\{([^}]+)\}", text) if t != "applicationName"]
            expansions = [text]
            if tokens:
                enum_id = parameters[tokens[0]]["valueType"].get("linkEnumeration", {}).get("wrapper", {}).get("identifier")
                enum = next((e for e in metadata["enums"] if e["identifier"] == enum_id), None)
                values = [] if enum is None else [v["key"] for c in enum["cases"] for v in [c["displayRepresentation"]["title"], *c["displayRepresentation"].get("synonyms", [])]]
                expansions = [text.replace("${" + tokens[0] + "}", value) for value in values]
            if any(e.casefold() == target.casefold() for e in expansions):
                owners.add(owner)
    return owners


def expanded_inventory(metadata):
    """Enumerate exported titles and synonyms; entity names remain dynamic.

    Count each expansion before deduplication for a conservative static budget.
    The app's VehicleQuery suggests at most ten entities; dynamic spoken names
    and Siri's semantic matching cannot be exhaustively checked here.
    """
    owners = {}
    finite = 0
    dynamic = 0
    for shortcut in metadata["autoShortcuts"]:
        owner = shortcut["actionIdentifier"]
        parameters = {p["name"]: p for p in metadata["actions"][owner].get("parameters", [])}
        for phrase in shortcut["phraseTemplates"]:
            text = phrase["key"]
            tokens = [t for t in re.findall(r"\$\{([^}]+)\}", text) if t != "applicationName"]
            values = [text]
            if tokens:
                parameter = parameters[tokens[0]]
                enum_id = parameter["valueType"].get("linkEnumeration", {}).get("wrapper", {}).get("identifier")
                enum = next((e for e in metadata["enums"] if e["identifier"] == enum_id), None)
                if enum is None:
                    dynamic += 1
                    continue
                values = [text.replace("${" + tokens[0] + "}", v["key"]) for c in enum["cases"] for v in [c["displayRepresentation"]["title"], *c["displayRepresentation"].get("synonyms", [])]]
            finite += len(values)
            for value in values:
                normalized = " ".join(re.sub(r"[^\w${}]+", " ", value.casefold()).split())
                owners.setdefault(normalized, set()).add(owner)
    collisions = {phrase: sorted(actions) for phrase, actions in owners.items() if len(actions) > 1}
    return {"finite_expansions_with_synonyms": finite, "unique_finite_phrases": len(owners),
            "dynamic_entity_templates": dynamic, "budget_with_ten_suggested_vehicles": finite + dynamic * 10,
            "collisions": collisions}


def validate(metadata):
    shortcuts = metadata["autoShortcuts"]
    assert len(shortcuts) == 10, "Advertised shortcut count changed"
    owners = {}
    count = 0
    for shortcut in shortcuts:
        owner = shortcut["actionIdentifier"]
        for phrase in shortcut["phraseTemplates"]:
            text = phrase["key"]
            tokens = re.findall(r"\$\{([^}]+)\}", text)
            assert "applicationName" in tokens, (owner, "Missing app-name token")
            assert len([x for x in tokens if x != "applicationName"]) <= 1, (owner, text)
            # Different parameter names must not hide an identical phrase shape.
            shape = re.sub(r"\$\{([^}]+)\}", lambda m: "{app}" if m[1] == "applicationName" else "{parameter}", text).casefold()
            assert shape not in owners or owners[shape] == owner, ("Cross-intent phrase collision", shape, owners.get(shape), owner)
            owners[shape] = owner
            if owner == "RecentSightingsIntent":
                assert any(word in shape for word in ("sightings", "spotted")), "Sightings domain must be explicit outside the parameter"
            count += 1
    assert "check {parameter} in {app}" not in owners, "Generic Check parameter phrase reintroduced"
    actions = metadata["actions"]
    for identifier in ("RecentSightingsIntent", "DallasWeeklySightingsIntent", "CheckDMVIntent"):
        action = actions[identifier]
        assert action["openAppWhenRun"] is False, identifier
        assert action["supportedModes"] == 1, (identifier, "Expected background support")
        assert action["authenticationPolicy"] == 0, (identifier, "Expected alwaysAllowed")
    sightings = {x["name"]: x for x in actions["RecentSightingsIntent"]["parameters"]}
    assert sightings["period"]["isOptional"]
    assert "LNValueTypeSpecificMetadataKeyDefaultValue" not in sightings["period"].get("typeSpecificMetadata", []), "Omitted period must remain distinguishable from an explicit conflicting 24 hours"
    assert sightings["question"]["valueType"]["linkEnumeration"]["wrapper"]["identifier"] == "CitySightingsQuestion"
    dmv = {x["name"]: x for x in actions["CheckDMVIntent"]["parameters"]}
    assert dmv["question"]["valueType"]["linkEnumeration"]["wrapper"]["identifier"] == "DMVQuestion"
    sightings_shortcut = next(x for x in shortcuts if x["actionIdentifier"] == "RecentSightingsIntent")
    assert any(x["key"] == "${applicationName} sightings in ${question}" for x in sightings_shortcut["phraseTemplates"]), "Preserve the user-verified short sightings phrase"
    # Validate the exact templates AND enum values, not merely intent presence.
    def case_title(enum_id, case_id):
        enum = next(e for e in metadata["enums"] if e["identifier"] == enum_id)
        case = next(c for c in enum["cases"] if c["identifier"] == case_id)
        return case["displayRepresentation"]["title"]["key"]
    assert len(actions) == 22, "Preserve existing intents and three fixed Dallas wrappers"
    original = {"CheckDMVIntent", "CityActivityIntent", "DailyBriefingIntent", "FindVehicleIntent",
                "FleetGrowthIntent", "FleetStatsIntent", "NearbySightingsIntent", "OpenDMVSnapshotIntent",
                "OpenScreenIntent", "OpenServiceZoneIntent", "OpenSightingIntent", "OpenSightingsIntent",
                "OpenVehicleIntent", "OpenZonesIntent", "QuickStatusIntent", "RecentSightingsIntent",
                "ServiceZoneIntent", "SubmitSightingIntent", "VehicleHistoryIntent"}
    assert set(actions) == original | {"DallasWeeklySightingsIntent", "DallasFleetSummaryIntent", "DallasServiceZoneIntent"}
    city = sightings["city"]
    assert city["isOptional"] is True
    assert "LNValueTypeSpecificMetadataKeyDefaultValue" not in city.get("typeSpecificMetadata", []), "No implicit Austin fallback"
    assert "OpenScreenIntent" in actions
    dallas = next(x for x in shortcuts if x["actionIdentifier"] == "DallasWeeklySightingsIntent")
    assert "${applicationName} Dallas weekly sightings" in [p["key"] for p in dallas["phraseTemplates"]]
    assert not actions["DallasWeeklySightingsIntent"].get("parameters"), "Dallas must have no resolvable city or period"
    assert case_title("CitySightingsQuestion", "austinToday") == "Austin today"
    assert case_title("CitySightingsQuestion", "dallasThisWeek") == "Dallas weekly"
    assert case_title("CityActivityQuestion", "compareSightingsThisWeek") == "Weekly sightings comparison"
    assert not any(p["key"] == "${applicationName} ${question} sightings" for p in sightings_shortcut["phraseTemplates"]), "Remove ambiguous reverse-order expansion"
    fleet = next(x for x in shortcuts if x["actionIdentifier"] == "FleetStatsIntent")
    assert any(p["key"] == "${applicationName} ${activity}" for p in fleet["phraseTemplates"])
    activity = next(p for p in actions["FleetStatsIntent"]["parameters"] if p["name"] == "activity")
    assert activity["valueType"]["linkEnumeration"]["wrapper"]["identifier"] == "CityActivityQuestion"
    for phrase, expected in {
        "${applicationName} Dallas weekly sightings": "DallasWeeklySightingsIntent",
        "${applicationName} sightings in Austin today": "RecentSightingsIntent",
        "${applicationName} Weekly sightings comparison": "FleetStatsIntent",
    }.items():
        owners = exact_phrase_owners(metadata, phrase)
        assert owners == {expected}, (phrase, owners)
    for identifier in ("DallasFleetSummaryIntent", "DallasServiceZoneIntent"):
        action = actions[identifier]
        assert not action.get("parameters"), (identifier, "Must be parameter-free")
        assert action["isDiscoverable"] and action["supportedModes"] == 1
        assert action["authenticationPolicy"] == 0 and not action["openAppWhenRun"]
    for phrase, identifier in {
        "${applicationName} Dallas fleet summary": "DallasFleetSummaryIntent",
        "Fleet summary for Dallas in ${applicationName}": "DallasFleetSummaryIntent",
        "${applicationName} Dallas service area": "DallasServiceZoneIntent",
        "How big is the Dallas Cybercab service area in ${applicationName}": "DallasServiceZoneIntent",
        "${applicationName} fleet stats": "FleetStatsIntent",
    }.items():
        assert exact_phrase_owners(metadata, phrase) == {identifier}, phrase
    assert not any(x["actionIdentifier"] in {"OpenVehicleIntent", "ServiceZoneIntent"} for x in shortcuts)
    zone_city = next(p for p in actions["ServiceZoneIntent"]["parameters"] if p["name"] == "city")
    assert not zone_city["isOptional"]
    assert "LNValueTypeSpecificMetadataKeyDefaultValue" not in zone_city.get("typeSpecificMetadata", []), "No implicit Austin zone"
    growth = actions["FleetGrowthIntent"]
    assert growth["isDiscoverable"] and growth["visibilityMetadata"]["isDiscoverable"]
    assert not growth["visibilityMetadata"]["assistantOnly"]
    assert growth["supportedModes"] == 1 and not growth["openAppWhenRun"]
    assert {x["key"] for x in growth["descriptionMetadata"]["searchKeywords"]} >= {"growth", "Cybercab", "VIN", "DMV"}
    parameters = {p["name"]: p for p in growth["parameters"]}
    for name, enum, default in [("model", "GrowthModel", "all"), ("period", "GrowthPeriod", "week")]:
        p = parameters[name]
        assert p["valueType"]["linkEnumeration"]["wrapper"]["identifier"] == enum
        assert p["typeSpecificMetadata"] == ["LNValueTypeSpecificMetadataKeyDefaultValue", {"string": {"wrapper": default}}]
    assert parameters["from"]["isOptional"] and parameters["to"]["isOptional"]
    assert count == 42, "Unexpected phrase inventory"
    protected = json.loads(Path(__file__).with_name("siri-build4-contract.json").read_text())
    assert set(actions) == set(protected["actions"])
    for prior in protected["shortcuts"]:
        current = next(s for s in shortcuts if s["actionIdentifier"] == prior["actionIdentifier"])
        assert {p["key"] for p in prior["phraseTemplates"]} <= {p["key"] for p in current["phraseTemplates"]}
        assert current["shortTitle"] == prior["shortTitle"]
    baseline = json.loads(Path(__file__).with_name("siri-natural-baseline.json").read_text())
    for owner, phrases in baseline["phrase_templates"].items():
        actual = next(x for x in shortcuts if x["actionIdentifier"] == owner)
        keys = {p["key"] for p in actual["phraseTemplates"]}
        assert set(phrases) <= keys, ("Existing phrases removed", owner, set(phrases) - keys)
        if owner == "FleetGrowthIntent":
            assert keys == set(phrases), "Growth phrases changed"
    for identifier in ("OpenZonesIntent", "OpenSightingsIntent"):
        city_parameter = next(p for p in actions[identifier]["parameters"] if p["name"] == "city")
        assert not city_parameter["isOptional"]
        assert "LNValueTypeSpecificMetadataKeyDefaultValue" not in city_parameter.get("typeSpecificMetadata", []), "No implicit Austin navigation"
    for enum_id in ("ServiceCity",):
        enum = next(e for e in metadata["enums"] if e["identifier"] == enum_id)
        assert {c["identifier"] for c in enum["cases"]} == {"austin", "dallas"}
    question = next(p for p in actions["CityActivityIntent"]["parameters"] if p["name"] == "question")
    assert not question["isOptional"]
    assert "LNValueTypeSpecificMetadataKeyDefaultValue" not in question.get("typeSpecificMetadata", []), "No default Austin activity"
    expanded = expanded_inventory(metadata)
    assert not expanded["collisions"], ("Expanded cross-intent collisions", expanded["collisions"])
    assert expanded["finite_expansions_with_synonyms"] + 10 * expanded["dynamic_entity_templates"] <= 1000, "Expanded phrase budget exceeded"
    # New generic DMV template is safe only while every enum value names DMV or Texas VINs.
    dmv_enum = next(e for e in metadata["enums"] if e["identifier"] == "DMVQuestion")
    for case in dmv_enum["cases"]:
        for value in [case["displayRepresentation"]["title"], *case["displayRepresentation"].get("synonyms", [])]:
            wording = value["key"].casefold()
            assert "dmv" in wording or ("vin" in wording and "texas" in wording), wording
    briefing = next(x for x in shortcuts if x["actionIdentifier"] == "DailyBriefingIntent")
    assert any(x["key"] == "Give me my ${applicationName} briefing" for x in briefing["phraseTemplates"])
    return {"advertised_shortcuts": len(shortcuts), "phrase_templates": count,
            **expanded,
            "existing_phrase_templates_preserved": 38,
            "cross_intent_structural_collisions": 0,
            "sightings_and_dmv_background_and_authentication": "validated",
            "voice_recognition": "not tested"}


if __name__ == "__main__":
    path = Path(sys.argv[1])
    result = validate(json.loads(path.read_text()))
    # The generated training corpus is a second check on actual registrations.
    corpus = path.with_name("root.ssu.yaml").read_text()
    for required in ["${+applicationName} sightings in ${CitySightingsQuestion}",
                     "${+applicationName} Dallas weekly sightings",
                     "${+applicationName} ${CityActivityQuestion}",
                     "- Austin today", "- Dallas weekly", "- Weekly sightings comparison",
                     "${+applicationName} Dallas fleet summary", "${+applicationName} Dallas service area",
                     "Read Cybercab camera detections for ${CameraCityPeriod} in ${+applicationName}",
                     "Read public registry fleet data for ${ServiceCity} in ${+applicationName}",
                     "Compare approved Cybercab sightings in Austin and Dallas ${ActivityPeriod} in ${+applicationName}",
                     "Count approved Cybercab sightings for ${CitySightingsQuestion} in ${+applicationName}"]:
        assert required in corpus, ("Missing trained template/value", required)
    result["exact_short_commands_and_training_values"] = "validated (not voice recognition)"
    print(json.dumps(result, indent=2))
