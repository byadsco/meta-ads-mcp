# Gemini video analysis

How `ads_analyze_video` works, what it costs, where the video goes, and which
guardrails apply. Written for anyone operating or reviewing this server.

## When it is the right tool

It is the last resort of three, and the tool descriptions say so:

| Your client's model | Use | Cost |
|---|---|---|
| Ingests video (Gemini CLI, agents on the Gemini API) | `ads_get_video_media delivery=inline` — the MP4 arrives as an MCP `resource` blob | none |
| Sees images (Claude, GPT, most others) | `ads_get_video_media delivery=frames` — real keyframes as image blocks | none |
| Text only, or needs a written verdict | `ads_analyze_video` — the server watches the video with Gemini | the tenant's Gemini quota |

`ads_analyze_video` handles one video per call. `card_index` picks one from a
carousel or a DCO ad; the response names how many others exist.

## What comes back

A readable brief plus a JSON block. The schema covers `language`, `summary`,
`hook` (first three seconds, technique, a 1-5 score and its reasoning), `cta`,
a verbatim `transcript`, `on_screen_text`, `scenes`, `audio`, `format` (aspect
ratio, style, cuts per ten seconds, subtitles, whether it works with sound off),
`branding`, `claims_and_compliance_flags`, `strengths`, `weaknesses`,
`improvement_ideas`, and `focus_answer` when a `focus` question was asked.

Transcripts and on-screen text stay in the ad's original language; everything
else is written in the requested `language`.

## The key belongs to the tenant

Storage mirrors the Meta and Apify credentials:

- `users/{fbUserId}/gemini_keys/default`, AES-256-GCM, additional authenticated
  data `gemini_key:<fbUserId>:default`. The namespace differs per credential
  kind, so a stored ciphertext cannot be relocated between users or between
  collections. A decryption failure propagates rather than degrading to "no
  key", which would fall through to a shared fallback.
- Only a truncated SHA-256 of the key is stored beside the ciphertext, for log
  correlation. No character of the key is kept in clear, and the status surface
  never returns the fingerprint to a browser.
- `GEMINI_API_KEY` is honoured only in stdio / single-operator mode. Sharing one
  key across OAuth tenants would bill every advertiser's analyses to the
  operator and mix their videos in one Google project. In multi-tenant mode an
  unidentified caller is refused rather than falling back.

Users register their own key on `/auth/connections` or with
`ads_register_gemini_key`. Either path validates it live against
`GET /v1beta/models?pageSize=1` before storing anything. Keys issued by AI
Studio since September 2026 start with `AQ.`; the older `AIza…` shape is
still accepted by the input check, and the live validation is what decides.
The repository's gitleaks config recognises both shapes and a key-shaped
`GEMINI_API_KEY=` assignment; the local pre-deploy guard blocks such a
commit, and CI fails an internal PR that carries one (PRs from forks are
not scanned in CI and rely on the maintainer's local guard).

## Cost and privacy

Roughly **USD 0.02 per ad** at the default settings, against the tenant's own
quota. Video costs about 100 tokens per second at low media resolution
(`detail=standard`) and about 300 at high (`detail=deep`).

Where the video goes:

- At or below `GEMINI_INLINE_MAX_BYTES` (12 MB) it is embedded in the request
  body. Nothing is stored at Google.
- Above that it goes through the Files API and is deleted in a `finally` block
  as soon as the analysis returns, including when the call failed or was
  aborted. If the delete fails the response says so; Google removes leftovers
  within 48 hours.
- Above `GEMINI_MAX_UPLOAD_BYTES` (40 MB) the video is transcoded down first,
  which also keeps the upload cheap. Without `ffmpeg` the call is refused with
  that explanation rather than sending a huge file.

Free-tier keys may have their inputs used to improve Google's models, so both
the tool description and the web UI recommend a paid-tier key for client
creatives.

## Guardrails

- **Per-tenant hourly cap** (`GEMINI_ANALYSES_PER_TENANT_PER_HOUR`, default 20),
  counted per instance. The slot is taken before the download and refunded if
  the work ended before the key was used; once Gemini has been called it stays
  spent, even on failure.
- **Result cache**, keyed by tenant, video, rendition, detail, language, focus,
  model and prompt version, with a 30-minute TTL and 100 entries. A retry of the
  same question is free. Values are cloned in and out, so one caller cannot edit
  what the next receives.
- **Same pipeline as the rest of the media tools**: pinned DNS with per-hop
  re-validation, the Meta CDN host allowlist, byte and duration caps, `ffprobe`
  validation before any decode, one scratch directory per video on tmpfs, the
  shared job runner with its semaphore and per-call time budget, and the
  caller's abort signal honoured throughout.
- **No billable retry.** A failed `generateContent` is reported, never repeated.
  The single exception is one prompt-only attempt after a 400 that names the
  schema field, which Google does not bill; the response then carries
  `schema_enforced: false`.
- **One model, chosen by the operator.** `GEMINI_MODEL` defaults to
  `gemini-3.8-flash` and only accepts identifiers matching `gemini-…`; anything
  else falls back to the default rather than being interpolated into a URL.
  `detail=standard` and `detail=deep` select the media resolution, not the
  model; both levels use the one configured model, so there is a single
  identifier to keep current when Google retires one.

## Handling the model's output as data

Everything Gemini writes describes an ad that someone else wrote, so it is
treated as untrusted:

- The system instruction tells the model that speech, captions and on-screen
  text are material to describe, never instructions to follow.
- The brief renders field by field. Every string goes through a sanitizer that
  collapses control characters and line separators and neutralizes hyphen runs,
  so the model cannot forge the fence that marks its own output as untrusted. A
  brief that has to be cut loses whole lines and still closes that fence.
- The JSON block is bounded before it is cached or returned, and reduced field
  by field (transcript, then on-screen text, then scenes, then a summary-only
  fallback) rather than truncated as a string, which would leave it unparseable.
- An answer that is not a JSON object is refused.

## Where the wire format comes from

The request and response shapes were taken from the wire types of the official
[`googleapis/js-genai`](https://github.com/googleapis/js-genai) SDK rather than
from the prose documentation: `responseJsonSchema`, `mediaResolution`
(`MEDIA_RESOLUTION_LOW` / `MEDIUM` / `HIGH`), `fileData.fileUri`,
`usageMetadata.*TokenCount`, and the `PROCESSING` / `ACTIVE` / `FAILED` file
states. The whole request body is built by one function, `buildGenerateBody`,
under a unit test, so an API change touches one place.

`PROMPT_VERSION` in [src/gemini/video-analysis.ts](../src/gemini/video-analysis.ts)
is part of the cache key: bump it whenever the prompt or the schema changes
meaning, or agents will keep receiving answers shaped by the old one.
