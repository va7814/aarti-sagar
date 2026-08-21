# Aarati Sagar

A Marathi aarati library for finding, reading, and preserving community scans.

## Recommended stack

- **Frontend:** Next.js App Router + TypeScript. It keeps the public search experience fast and gives us a clean home for authenticated contribution flows.
- **UI:** CSS modules/global CSS with a restrained editorial library style. `lucide-react` provides consistent interface icons.
- **Backend:** Python FastAPI service for Gemini-powered voice transcription and semantic query expansion. Firebase remains the system of record for Auth, Firestore, and Storage.
- **AI:** Gemini handles Marathi voice-to-text and query understanding. The Gemini key stays on the Python server and is never sent to the browser.
- **Data now:** Local JSON catalog at `data/aartis.json`, with one object per approved aarati containing `title`, `deity`, `text`, and `source`.
- **Data later:** Firestore for approved aarati documents and submission metadata; Firebase Storage for original scan files.
- **Deployment:** Firebase App Hosting for the Next.js app, with Firebase Auth, Firestore, Storage, and Cloud Functions for review triggers.

## Run locally

```bash
npm install
npm run dev
```

Copy `.env.local.example` to `.env.local` and add a Firebase web app configuration before connecting the data layer.

For the local AI service, copy `backend/.env.example` to `backend/.env`, add `GEMINI_API_KEY`, install `backend/requirements.txt`, and run `uvicorn main:app --reload` from the `backend` directory. Set `NEXT_PUBLIC_PYTHON_API_URL` in `.env.local` if the FastAPI service is not running on `http://127.0.0.1:8000`.

## Firebase deployment

Recommended production topology:

1. Deploy `backend/` as a Cloud Run service. Set `FIRESTORE_ENABLED=true`, `GEMINI_API_KEY`, and `WEB_ORIGINS` in Cloud Run environment variables. `WEB_ORIGINS` may contain comma-separated local and production origins. Cloud Run's service account supplies Firebase Admin credentials through Application Default Credentials.
2. Deploy the Next.js app with Firebase App Hosting using `apphosting.yaml`. Set all `NEXT_PUBLIC_FIREBASE_*` variables and `NEXT_PUBLIC_PYTHON_API_URL` in App Hosting environment settings. Do not commit placeholder production URLs.
3. Enable Email/Password authentication in Firebase Authentication.
4. Deploy `firestore.rules` and `storage.rules` with the Firebase CLI.
5. Create the first user account, then run `backend/create_admin.py` with that user's Firebase UID to assign `role: "admin"`. Never allow the browser to assign its own admin role.

Useful commands:

```bash
firebase login
firebase use YOUR_FIREBASE_PROJECT_ID
firebase deploy --only firestore:rules,storage
gcloud builds submit . --tag asia-south1-docker.pkg.dev/YOUR_FIREBASE_PROJECT_ID/aarati-repo/aarati-api
gcloud run deploy aarati-api --image gcr.io/YOUR_FIREBASE_PROJECT_ID/aarati-api --region YOUR_REGION --allow-unauthenticated
```

The local JSON files remain useful as seed data and a development fallback. For production, import their records into Firestore collections `aartis` and `deities`; uploaded scans belong in Firebase Storage, not GitHub. Advertisement images are public, non-secret assets and belong in `public/advertisements/` in GitHub, while catalog/submission data belongs in Firestore after deployment.

## Deities and advertisements

The editable upload selector is stored in `data/deities.json` as a simple Marathi string array. FastAPI exposes it through `/deities`, and the frontend loads that endpoint when it starts. Add, rename, or remove deity names in `data/deities.json`; no frontend option edit is needed.

Place multiple ad creatives in `public/advertisements/` and register each basename in `public/advertisements/ads.json`. Use names such as `left-ad-1.png` and `right-ad-1.png` (JPG with the same basename also works). Use **300 x 250 px** (4:3) images, ideally below 300 KB. PNG is preferred and JPG is used as a fallback. Only registered ads are rendered, so missing files never create blank slots. The left ads appear stacked below navigation and the right ads appear stacked beside the catalog. Ads are hidden on mobile so they do not interrupt search or reading.

## Firebase shape

- `aartis/{aartiId}`: `title`, `deityId`, `text`, `source`, `lineCount`, `publishedAt`, `searchTokens`
- `deities/{deityId}`: `nameMr`, `nameEn`, `slug`
- `submissions/{submissionId}`: `userId`, `storagePath`, `deityId`, `status`, `submittedAt`, `reviewedAt`, `reviewedBy`
- `users/{userId}`: `displayName`, `role` (`contributor` or `admin`)

Scans stay in Storage later and are never shown as the public reading view. During local development, admin approval should create or update an entry in `data/aartis.json` after OCR/manual transcription review.

## Current product slice

- Public Marathi text search with deity/category shortcuts.
- Voice search using browser speech recognition where supported.
- Sign-in gate before upload.
- Scan/image upload request flow with `In review` status.
- Admin preview mode to approve a request and change it to `Approved`.
- Firebase initialization boundary in `lib/firebase.ts`.

## AI request flow

1. The browser sends recorded Marathi audio directly to FastAPI `/voice-to-text`.
2. Python calls Gemini and returns the Marathi text query.
3. The UI sends that text to FastAPI `/search`.
4. Python uses Gemini to expand the query, then searches approved aarati records and returns text-only results.
