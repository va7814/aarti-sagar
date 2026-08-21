from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from google.genai.errors import ClientError
from pydantic import BaseModel
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import auth as firebase_auth
from firebase_admin import firestore

load_dotenv(Path(__file__).parent / ".env")

app = FastAPI(title="Aarati Sagar AI service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("WEB_ORIGIN", "http://localhost:3000")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"]) if os.getenv("GEMINI_API_KEY") else None
FIRESTORE_ENABLED = os.getenv("FIRESTORE_ENABLED", "false").lower() == "true"
if FIRESTORE_ENABLED and not firebase_admin._apps:
    firebase_admin.initialize_app()
firestore_client = firestore.client() if FIRESTORE_ENABLED else None
CATALOG_PATH = Path(__file__).parent.parent / "data" / "aartis.json"
DEITIES_PATH = Path(__file__).parent.parent / "data" / "deities.json"
SUBMISSIONS_PATH = Path(__file__).parent.parent / "data" / "submissions.json"


class SearchRequest(BaseModel):
    query: str


class SearchResult(BaseModel):
    title: str
    deity: str
    text: str
    source: str | None = None


class SubmissionRequest(BaseModel):
    title: str
    deity: str
    text: str
    source: str = "User contribution"


class Submission(SubmissionRequest):
    id: str
    status: str = "In review"


def load_catalog() -> list[dict[str, Any]]:
    if firestore_client:
        return [document.to_dict() for document in firestore_client.collection("aartis").stream()]
    with CATALOG_PATH.open(encoding="utf-8") as catalog_file:
        return json.load(catalog_file)


def load_deities() -> list[str]:
    if firestore_client:
        return [document.to_dict().get("name", document.id) for document in firestore_client.collection("deities").stream()]
    with DEITIES_PATH.open(encoding="utf-8") as deities_file:
        return json.load(deities_file)


def load_submissions() -> list[dict[str, Any]]:
    if firestore_client:
        return [document.to_dict() | {"id": document.id} for document in firestore_client.collection("submissions").stream()]
    if not SUBMISSIONS_PATH.exists():
        return []
    with SUBMISSIONS_PATH.open(encoding="utf-8") as submissions_file:
        return json.load(submissions_file)


def save_json(path: Path, value: Any) -> None:
    with path.open("w", encoding="utf-8") as output_file:
        json.dump(value, output_file, ensure_ascii=False, indent=2)


def save_submissions(submissions: list[dict[str, Any]]) -> None:
    if firestore_client:
        collection = firestore_client.collection("submissions")
        for submission in submissions:
            submission_id = submission["id"]
            collection.document(submission_id).set({key: value for key, value in submission.items() if key != "id"})
    else:
        save_json(SUBMISSIONS_PATH, submissions)


def add_catalog_item(item: dict[str, Any]) -> None:
    if firestore_client:
        firestore_client.collection("aartis").add(item)
    else:
        catalog = load_catalog()
        catalog.append(item)
        save_json(CATALOG_PATH, catalog)


def verify_token(authorization: str | None) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Firebase login required")
    try:
        return firebase_auth.verify_id_token(authorization.removeprefix("Bearer "))
    except Exception as error:
        raise HTTPException(status_code=401, detail="Invalid Firebase login") from error


def require_admin(authorization: str | None) -> dict[str, Any]:
    token = verify_token(authorization)
    if token.get("admin") is True:
        return token
    if firestore_client:
        profile = firestore_client.collection("users").document(token["uid"]).get()
        if profile.exists and profile.to_dict().get("role") == "admin":
            return token
    raise HTTPException(status_code=403, detail="Admin role required")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "gemini": "configured" if _client else "missing GEMINI_API_KEY", "database": "firestore" if firestore_client else "local-json"}


@app.get("/catalog", response_model=list[SearchResult])
def get_catalog() -> list[SearchResult]:
    return [SearchResult(**item) for item in load_catalog()]


@app.get("/deities", response_model=list[str])
def get_deities() -> list[str]:
    return load_deities()


@app.post("/voice-to-text")
async def voice_to_text(audio: UploadFile = File(...)) -> dict[str, str]:
    if not _client:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured")
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is empty")

    try:
        response = _client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(data=audio_bytes, mime_type=audio.content_type or "audio/webm"),
                "Transcribe this Marathi voice search exactly. Return only the spoken search text, with no explanation.",
            ],
        )
    except ClientError as error:
        raise HTTPException(status_code=502, detail=f"Gemini voice transcription failed: {error.message}") from error
    return {"text": (response.text or "").strip()}


@app.post("/extract-aarti")
async def extract_aarti(image: UploadFile = File(...), deity: str = "श्री गणपती", authorization: str | None = Header(default=None)) -> dict[str, str]:
    verify_token(authorization)
    if not _client:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured")
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image file is empty")

    prompt = """
Read this Marathi aarati image and return JSON only in this exact shape:
{"title": "...", "text": "..."}
Preserve Marathi spelling, punctuation, line breaks, and Devanagari characters.
Do not add commentary. If the title is not visible, infer a short title from the first line.
"""
    try:
        response = _client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[types.Part.from_bytes(data=image_bytes, mime_type=image.content_type or "image/jpeg"), prompt],
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        extracted = json.loads(response.text or "{}")
    except (ClientError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=502, detail=f"Aarti text extraction failed: {error}") from error

    return {"title": str(extracted.get("title", "Untitled aarti")), "deity": deity, "text": str(extracted.get("text", "")), "source": "User contribution"}


@app.get("/submissions", response_model=list[Submission])
def get_submissions(authorization: str | None = Header(default=None)) -> list[Submission]:
    verify_token(authorization)
    return [Submission(**submission) for submission in load_submissions()]


@app.post("/submissions", response_model=Submission)
def create_submission(request: SubmissionRequest, authorization: str | None = Header(default=None)) -> Submission:
    token = verify_token(authorization)
    submission = Submission(id=str(uuid.uuid4()), **request.model_dump())
    submission_data = submission.model_dump() | {"userId": token["uid"]}
    submissions = load_submissions()
    submissions.insert(0, submission_data)
    save_submissions(submissions)
    return submission


@app.post("/submissions/{submission_id}/approve", response_model=Submission)
def approve_submission(submission_id: str, authorization: str | None = Header(default=None)) -> Submission:
    require_admin(authorization)
    submissions = load_submissions()
    for submission in submissions:
        if submission["id"] != submission_id:
            continue
        submission["status"] = "Approved"
        add_catalog_item({key: submission[key] for key in ("title", "deity", "text", "source")})
        save_submissions(submissions)
        return Submission(**submission)
    raise HTTPException(status_code=404, detail="Submission not found")


@app.post("/search", response_model=list[SearchResult])
def search(request: SearchRequest) -> list[SearchResult]:
    if not _client:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured")

    prompt = f"""
You are searching an approved Marathi aarati catalog. The user query is: {request.query!r}
Return JSON only in this exact shape: {{"search_terms": ["..."]}}
Include the original query and useful Marathi deity/title synonyms. Do not invent an aarati title.
"""
    try:
        response = _client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
    except ClientError as error:
        raise HTTPException(status_code=502, detail=f"Gemini search failed: {error.message}") from error
    parsed: dict[str, Any] = json.loads(response.text or "{}")
    terms = [str(term).strip().lower() for term in parsed.get("search_terms", []) if str(term).strip()]

    catalog = load_catalog()
    return [
        SearchResult(**{key: item[key] for key in ("title", "deity", "text", "source")})
        for item in catalog
        if any(term in " ".join((item["title"], item["deity"], item["text"])).lower() for term in terms)
    ]
