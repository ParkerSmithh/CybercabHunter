"""Regression tests against a completed build's exported metadata.
Run: python3 ios-native/scripts/test_siri_metadata.py <extract.actionsdata>
These test metadata contracts, never Siri recognition or private registration.
"""
import copy
import csv
import hashlib
import re
import json
import sys
import unittest
from pathlib import Path
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location("guard", Path(__file__).with_name("check-siri-metadata.py"))
guard = module_from_spec(spec)
spec.loader.exec_module(guard)
metadata = json.loads(Path(sys.argv.pop(1)).read_text())

class SiriMetadataTests(unittest.TestCase):
    def test_current_contract(self):
        guard.validate(metadata)

    def test_dallas_is_discoverable_and_has_no_parameters(self):
        action = metadata["actions"]["DallasWeeklySightingsIntent"]
        self.assertTrue(action["isDiscoverable"])
        self.assertEqual(action["parameters"], [])
        self.assertEqual(guard.exact_phrase_owners(metadata, "${applicationName} Dallas weekly sightings"), {"DallasWeeklySightingsIntent"})

    def test_old_dallas_template_is_rejected(self):
        broken = copy.deepcopy(metadata)
        s = next(s for s in broken["autoShortcuts"] if s["actionIdentifier"] == "RecentSightingsIntent")
        s["phraseTemplates"].append({"key": "${applicationName} ${question} sightings"})
        with self.assertRaises(AssertionError): guard.validate(broken)

    def test_alias_collision_with_fleet_is_rejected(self):
        broken = copy.deepcopy(metadata)
        enum = next(e for e in broken["enums"] if e["identifier"] == "CityActivityQuestion")
        enum["cases"][0]["displayRepresentation"].setdefault("synonyms", []).append({"key": "Dallas weekly sightings"})
        with self.assertRaises(AssertionError): guard.validate(broken)

    def test_dallas_parameter_regression_is_rejected(self):
        broken = copy.deepcopy(metadata)
        broken["actions"]["DallasWeeklySightingsIntent"]["parameters"] = copy.deepcopy(broken["actions"]["RecentSightingsIntent"]["parameters"])
        with self.assertRaises(AssertionError): guard.validate(broken)

    def test_fixed_dallas_actions_reject_parameters(self):
        for identifier in ("DallasFleetSummaryIntent", "DallasServiceZoneIntent"):
            broken = copy.deepcopy(metadata)
            broken["actions"][identifier]["parameters"] = copy.deepcopy(metadata["actions"]["ServiceZoneIntent"]["parameters"])
            with self.assertRaises(AssertionError): guard.validate(broken)

    def test_zone_default_is_rejected(self):
        broken = copy.deepcopy(metadata)
        city = next(p for p in broken["actions"]["ServiceZoneIntent"]["parameters"] if p["name"] == "city")
        city["typeSpecificMetadata"] = ["LNValueTypeSpecificMetadataKeyDefaultValue", {"string": {"wrapper": "austin"}}]
        with self.assertRaises(AssertionError): guard.validate(broken)

    def test_growth_hidden_or_missing_search_metadata_is_rejected(self):
        for field in ("hidden", "keywords"):
            broken = copy.deepcopy(metadata)
            growth = broken["actions"]["FleetGrowthIntent"]
            if field == "hidden": growth["visibilityMetadata"]["assistantOnly"] = True
            else: growth["descriptionMetadata"]["searchKeywords"] = []
            with self.assertRaises(AssertionError): guard.validate(broken)

    def test_original_phrases_cannot_be_removed(self):
        broken = copy.deepcopy(metadata)
        shortcut = next(s for s in broken["autoShortcuts"] if s["actionIdentifier"] == "DailyBriefingIntent")
        phrase = next(p for p in shortcut["phraseTemplates"] if p["key"] == "Give me my ${applicationName} briefing")
        phrase["key"] = "A different briefing in ${applicationName}" # Keep count unchanged; test preservation itself.
        with self.assertRaises(AssertionError): guard.validate(broken)

    def test_expanded_collision_not_visible_in_template_shape_is_rejected(self):
        broken = copy.deepcopy(metadata)
        enum = next(e for e in broken["enums"] if e["identifier"] == "CityActivityQuestion")
        enum["cases"][0]["displayRepresentation"].setdefault("synonyms", []).append({"key": "Dallas Cybercab sightings this week"})
        with self.assertRaises(AssertionError): guard.validate(broken)

    def test_expansion_budget_includes_synonyms(self):
        broken = copy.deepcopy(metadata)
        enum = next(e for e in broken["enums"] if e["identifier"] == "CityActivityQuestion")
        enum["cases"][0]["displayRepresentation"].setdefault("synonyms", []).extend({"key": f"Camera synonym {i}"} for i in range(1001))
        with self.assertRaises(AssertionError): guard.validate(broken)

    def test_growth_source_and_vocabulary_are_unchanged(self):
        baseline = json.loads(Path(__file__).with_name("siri-natural-baseline.json").read_text())
        root = Path(__file__).resolve().parents[1] / "CybercabHunter/Features/Intents"
        for name, contract in baseline["unchanged_growth_source"].items():
            source = (root / contract["file"]).read_text()
            block = re.search(r"^" + contract["kind"] + " " + name + r"\b.*?^}", source, re.M | re.S)[0]
            self.assertEqual(hashlib.sha256(block.encode()).hexdigest(), contract["sha256"], name)

    def test_activity_default_is_rejected(self):
        broken = copy.deepcopy(metadata)
        p = next(p for p in broken["actions"]["CityActivityIntent"]["parameters"] if p["name"] == "question")
        p["typeSpecificMetadata"] = ["LNValueTypeSpecificMetadataKeyDefaultValue", {"string": {"wrapper": "austinCamerasLast24Hours"}}]
        with self.assertRaises(AssertionError): guard.validate(broken)

    def test_device_matrix_registered_rows_match_compiled_metadata(self):
        matrix = Path(__file__).resolve().parents[2] / "docs/verification/siri-natural-language/device-test-matrix.csv"
        with matrix.open() as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(len(rows), 40)
        for row in rows:
            if row["registration"] == "experimental": continue
            phrase = row["phrase"].replace("Cybercab Hunter", "${applicationName}")
            owner = row["intended_intent"].split(" -> ")[0]
            self.assertEqual(guard.exact_phrase_owners(metadata, phrase), {owner}, row["case"])

    def test_working_enum_bindings_are_preserved(self):
        prior = json.loads(Path(__file__).with_name("siri-build4-contract.json").read_text())
        for old_enum in prior["enums"]:
            current = next(e for e in metadata["enums"] if e["identifier"] == old_enum["identifier"])
            for old_case in old_enum["cases"]:
                if old_enum["identifier"] == "CityActivityQuestion" and old_case["identifier"] == "clarifyActivity": continue
                new_case = next(c for c in current["cases"] if c["identifier"] == old_case["identifier"])
                self.assertEqual(new_case["displayRepresentation"], old_case["displayRepresentation"])

    def test_domain_bindings_and_context_aliases(self):
        fleet = {p["name"]: p for p in metadata["actions"]["FleetStatsIntent"]["parameters"]}
        for name, enum_id in [("cameraQuestion", "CameraCityPeriod"), ("registryCity", "ServiceCity"), ("comparisonPeriod", "ActivityPeriod")]:
            self.assertTrue(fleet[name]["isOptional"])
            self.assertEqual(fleet[name]["valueType"]["linkEnumeration"]["wrapper"]["identifier"], enum_id)
            self.assertNotIn("LNValueTypeSpecificMetadataKeyDefaultValue", fleet[name].get("typeSpecificMetadata", []))
        contexts = next(e for e in metadata["enums"] if e["identifier"] == "CityActivityQuestion")
        for case_id, wording in [("clarifyComparison", "Compare Austin and Dallas Cybercab activity"),
                                 ("clarifyComparisonToday", "How do Dallas and Austin compare today"),
                                 ("clarifyCamerasThisWeek", "Cybercab camera detections this week")]:
            case = next(c for c in contexts["cases"] if c["identifier"] == case_id)
            self.assertEqual(case["displayRepresentation"]["title"]["key"], wording)
        camera = next(e for e in metadata["enums"] if e["identifier"] == "CameraCityPeriod")
        self.assertEqual(len(camera["cases"]), 12)
        self.assertTrue(all(c["identifier"].startswith(("austin", "dallas")) for c in camera["cases"]))

    def test_arbitrary_questions_are_not_literal_registered_commands(self):
        self.assertEqual(guard.exact_phrase_owners(metadata, "How many Cybercab sightings are there in Austin today in ${applicationName}?"), set())
        # This does not imply Siri cannot recognize a semantic variation.

if __name__ == "__main__": unittest.main()
