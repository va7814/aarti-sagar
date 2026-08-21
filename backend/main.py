from __future__ import annotations

import json
import os
import re
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
import fitz
from firebase_admin import auth as firebase_auth
from firebase_admin import firestore

load_dotenv(Path(__file__).parent / ".env")

allowed_origins = [
    origin.strip()
    for origin in re.split(r"[,;]", os.getenv("WEB_ORIGINS", os.getenv("WEB_ORIGIN", "http://localhost:3000")))
    if origin.strip()
]

app = FastAPI(title="Aarati Sagar AI service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip()
gemini_api_key = os.getenv("GEMINI_API_KEY", "").strip()
_client = genai.Client(api_key=gemini_api_key) if gemini_api_key else None
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


MAX_PDF_PAGES = 20
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


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


def is_admin_token(token: dict[str, Any]) -> bool:
    if token.get("admin") is True:
        return True
    if not firestore_client:
        return False
    profile = firestore_client.collection("users").document(token["uid"]).get()
    return profile.exists and profile.to_dict().get("role") == "admin"


def require_admin(authorization: str | None) -> dict[str, Any]:
    token = verify_token(authorization)
    if is_admin_token(token):
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


def extract_aarti_text(image_bytes: bytes, mime_type: str, deity: str) -> dict[str, str]:
    if not _client:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY is not configured")
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
            contents=[types.Part.from_bytes(data=image_bytes, mime_type=mime_type), prompt],
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        extracted = json.loads(response.text or "{}")
    except (ClientError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=502, detail=f"Aarti text extraction failed: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Aarti text extraction service error: {error}") from error

    title = str(extracted.get("title", "Untitled aarti")).strip()
    text = str(extracted.get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=422, detail="Gemini did not find readable Marathi text in this image")
    return {"title": title or "Untitled aarti", "deity": deity, "text": text, "source": "User contribution"}


@app.post("/extract-aarti")
async def extract_aarti(image: UploadFile = File(...), deity: str = "श्री गणपती", authorization: str | None = Header(default=None)) -> dict[str, str]:
    verify_token(authorization)
    image_bytes = await image.read()
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image must be 10 MB or smaller")
    return extract_aarti_text(image_bytes, image.content_type or "image/jpeg", deity)


@app.post("/extract-aarti-pdf", response_model=list[SubmissionRequest])
async def extract_aarti_pdf(document: UploadFile = File(...), deity: str = "श्री गणपती", authorization: str | None = Header(default=None)) -> list[dict[str, str]]:
    verify_token(authorization)
    if document.content_type not in {"application/pdf", "application/x-pdf"} and not (document.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=415, detail="Upload a PDF document")
    pdf_bytes = await document.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="PDF is empty")
    if len(pdf_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="PDF must be 10 MB or smaller")
    try:
        pdf = fitz.open(stream=pdf_bytes, filetype="pdf")
    except (fitz.FileDataError, RuntimeError) as error:
        raise HTTPException(status_code=422, detail="The uploaded file is not a readable PDF") from error
    try:
        if not pdf.page_count:
            raise HTTPException(status_code=422, detail="PDF has no pages")
        if pdf.page_count > MAX_PDF_PAGES:
            raise HTTPException(status_code=422, detail=f"PDF can contain up to {MAX_PDF_PAGES} pages")
        extracted: list[dict[str, str]] = []
        for page_number, page in enumerate(pdf, start=1):
            image_bytes = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).tobytes("png")
            try:
                item = extract_aarti_text(image_bytes, "image/png", deity)
            except HTTPException as error:
                raise HTTPException(status_code=422, detail=f"Could not extract aarti from page {page_number}: {error.detail}") from error
            item["source"] = f"User contribution · PDF page {page_number}"
            extracted.append(item)
        return extracted
    finally:
        pdf.close()


@app.get("/submissions", response_model=list[Submission])
def get_submissions(authorization: str | None = Header(default=None)) -> list[Submission]:
    token = verify_token(authorization)
    submissions = load_submissions()
    if not is_admin_token(token):
        submissions = [submission for submission in submissions if submission.get("userId") == token["uid"]]
    return [Submission(**submission) for submission in submissions]


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
