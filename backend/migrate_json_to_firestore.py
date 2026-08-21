"""Import local catalog/deity JSON into Firestore using Application Default Credentials."""

import json
from pathlib import Path

import firebase_admin
from firebase_admin import firestore

ROOT = Path(__file__).parent.parent
firebase_admin.initialize_app()
database = firestore.client()

with (ROOT / "data" / "aartis.json").open(encoding="utf-8") as catalog_file:
    for item in json.load(catalog_file):
        database.collection("aartis").add(item)

with (ROOT / "data" / "deities.json").open(encoding="utf-8") as deities_file:
    for name in json.load(deities_file):
        database.collection("deities").document(name).set({"name": name})

print("Imported catalog and deities into Firestore")
