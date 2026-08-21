"""Create or promote an admin profile using Firebase Admin credentials.

Run locally after setting GOOGLE_APPLICATION_CREDENTIALS and ADMIN_UID.
"""

import os

import firebase_admin
from firebase_admin import firestore

firebase_admin.initialize_app()
database = firestore.client()
uid = os.environ["ADMIN_UID"]
database.collection("users").document(uid).set({"role": "admin"}, merge=True)
print(f"Admin role assigned to {uid}")
