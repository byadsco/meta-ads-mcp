# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **ffmpeg's encoders are limited to one thread.** The wrapper passed
  `-threads 1` before `-i`, which bounds decoding, and `-filter_threads 1`,
  which bounds filtering; the encoders were unbounded, so libx264 sized its
  own pool to the machine and one `delivery=inline` transcode could occupy
  every core the instance had. An output-side `-threads 1` now bounds the
  H.264 encoder in `compact()` and the MJPEG encoder in `extractFrames()`
  and `contactSheet()`. Measured with ffmpeg 9.0.1 on a 20-second 1080p
  clip, peak threads for the transcode drop from 28 to 9, the remaining
  ones being ffmpeg's own scheduler threads. On a 240-second 1080p clip, the
  longest the server accepts, the transcode's wall time is unchanged at
  11 seconds, because decoding the 1080p source, not encoding at 480p, is
  the bottleneck; it used 26 seconds of CPU, far inside the 150-second
  timeout even on a slower core. SECURITY.md now describes each limit as
  implemented.
- **`ads_get_video_media`'s description states both inline caps.** It gave
  only the HTTP cap and said Claude Code and Claude Desktop reject large
  results, which confused the transport with the client: the 6 MiB of raw
  media is this server's budget for stdio, sized to the TypeScript MCP SDK
  clients' default 10 MiB read buffer, and the advice to use frames is a
  property of models
  that read images rather than video. Agents read this text on every
  `tools/list`, and Context7 quotes it.

## [4.0.0] — 2026-09-18

### Why this release

Two things that installers and clients depend on changed since 3.6.0, and
either alone makes this a major. The minimum Node.js is now 22.13: Node 20
left support in April 2026, the production image had run Node 22 since the
video pipeline landed while CI still tested on 20, and the two dependency
majors that were waiting on the floor (`@google-cloud/firestore` 9 and
vitest 5) are in this release. And the JSON Schemas the server publishes for its 142
tools are now produced by zod 4's converter, which emits different output
from the one zod 3 used; the differences are listed under Changed and in
[docs/migration-v4.md](docs/migration-v4.md).

The release also carries everything the four creative-analysis PRs built:
a hardened video pipeline that hands a model real keyframes or the MP4
itself, Ad Library media, server-side video analysis with Gemini on the
tenant's own key, a one-call ad dossier, and four skills published as MCP
resources, prompts and server instructions. Plus the deploy fixes that
followed them: the Cloud Run execution environment pinned to gen2, results
over stdio budgeted to the SDK's read buffer, and an ffmpeg startup probe
that no longer caches a timeout as "no ffmpeg".

What does not change: every tool name, every existing parameter and its
meaning (several tools gained optional parameters), the authentication
model, both transports, and the `register*Tools(server)` exports.

### Breaking changes

- **Minimum Node.js is 22.13.** `engines.node` moved from `>=20.10.0` to
  `>=22.13.0`, which npm treats as a warning by default and as an install
  failure under `engine-strict`, so it is a major for anyone installing the
  package. The production image had run Node 22 since the video pipeline
  landed while the workflows tested on Node 20, and Node 20 left support in
  April 2026. 22.13 rather than 22 flat because the toolchain needs it:
  ESLint 10 requires `^22.13.0` on the 22 line; vitest 5 (#154), in this
  release, requires `^22.12.0 || ^24.0.0 || >=26.0.0`; and
  `@google-cloud/firestore` 9 (#149), also in this release, requires Node 22
  as its only breaking change. CI, the deploy preflight and the publish
  workflow run Node 22, and the Dependabot config no longer holds vitest
  back at 4.
- **The published tool JSON Schemas changed.** zod 4's converter drops
  `additionalProperties: false` from every object, inlines reused
  sub-schemas and adds a few informative keywords. No tool's accepted input
  changed; the details and the consequence for OpenAI strict function calling
  are under Changed and in [docs/migration-v4.md](docs/migration-v4.md).
- **Tool results over stdio are budgeted to 6 MiB of media.** The unreleased
  first version of `ads_get_video_media` advertised inline video up to
  50 MiB over stdio, which no client using the SDK's default 10 MiB read
  buffer can receive; the budget is now sized to that buffer. HTTP is
  unchanged. Details
  under Fixed.

### Added

- **One ad in full — `ads_get_ad_dossier` (141 → 142 tools).** A creative
  review needs the ad, its ad set and campaign, the creative with its copy,
  effective landing URL and UTM tags, the targeting in Meta's own words, the
  performance for the period with the video retention funnel and the auction
  rankings, and the creative media itself. Asking for each separately costs a
  dozen calls. Only the first call, for the ad, can fail the tool; every other
  section is fetched in parallel and a section that fails is named in
  `sections_failed` rather than losing the rest. The retention funnel is
  reported as shares of plays, guarded against zero plays, and a below-average
  ranking carries Meta's own hypothesis about what to change.
- **Four skills, shipped with the server and exposed over MCP.**
  `meta-ads-mcp-guide` (which tool answers which question, what writes cost,
  the ID and permission rules that make calls fail, plus a map of all 142
  tools, the recurring workflows and a safety-and-costs reference),
  `meta-ads-creative-analysis`, `meta-ads-video-analysis` and
  `meta-ads-competitor-research`. They are published as MCP **resources** under
  `meta-ads://skills/`, wrapped in six MCP **prompts** that start a job with
  the relevant skill already in hand (`analyze_ad`, `analyze_ad_video`,
  `competitor_creative_research`, `ad_library_ad_deep_dive`,
  `creative_performance_review`, `account_health_check`), and summarized in the
  server's `instructions`, which a client receives before its first tool call.
  The directories can also be installed locally with
  `cp -r skills/* ~/.claude/skills/`.
- **Server-side video analysis with Gemini — `ads_analyze_video` plus per-tenant
  key management (137 → 141 tools).** For agents whose own model cannot ingest
  video at all: the server downloads the video through the existing hardened
  pipeline, sends it to Google Gemini with the user's own API key, and returns a
  structured analysis (hook with a 1-5 score and its reasoning, verbatim
  transcript, on-screen text, scene list, audio, format, branding, claims a
  reviewer might question, strengths, weaknesses, ideas to test, and a direct
  answer to an optional `focus` question). Own-account videos and Ad Library
  videos both work, one per call, with `card_index` to pick one from a carousel
  or DCO ad. The tool description points a video-capable client at
  `ads_get_video_media delivery=inline` first, since that is free, and states
  the cost (about USD 0.02 per ad against the user's own quota) and that the
  video is sent to Google. `ads_register_gemini_key`,
  `ads_get_gemini_key_status` and `ads_delete_gemini_key` mirror the Apify token
  tools, and the key can also be registered from `/auth/connections`.
  Small videos are embedded in the request and stored nowhere; larger ones go
  through the Files API and are deleted as soon as the analysis returns.
  Request and response shapes were verified against the wire types of the
  official `googleapis/js-genai` SDK.
- **Ad Library ads with their media — `ads_library_get_ad_details` (136 → 137 tools).**
  The compact projection of `ads_library_get_results` gains a `media` summary
  (display format, image and video counts, `has_video`, the CDN expiry decoded
  from the signed URLs) and the absolute `offset` of every item; the error
  records the actor pushes (`ADS_NOT_FOUND`) come back as `{ offset, error }`
  instead of empty rows. The new tool locates one ad in a dataset (by
  `hint_offset`, or an id-only scan cached per dataset — reading a dataset is
  free on Apify), normalizes the actor record (page, dates, platforms, copy per
  card with DCO/DPA template detection, images, videos, transparency blocks),
  attaches the images as inline blocks behind the Meta CDN host allowlist, and
  delivers the videos through the same pipeline as own-account media
  (`thumbnail` / `frames` / `url`) under the shared response budget.
  `ads_get_video_media` now resolves `dataset_id` + `ad_archive_id` as well, so
  a scraped video can be embedded inline for a video-capable model. Schema and
  fixtures come from real actor output (build 2.7.x): snake_case records,
  `video_hd_url` occasionally null with `video_sd_url` always present, and
  `{{product.*}}` placeholders at ad level for DCO/DPA.
- **Video analysis — `ads_get_video_media` (135 → 136 tools).** Any MCP agent
  can now analyze an ad video, not just its poster frame. The tool resolves a
  `video_id`, an `ad_id` or a `creative_id` (every video in the creative,
  capped by `max_videos`), downloads the file from Meta's CDN behind the
  existing SSRF guard plus a host allowlist, validates it with `ffprobe`
  before any decode, and delivers it in the mode the calling model can
  consume: `frames` (real keyframes as image blocks — a contact sheet by
  default, individual frames or an `audio/aac` track on request), `inline`
  (the MP4 embedded as an MCP `resource` blob for video-capable clients such
  as Gemini, transcoded to a compact rendition that fits `max_inline_bytes`),
  `url` (signed CDN links as `resource_link` blocks with their expiry) or
  `thumbnail`. Progress notifications are sent when the client supplies a
  `progressToken`; JSON metadata carries duration, dimensions, fps, audio
  presence, block indexes and the CDN expiry decoded from the `oe` parameter.
- **`ads_get_creative_media` gains `video_delivery`** (`thumbnail` by default,
  unchanged; `frames` appends keyframes; `url` appends signed links), and
  `ads_get_video_details` / `ads_get_ad_videos` now request `permalink_url`.
- **`/health` reports `ffmpeg: true|false`** once a probe has been
  conclusive, and omits the key until one has.
- `is_adset_budget_sharing_enabled` on `ads_update_campaign`. Meta documents
  turning budget sharing off on an existing campaign; turning it on for a
  running campaign is rejected (error 3858418).
- `FINANCIAL_PRODUCTS_SERVICES` and `ONLINE_GAMBLING_AND_GAMING` in
  `ads_create_campaign`'s `special_ad_categories`, matching Meta's current
  campaign reference.
- **A warning log when Meta auto-upgrades a call** (`X-Ad-Api-Version-Warning`),
  at most once an hour, as `meta_api_version_auto_upgraded`. Meta only sends
  the header once the requested version has been retired, so it is a reactive
  signal that the pin is overdue: by then, endpoints changed since that version
  already fail, and the auto-upgrade itself can be disabled in the app's
  Marketing API settings. The retirement dates in Meta's changelog index are
  the way to stay ahead of it. The log line carries the configured version and
  Meta's header text only.

### Changed

- **zod 3 → 4.** Eight `z.record` calls gain the key schema zod 4 requires,
  and one test that read zod 3's private internals to find an enum now reads
  the JSON Schema a client sees. Nothing else in the code changed and the
  full suite passes. Three runtime differences come with zod 4 itself, all
  tightenings: `.int()` rejects integers beyond ±2^53−1, which no Meta id or
  offset reaches; `z.number()` rejects ±Infinity, which JSON only produces
  from an overflowing literal such as `1e400`; and `.url()` strips
  surrounding whitespace and embedded tab, CR and LF, so a WhatsApp website
  or endpoint is sent trimmed. What clients see also changes, because the MCP SDK
  converts tool schemas with zod's own converter on zod 4 instead of
  `zod-to-json-schema`, and the two differ. Compared field by field across
  all 142 tools: `additionalProperties: false` disappears from 138 top-level
  schemas and 43 nested objects (four tools have no properties and never had
  it), which was a promise the runtime never kept, since `z.object` strips
  unknown keys rather than rejecting them in both majors. MCP allows the
  keyword to be omitted. The one place it mattered is OpenAI's strict
  function calling, which requires it on every object alongside every field
  being required; 102 tools have optional fields and never qualified, 4 take
  no parameters and never carried the keyword, and the 36 with every
  top-level field required did carry it and no longer do, an accepted
  change; 23
  `$ref`s to reused sub-schemas are inlined, which
  clients that do not resolve references can now read; the 12 free-form
  records gain `propertyNames: {type: string}`; integer fields gain
  safe-integer bounds; the email field gains a `pattern` next to its
  `format`; and `.passthrough()` objects say `additionalProperties: {}`
  rather than `true`, which mean the same. Serialized compactly, the
  `tools/list` payload shrinks by 1%.
- The server's version now comes from `package.json` rather than a constant
  that had already drifted (it reported 3.0.0 while the package was at 3.6.0).
- The image download loop moved out of `ads_get_creative_media` into
  `src/media/creative-images.ts`, and the auction-ranking reading into
  `src/tools/rankings.ts`, so the dossier and the existing tools share one
  implementation. `withDerivedEffectiveLinkUrl` is exported, and
  `VIDEO_INSIGHTS_FIELDS` and `RANKING_INSIGHTS_FIELDS` join the insights
  types.
- `skills/` is part of the published package and of the runtime image, with an
  explicit `.dockerignore` negation so the blanket `*.md` rule cannot swallow
  it. Verified by building the image and loading the skills from `dist/` inside
  it.


- `/auth/connections` and the OAuth consent page gained a Gemini section next to
  the Apify one, with the same rules: a password field, no disconnect button
  mid-OAuth, and a status read that degrades to "not connected" rather than
  taking down OAuth approval. `POST /auth/register-gemini-key` is rate-limited
  like its Apify counterpart, since each call reaches out to Google.
- The budgeted response-body reader moved out of the Apify client into
  `src/utils/bounded-body.ts`, and the single-line sanitizer for untrusted text
  out of the Ad Library renderer into `src/utils/single-line.ts`, so both
  outbound clients and both renderers share one implementation.
- **Runtime image and Cloud Run sizing.** The Docker image is pinned to
  `node:22-alpine3.24` and installs `ffmpeg`; the deploy runs with 2 GiB /
  2 vCPU, concurrency 40 and a size-limited in-memory `/tmp` volume. CI and
  the deploy preflight install `ffmpeg` so the keyframe integration tests run
  for real (`FFMPEG_REQUIRED=1`).
- **Tenant resolution shared.** The fail-closed rule that picked the Apify
  token bucket now lives in `src/auth/tenant.ts` and also scopes the video
  rate limiter; behaviour for `ads_library_*` is unchanged.
- **Shared HTTP download plumbing.** DNS pinning, redirect re-validation and
  header parsing moved from `safe-download.ts` into `src/utils/safe-http.ts`
  so the image and video downloaders enforce the same policy.
- **Every Meta call now targets Graph API / Marketing API v26.0.** The version
  was set in six places that had drifted apart: `MetaApiClient` defaulted to
  v25.0, the OAuth flow to v22.0, and the deploy workflow, `docker-compose.yml`,
  the README and `.env.example` all pinned `META_API_VERSION=v22.0`. The env var
  wins over the code default, so **the Cloud Run service was configured to
  request v22.0** while a local `npm run dev` without the variable used v25.0.
  - The Marketing API follows its own, shorter schedule: only v24.0 (until
    October 6, 2026), v25.0 and v26.0 are still available. Meta answers a call
    on a retired version by upgrading it when the endpoint has not changed
    since, and by rejecting it when it has. Endpoints changed in v23.0 and
    v24.0 include reading and creating campaigns, creating and updating ad
    sets, creating creatives, delivery estimates, targeting search and custom
    audiences.
  - The version now lives only in `src/meta/api-version.ts`, and both the
    client and the OAuth flow read it. `META_API_VERSION` still overrides it.
    A blank value falls back to the default, and a value that is not of the
    form `v26.0` stops the server at startup instead of being spliced into
    request URLs.
  - The pins stay explicit and move to v26.0. The deploy action merges env
    vars into the Cloud Run service, so dropping the pin would have silently
    kept v22.0. `tests/meta/api-version.test.ts` fails if any pin drifts from
    the code default again.
- **`ads_create_campaign` sends `is_adset_budget_sharing_enabled` for
  ad-set-budget campaigns.** Since v24.0 Meta rejects a campaign without a
  campaign budget unless the flag is explicit (error 4834011). The tool sends
  `false` unless the caller passes `true`, which keeps each ad set spending
  its own budget, and says in its response which setting was applied.
  Campaigns with their own `daily_budget` or `lifetime_budget` are unchanged,
  and asking for budget sharing on one is refused before calling Meta, which
  would reject it (error 4834002).
- **`ads_clone_ad_set_bundle` adapts the copied targeting to the API version
  in use.** Ad sets created on older versions can carry placements Meta has
  removed and no Advantage+ audience flag, so copying them verbatim fails.
  - Facebook `video_feeds` (removed in v24.0), Instagram `explore` (v26.0) and
    Messenger `story` (v26.0) are dropped from the copy when the client calls
    a version that no longer has them. When one was the only position of a
    selected platform, the positions field and the platform are removed as
    Meta recommends. The clone is refused before anything is created when the
    source does not set `publisher_platforms`, since dropping the field would
    open every position of that platform, or when no placement is left.
  - A missing `targeting_automation.advantage_audience` becomes an explicit
    `0` on v23.0 and later, where Meta requires the flag for new ad sets with
    non-default targeting. The source's effective setting cannot be inferred
    once the relaxation fields are stripped, so the copy takes the choice that
    never spends beyond the copied targeting.
  - Each adjustment is reported in `warnings`, on dry runs as well.
- **Rebuilt creatives keep their destination setting and WhatsApp identity.**
  Since v26.0 a new creative without `destination_spec` defaults to Website
  and Shop for advertisers with a shop, and a creative meant for WhatsApp
  Status gets no WhatsApp identity unless the caller sends
  `wamo_whatsapp_identity_spec`. `ads_update_ad_url_tags` and the creative
  swap in `ads_clone_ad_set_bundle` now read both fields from the source
  creative and send them with the replacement when Meta reports them, so an
  explicit Website and Shop opt-out or a WhatsApp Status identity survives a
  UTM or copy change. When Meta reports no setting, the replacement sends none
  and follows Meta's default for eligible creatives.
- **Ad set tool schemas describe the v24.0–v26.0 placement and audience rules.**
  `video_feeds`, `explore` and Messenger `story` are no longer offered, and
  `targeting_automation.advantage_audience` explains when Meta requires an
  explicit value, including the v26.0 extension to Housing, Employment and
  Financial Products and Services campaigns.

- **Dependencies.** `@modelcontextprotocol/sdk` 1.29 → 1.30 (#108), which
  adds the 10 MiB stdio read buffer, validates the request `Content-Type` by
  parsed media type and sends SSE keep-alive frames. `@google-cloud/firestore`
  8.5 → 9.1 (#149), whose only breaking change is the Node 22 requirement.
  `jose` 6.1 → 6.2 (#148). Dev toolchain: vitest 4 → 5, plus eslint, tsx,
  typescript-eslint and `@types/node` (#154). GitHub Actions pinned to new
  SHAs (#104). The Dependabot config now ignores majors of typescript and
  `@types/node` until their blockers move (#145), and majors of the Node
  image, which move by hand together with `engines` (#156).

### Upgrade notes

Moving from v22.0 to v26.0 also brings Meta-side behaviour changes that need
no code here but change delivery:

- **v23.0**: new ad sets with default or relaxed targeting opt in to Advantage+
  audience unless `advantage_audience` is set to `0`.
- **v24.0**: daily budget flexibility rises from 25% to 75%, so a single day
  can spend up to 75% over the daily budget while the weekly total stays
  capped at seven times the daily budget. With ad set budget sharing on, both
  caps grow by the shared amount: an ad set can spend up to
  (daily budget + 20%) × 1.75 in a day and (daily budget + 20%) × 7 in a week.
- **v26.0**: eligible new creatives default to
  `destination_spec.destination_type = WEBSITE_AND_SHOP` when the advertiser
  has a shop. `ads_create_ad_creative` and `ads_bulk_create_video_ads` do not
  expose the `WEBSITE_AND_SHOP_OPT_OUT` opt-out yet.
- **v26.0**: a creative meant for WhatsApp Status needs an explicit
  `wamo_whatsapp_identity_spec`, which the creation tools do not expose yet.
  Until they do, create those creatives in Ads Manager or with a direct Graph
  call; the rebuild tools carry the identity over once it exists.
- Marketing API versions ship about every four months, and Meta only
  guarantees a replaced version for 90 days, so `DEFAULT_META_API_VERSION`
  needs regular bumps, planned from the retirement dates Meta publishes. The
  new warning log only confirms that a bump is already overdue.

### Fixed

- **The ffmpeg startup probe may run for 30 seconds without holding the port
  for more than 10.** On a fresh Cloud Run node the first run of ffmpeg has
  taken more than 10 seconds even with startup CPU, where a warm node answers
  in about one; the likeliest reason is that Cloud Run streams image layers
  on demand and the first execution waits for the layer that holds ffmpeg,
  which is probable but not confirmed. Such an instance reported no `ffmpeg`
  in `/health` until the first video call re-probed. The probe started at
  boot now gets 30 seconds, but `listen` waits for it at most 10, as before:
  with `min-instances` at zero a request is waiting on that cold start, so
  the port is not held longer. If the probe is still running, it finishes in
  the background and settles the answer when it completes; if it ends
  inconclusively, killed at its timeout, the first video call re-probes after
  the cooldown, as before. On-demand probes keep 10 seconds.
- **Tool results over stdio are budgeted to fit the MCP SDK's read buffer.**
  SDK 1.30.0 reads stdio through a buffer that, by default, closes the
  transport on any single message above 10 MiB, and it does so on the client
  side, where the tool result arrives. `inline` video advertised up to 50 MiB
  over stdio; a client on that SDK could never have received it, the
  connection would have dropped instead. The raw media budget for a whole
  result over stdio is now 6 MiB, shared by everything in the message: the
  inline video or the frames, the poster, and the images that
  `ads_get_creative_media`, `ads_library_get_ad_details` and
  `ads_get_ad_dossier` attach before the video part, which used to size their
  images against the 30 MiB HTTP budget regardless of transport. Base64 adds
  a third on top, and the JSON block shares the message too, which is what
  the remaining room is for. HTTP budgets are unchanged, 20 MiB per inline
  video and 30 MiB per result. Clients that raise the SDK's `maxBufferSize`
  gain nothing here yet; the budget is a constant, not a setting.
- **Cloud Run deploys are pinned to the second generation execution
  environment.** Three consecutive deploys failed with nothing to go on: the
  revision was created, instances started in a loop, no instance ever opened
  port 3000, and the container produced not a single line of output, so Cloud
  Run could only report the generic 240s startup-probe timeout. The three
  merged changes are not what broke it: the last known good image, byte for
  byte the one already serving production, failed to start the same way when
  redeployed, while every other service in the same project and region kept
  starting instances normally. What separates a revision that starts from one
  that does not is the execution environment, which the workflow had left
  unset for the platform to choose: with the in-memory `/tmp` volume mounted
  and the choice left open the container never starts, and pinned to `gen2`
  the same image answers `/health` in under half a second and reports ffmpeg
  available. The root cause of the change in the unset behaviour on
  2026-09-17 is not established here; only the fix is. Dropping the volume
  would also let the container start, but the volume is what turns an
  oversize scratch write into `ENOMEM` instead of a dead instance, so it
  stays.
- **A startup probe of ffmpeg that timed out was remembered as "no ffmpeg" for
  the life of the instance.** The probe was spawned just before the port
  opened and never awaited, so on Cloud Run it ran on into the window after
  startup where the CPU is throttled until a request arrives; `ffmpeg -version`
  then took longer than its own 10 second timeout, the failure was cached, and
  every later `isAvailable()` call, in requests that did have CPU, returned the
  stale answer. `/health` reported `ffmpeg: false` on a revision with ffmpeg
  installed, and frame extraction, inline compaction and the Gemini compact
  path all fell back for as long as that instance lived. The probe is now
  awaited before `listen`, where startup CPU boost still applies, and a probe
  that was killed on timeout or refused a resource is not remembered: after a
  five second cooldown the next use asks again, so an instance under pressure
  spawns at most one probe per cooldown rather than one per call. Only a
  definitive answer is kept: the version string, a spawn error that says the
  binary is not there or not executable, or a non-zero exit from the binary
  itself. While no probe has been conclusive, `/health` omits the `ffmpeg`
  key rather than guess, and the tools say the probe did not complete rather
  than that ffmpeg is not installed.

### Security

- The advertiser's own ad copy in the dossier is delimited as untrusted content
  and flattened to single lines with hyphen runs neutralized, like the Ad
  Library card and the Gemini analysis before it. The brief is cut by whole
  lines and never inside that fence, and the JSON block is reduced field by
  field rather than truncated as a string, which would leave it unparseable.
- The skill loader reads only `skills/<name>/SKILL.md` and
  `skills/<name>/references/*.md`, with both path segments pattern-checked, a
  256 KB per-file cap, a file-count cap, and `lstat` rather than `stat` so a
  symlink planted in `skills/` cannot read anything else the process can.
  Resources are registered under static URIs, so there is no path variable for
  a traversal to hide in.
- Prompt arguments are flattened to one bounded line before they reach the
  message text, so an argument cannot forge structure around itself.


- Gemini keys are stored encrypted at rest (AES-256-GCM) under their own AAD
  namespace (`gemini_key:<user>:default`), so a ciphertext cannot be relocated
  between users or between the Meta, Apify and Gemini collections. A decryption
  failure propagates instead of degrading to "no key", which would fall through
  to a shared fallback credential. `GEMINI_API_KEY` is honoured only in
  single-tenant mode, and tenant resolution fails closed for an unidentified
  multi-tenant caller.
- The key travels only in the `x-goog-api-key` header, never in a URL, and is
  not sent to the resumable-upload session URL, which is validated (https, exact
  host, no port or credentials, `/upload/` path) before any video byte leaves.
  File names and model ids are pattern-checked before interpolation, redirects
  are refused, every response is read under a byte budget, and key-shaped
  strings are scrubbed from errors and logs (`gemini_api_key`, `gemini_key`,
  `x-goog-api-key` added to the logger's redaction paths).
- A billable `generateContent` failure is never retried; the only retry is a
  single schema-less attempt after a 400 that names the schema field, which
  Google does not bill. A per-tenant hourly cap is refunded when the work ended
  before the key was used and kept once it was.
- Everything the model writes is delimited as untrusted content and flattened to
  single lines with hyphen runs neutralized, so an analysis cannot forge the
  fence that marks it as untrusted. The JSON block is reduced field by field
  rather than truncated as a string, which would leave it unparseable.
- `.gitleaks.toml` and the custom scanner gained rules for the `AQ.` key prefix
  Google AI Studio has used since September 2026 and for any `GEMINI_API_KEY=`
  assignment; the `AIza` rule alone would not have seen either.
- Video downloads stream to a per-video scratch directory (never
  `Buffer.concat`), tear rejected responses down instead of draining them,
  honour the caller's abort signal from DNS onwards, and never echo scratch
  paths or credentials in errors or metadata.
- `ffmpeg` / `ffprobe` run through `execFile` (no shell) with
  `-protocol_whitelist file`, a container format whitelist, native
  `max_streams` / `max_pixels` / `max_alloc` caps, a single thread, output
  size caps (`-fs`) and `SIGKILL` on timeout; every scale filter bounds both
  output dimensions.
- Resource limits: at most two video jobs per instance with a bounded queue
  (aborted callers leave the queue immediately), a per-tenant hourly limit
  with expired tenants purged, a per-call time budget under the Cloud Run
  request timeout with partial results, and a 30 MB response byte budget shared
  between images and video media. The HTTP transport now registers its
  disconnect cleanup before handling a request so a dropped client aborts
  in-flight tool handlers.
- The image downloader also tears down rejected responses and accepts an
  abort signal, so thumbnail fetches cancel with the job.

### Migration

Client-side notes, including what a client sees differently in the
published schemas and what to do about the stdio budget, are in
[docs/migration-v4.md](docs/migration-v4.md). The `register*Tools(server)`
exports and every tool name are unchanged.

### Compatibility

- Node 22.13+.
- `@modelcontextprotocol/sdk` ^1.30.
- HTTP and stdio transports unchanged.
- Per-user OAuth, System User token registry, server-to-server API key,
  Firestore-backed encrypted token store: all unchanged.
- ffmpeg optional; the Docker image includes it.

## [3.6.0] — 2026-09-15

### Added

- **Apify tokens are now managed from the web UI**, not only by invoking
  `ads_library_register_apify_token`. Asking an assistant to register a
  credential was the only path, which is a poor fit for something users expect
  to find next to their Meta tokens.
  - A new **`GET /auth/connections`** page, authenticated and available at any
    time, lists the stored Meta tokens (with the ability to switch the active
    one) and the Apify connection, and allows registering, replacing or
    disconnecting the Apify token. This is the page that solves rotation — the
    consent screen only renders inside an OAuth flow, so it could never be
    reached again after the initial approval.
  - An **Apify section on the consent page** for first-time connection, plus a
    link to the connections page. It deliberately offers no disconnect button:
    dropping a credential mid-OAuth is not what the user came for.
  - Apify stays optional. A test asserts the Approve button's disabled state
    depends only on the Meta token count across all four
    `tokens × apify` combinations.
- Extracted the duplicated, unexported `escapeHtml` into `src/utils/html.ts`
  (it existed byte-identically in `src/transport/http.ts` and
  `src/transport/auth-routes.ts`) and the consent page's inline CSS into
  `src/transport/html-pages.ts`, now shared by both surfaces.
- **Meta Ad Library scraping via Apify — 8 new `ads_library_*` tools (127 → 135).**
  Competitor ad research against the *public* Meta Ad Library, which the Graph
  API does not expose. Backed by the
  [curious_coder/facebook-ads-library-scraper](https://apify.com/curious_coder/facebook-ads-library-scraper)
  actor.
  - `ads_library_scrape` starts an asynchronous run from either a keyword
    search (country / active status / ad type / search type) or a
    facebook.com Ad Library or page URL, and returns a `run_id` +
    `dataset_id`.
  - `ads_library_get_run_status`, `ads_library_get_results` (paginated, with a
    compact per-ad projection and a `raw` escape hatch), `ads_library_abort_run`
    and `ads_library_list_runs` cover the rest of the run lifecycle.
  - `ads_library_register_apify_token`, `ads_library_get_apify_token_status`
    and `ads_library_delete_apify_token` manage the credential.
- **Per-tenant Apify tokens, encrypted at rest** (`src/store/apify-token-repo.ts`).
  Each user registers their own token; it is validated against the Apify API
  *before* being persisted, then stored AES-256-GCM-encrypted in
  `users/{fbUserId}/apify_tokens/default`. The GCM AAD is namespaced
  `apify_token:{fbUserId}:default`, so a ciphertext cannot be relocated between
  users or between the `meta_tokens` and `apify_tokens` collections.
- **`src/apify/client.ts`** — a dedicated Apify API client with the same
  timeout / retry / typed-error guarantees as `metaApiClient`. The token travels
  in an `Authorization: Bearer` header (never a query param, so it cannot leak
  into a logged URL), the base URL is not env-overridable, run/dataset ids are
  validated before path interpolation, and every error message is scrubbed both
  of `apify_api_*` substrings and of the exact token value in play.

### Fixed

- **`ads_library_scrape` no longer breaks Gemini clients.** Its `period`
  parameter was published as `enum ["", "last24h", ...]`, and Gemini's
  `function_declarations` reject any empty enum member, so every request
  failed for a Gemini client with this server attached. The schema now
  publishes only the four real values with the field optional, and the Apify
  actor's `""` no-filter sentinel is applied when the actor input is built.
  An explicit `""` from an existing client is still accepted. A new test
  connects a real MCP client and asserts no published tool enum is empty or
  contains `""` or `null` (#125).

### Security

- **`npm audit` clean again — 0 vulnerabilities.** Advisories published after
  v3.5.0 had reappeared (5 moderate, 2 high). The ones reaching the production
  runtime are `hono` 4.13.8 via the MCP SDK (path traversal in `toSSG()`,
  unbounded nesting in `parseBody()`, query parsing past the URL fragment),
  `fast-uri` 3.1.8 via ajv (SSRF and host confusion in URI normalization) and
  `qs` 6.16.0 via express (array-limit bypass, DoS). Dev-only: `vitest`
  4.1.11, `nanoid` 3.3.19 and `@humanfs/node` 0.16.8. Lockfile only, no
  direct dependency range changed, no major bumps (#136).
  Note for maintainers: `npm audit fix` crashes on npm 10.9.x with
  `Cannot read properties of null (reading 'edgesOut')` (npm/cli#9787) while
  resolving vitest 4.1.11's circular optional peers. Use npm 11 or later to
  regenerate the lockfile; `npm ci` on npm 10 is unaffected.
- `POST /auth/register-apify-token` validates the token against Apify's
  `/v2/users/me` **before** persisting it, and never echoes it: the error page
  shows a fixed string while the upstream message goes to the logs, and only
  `hashToken()` / `hashPii()` are logged. `renderConnectionsPage` is tested to
  never contain the stored token.
- Input is rejected for control characters and inner whitespace, not just
  length. The token is interpolated into an `Authorization: Bearer` header, so
  an embedded CR/LF is a header-injection attempt and must fail before the
  outbound call rather than relying on the HTTP client to notice.
- Token validation uses a dedicated `ApifyApiClient({ timeout: 10_000,
  maxRetries: 0 })` rather than the shared singleton (30s / 3 retries), so a
  stalling `api.apify.com` cannot hold a user-facing request for minutes.
- `/auth/register-apify-token` is rate limited (10 per 15 min) — the first
  limiter on `/auth/*`, justified because each POST makes an outbound call to a
  third party, which uncapped turns the endpoint into a credential-validation
  oracle. It is registered **before** `mountAuthRoutes`, since Express matches
  in registration order and a limiter added after the route would never run;
  verified against the booted server (10× 401 then 429).
- `validateMetaAuthReturn` was hard-wired to `/authorize`, so login could not
  return to a non-OAuth page. Widened by an exact-string allowlist containing
  only `/auth/connections`, compared **before** any URL parsing.
- **Closed an open redirect** that the first version of that widening exposed.
  `safeReturnTo` rejected `//` but not `/\`, and the WHATWG URL parser (like
  browsers) normalizes `\` to `/` for special schemes — so
  `/\evil.example/auth/connections` kept the expected `pathname` while
  resolving to an external host, and a `pathname`-only check accepted it. The
  pre-existing `/authorize` branch was accidentally shielded by its
  client_id/redirect_uri requirement; the new standalone path had no such
  shield. Fixed in three layers: reject backslashes outright, compare
  standalone paths as exact strings before parsing, and pin `parsed.origin` to
  the fixed base instead of trusting `pathname`. Covered by nine bypass tests.
- The new POSTs validate request provenance via Fetch Metadata
  (`Sec-Fetch-Site`), falling back to `Origin` compared against the origin the
  browser actually contacted. `SameSite=Lax` blocks a cross-*site* POST, but
  same-site is not same-origin — on a custom domain a sibling subdomain could
  otherwise swap a tenant's Apify token for the attacker's and silently
  redirect their scrapes. Requests carrying neither header are not browser form
  posts and fall through to the session check.
- A failure reading the Apify status no longer takes down the consent page.
  Apify is an optional add-on, but `/authorize` had made `getStatus()` a hard
  dependency inside `Promise.all`, so a storage hiccup would have blocked OAuth
  approval entirely. It now degrades to "not connected" and logs.
- `safeReturnTo` takes an optional fallback typed as a literal union, so a
  caller can never route a user to an attacker-supplied destination.
- `/auth/connections` sends a stricter CSP than the consent page (no external
  `redirectOrigin`, plus `base-uri 'none'` and `frame-ancestors 'none'`), and
  both pages now send `Cache-Control: no-store` and `Vary: Cookie` — the
  consent page previously cached despite rendering token and Business Manager
  names.
- `fbUserId` on every new handler comes only from the session cookie, never
  from the request body. Verified that the web route and the MCP tools resolve
  the same tenant id, so the UI cannot write a token the tools would not read.
- **The global gitleaks allowlist was silently far wider than written.**
  gitleaks joins allowlist patterns into a single alternation (an optimization
  promoted in 8.28.0), so an inline `(?i)` leaks into every pattern that follows
  it. In practice that turned `test[-_]?(token|secret|key)` case-insensitive,
  which exempted any credential containing an uppercase `TEST` — a real-looking
  `apify_api_TESTtoken…` value passed a local scan while CI (then on 8.24.3)
  correctly flagged it. The two spellings of `placeholder` in the list were the
  tell that case-sensitivity had always been the intent.
  This affects **`paths` as well as `regexes`**: a probe confirmed that a
  leading `(?i)` entry made a following case-sensitive path pattern exclude
  `SECRETS.NOTES` too, so a file that should have been scanned was skipped
  outright. Every pattern in both lists now declares `(?i)` or `(?-i)`
  explicitly, so they mean the same thing on every gitleaks version regardless
  of ordering.
- The local guard scripts now **fail closed** around their own preconditions.
  Previously a missing gitleaks binary was a `[SKIP]`, and a missing, empty or
  non-semver `.gitleaks-version` silently disabled the version check — a green
  run that reads as evidence the scan happened. All five states (no pin, empty
  pin, non-semver pin, unreadable `gitleaks version`, binary absent) are now
  blocking failures.
- Pinned the scanner version in [.gitleaks-version](.gitleaks-version), read by
  both [ci.yml](.github/workflows/ci.yml) and the local guard scripts, which
  now fail on a mismatch instead of letting a green local run imply a green CI.
  The workflow validates the pin is a bare semver before it reaches
  `GITHUB_ENV`, since it is checked-out repo content.
- Added `tests/gitleaks-config.test.ts` to keep the case-flag convention from
  regressing: it asserts every allowlist regex declares its flag, that the
  fixture exemptions stay case-sensitive, and that the `apify-api-token` rule
  still matches a production-shaped token while ignoring the repo's short
  fixtures.
- **Tenant isolation fails closed.** In multi-tenant mode (Meta OAuth app
  configured, HTTP transport) a caller with no OAuth identity — an API-key
  request, or any flow that loses `fbUserId` — is refused rather than bucketed
  into a shared credential. The `APIFY_TOKEN` environment variable is honoured
  **only** in single-tenant mode (stdio, or no Meta app configured); it is
  never used as a cross-tenant fallback, so one advertiser's scrapes can never
  be billed to the operator's Apify account.
- A stored token that fails authenticated decryption (GCM tag mismatch from a
  relocated document, key rotation, or tampering) raises an error instead of
  being reported as "no token" — degrading an integrity failure to absence
  would have fallen through to a fallback credential.
- Cost reporting derives from `chargedEventCounts` when Apify has not yet
  settled `usageTotalUsd`. Verified against the live API: a run that has just
  flipped to `SUCCEEDED` still reports `usageTotalUsd: 0` for a few seconds,
  so a caller polling to completion would have been told a billable scrape was
  free. The charged event count is accurate immediately.
- Cost containment: each scrape sends Apify a hard `maxTotalChargeUsd` cap
  derived from the requested `count`. The actor bills PAY_PER_EVENT
  ($0.00075/ad), so Apify aborts the run server-side rather than billing past
  the cap; `count` is additionally capped at 2,000 per call. Note this bounds
  each *run*, not a tenant's aggregate spend — a client can still start many
  runs, each against its own Apify account and credit.
- `POST` is never retried automatically, which removes the client-side
  duplicate-run path. It does **not** make double billing impossible: Apify can
  accept a run and lose the response, so a timed-out start is *indeterminate*.
  The timeout message says so and points at `ads_library_list_runs` to check
  before retrying.
- `ads_library_scrape` accepts URLs only over https on an exact `facebook.com`
  host allowlist, and additionally rejects embedded credentials, non-default
  ports, and Facebook's outbound redirect endpoints (`/l.php` and friends) that
  would send the scraper off-site.
- Added an `apify-api-token` rule to [.gitleaks.toml](.gitleaks.toml).
- Pino now has a `redact` configuration (previously none at all) covering
  token- and authorization-shaped keys, as defense in depth behind the existing
  call-site hashing/masking convention.

## [3.5.0] — 2026-08-09

### Security

- **`npm audit` clean again — 0 vulnerabilities.** Advisories published after
  v3.4.1 had turned CI red on `main`: `ip-address` (SSRF / trust-boundary
  bypass via leading-zero octets, CIDR suffixes and IPv4-mapped IPv6),
  `fast-uri` (host confusion via backslash authority introducer),
  `brace-expansion` (DoS) and `hono` (ReDoS in CORS middleware). Resolved by
  patch-level bumps of six transitive packages; lockfile only, no direct
  dependency changed.

### Added

- **`ads_get_creative_media` — see the actual creative, not just its URLs.**
  Given an `ad_id` or `creative_id`, the tool walks the creative
  (`image_url`/`image_hash`, `object_story_spec` link/video data including
  carousel `child_attachments`, `asset_feed_spec` assets, and the upsized
  `thumbnail_url` fallback for boosted posts), resolves image hashes through a
  single batched `adimages` lookup, downloads each image through the existing
  SSRF-hardened downloader, and returns them as inline MCP `image` content
  blocks that a multimodal model (Claude, Gemini) can analyze directly. Videos
  cannot be embedded as MCP blocks, so each one returns its best thumbnail as
  an image block plus a signed short-lived `source` URL (and a ready-to-use
  download hint) in the JSON metadata for external download or video-capable
  models. Response size is bounded by a `max_images` cap (default 5), an 8 MB
  per-image limit and a 20 MB cumulative budget; `image_size: "small"` swaps in
  128px previews to save context. Partial failures (an expired CDN URL, an
  unresolvable hash) are reported per-asset without failing the call.

- **`ads_update_ad_url_tags` — edit the UTM parameters of live ads (1-50 per
  call).** Meta creatives are immutable (`POST /{creative_id}` only accepts
  `name` / `status` / `adlabels`), so the tool clones each ad's creative with
  the new `url_tags` and repoints the ad at the clone. Every strategy
  re-references the source wholesale rather than rebuilding it field by field
  — the existing Facebook post (`object_story_id`, preserving likes and
  comments), the creative spec (`object_story_spec`), or the Instagram post
  (`source_instagram_media_id`) — so media, copy, destination link and CTA
  survive even when they are not readable back individually. Fields that live
  beside the story rather than inside it are carried explicitly: `link_url`,
  `degrees_of_freedom_spec` (dropping it would silently reset an ad's
  Advantage+ creative enhancements), `adlabels`, and the rebuilt
  `call_to_action` for Instagram creatives, which store their CTA on the
  creative itself. Ads sharing a creative mint a single replacement. Ads whose `url_tags` already match are
  skipped, which makes re-running a batch safe; dynamic (`asset_feed_spec`)
  creatives are reported as skipped rather than silently altered. `url_tags:
  ""` removes tracking parameters, a leading `?` is stripped, and `dry_run:
  true` previews the plan without writing. The response reports every ad as
  updated / skipped / failed and warns that updated ads re-enter Meta review.
- **`url_tags` in creative reads** — added to the creative default fields (so
  `ads_get_creative_details` and `ads_get_ad_creatives` surface UTMs) and
  `ads_get_ad_creatives` gained an optional `fields` param, making an
  account-wide UTM audit a single call.

- **`ads_bulk_create_video_ads`** — turns a list of public video URLs into ads
  in a single call: uploads each video, waits for Meta to finish processing,
  picks the preferred thumbnail automatically, builds the creative and creates
  the ad in the target ad set. Ads are created `PAUSED` by default.

  A video rejected by Meta does not abort the batch — each item reports its own
  outcome and failure stage — but an account-wide error (expired token, rate
  limit, abuse signal) stops it immediately instead of retrying under a block.
  The call aims to finish within 180s, well under the Cloud Run request timeout,
  so it returns the IDs it already created; videos left over come back marked
  `skipped`, making a re-run of just those safe from paid duplicates. As with
  `ads_run_report_and_wait`, the budget is best-effort — an individual Graph
  request can still overrun it.

### Fixed

- **`effective_link_url` no longer fails with Meta error #100.** The field is
  derived by this server, not stored by Meta, but it appears in responses — so
  clients echoed it back in `fields` and every such call died with
  `-32602 Invalid parameter: (#100) Tried accessing nonexisting field`. Both
  creative read tools now accept it as a virtual field: it is stripped from the
  Graph request, its sources (`link_url`, `object_story_spec`,
  `asset_feed_spec`) are requested instead, and the derived value is still
  returned.
- **Empty updates no longer report a false success.** `ads_update_ad_creative`
  called without `name`, and `ads_update_ad` called with no updatable field,
  used to POST an empty body to Meta and answer "updated successfully". Both
  now fail with an explanation — the creative error points at
  `ads_update_ad_url_tags` for UTM changes.

## [3.4.1] — 2026-07-22

### Security

- **`npm audit` clean — 0 vulnerabilities.** Bumped `tsx` 4.21.0 → 4.23.1 and
  `vitest` 4.1.8 → 4.1.10, pulling `esbuild` 0.28.1 (GHSA-g7r4-m6w7-qqqr,
  dev-only arbitrary file read via dev server on Windows). Added an npm
  override forcing `@hono/node-server` ^2.0.5 (resolved 2.0.11) inside
  `@modelcontextprotocol/sdk`, fixing GHSA-frvp-7c67-39w9 (path traversal in
  `serve-static` on Windows via encoded backslash). Full test suite, build,
  and an HTTP-transport smoke test pass with the override.

### Changed

- **`ads_create_ad_set` budget guidance** (#97, thanks @gitlares) — the tool
  description no longer claims a budget is required. It now documents that
  budget belongs at exactly one level: omit both ad-set budget fields when the
  parent campaign owns a daily/lifetime budget (CBO), and only pass them for
  ABO campaigns. `daily_budget` / `lifetime_budget` field descriptions updated
  to match, plus a regression test proving omitted budget fields are not sent
  to Meta.

## [3.4.0] — 2026-07-22

### Added

- **WhatsApp Business management (27 new `whatsapp_*` tools)** — full
  management surface for the WhatsApp Business Platform via the Graph API,
  in four new modules:
  - `src/tools/whatsapp.ts` (8): WABA discovery
    (`whatsapp_get_business_accounts`, with automatic `/me/businesses`
    scanning), phone number list/details, register/deregister,
    request/verify ownership code, and business profile get/update.
  - `src/tools/whatsapp-templates.ts` (6): message template CRUD
    (`whatsapp_get_templates`, `whatsapp_create_template`,
    `whatsapp_update_template`, `whatsapp_delete_template`) plus WABA
    analytics (`whatsapp_get_analytics` — MESSAGING / CONVERSATION /
    PRICING families) and `whatsapp_get_template_analytics`.
  - `src/tools/whatsapp-flows.ts` (6): WhatsApp Flows lifecycle — list,
    create (inline Flow JSON), update (metadata + Flow JSON asset upload),
    publish, deprecate (irreversible), delete (drafts only).
  - `src/tools/whatsapp-config.ts` (7): QR code deep links
    (`message_qrdls` CRUD) and webhook subscription management
    (`subscribed_apps` get/subscribe/unsubscribe). No webhook receiver
    endpoint is included — events go to the Meta App's configured webhook.
  Message sending and media upload are intentionally out of scope.
  The OAuth flow now requests the `whatsapp_business_management` scope;
  previously issued tokens must re-authorize before `whatsapp_*` tools work.
  `MetaApiClient.delete()` now accepts optional query params (needed for
  template deletion by name). Tool count: 97 → 124.
- **`ads_get_invoices`** — read a business's invoices via Meta's
  `GET /{business_id}/business_invoices` edge, returning each invoice's amount,
  billing period, payment status, and PDF download link (`download_uri` /
  `cdn_download_uri`). Accepts a `business_id` directly or an `account_id`
  (the owning business is resolved automatically), plus optional `start_date` /
  `end_date` / `invoice_id` / `type` (`CM` / `DM` / `INV` / `PRO_FORMA`)
  filters. Annotated `READ`. Meta only exposes invoices for businesses on a
  credit line / monthly invoicing and requires a token with the
  `FINANCE_EDITOR` or `FINANCE_ANALYST` role; the tool returns a clear
  explanatory message for card-billed accounts that have no API invoices.
  Tool count: 96 → 97.

## [3.2.1] — 2026-06-04

Documentation and validation hardening. No new tools — tool count stays at 96.

### Fixed

- **`ads_delete_custom_audience`** now validates Meta's response and throws
  when the API does not confirm `success: true`, instead of reporting a
  false positive on any 2xx body. Brings it in line with the
  `ads_share_custom_audience` / `ads_unshare_custom_audience` write tools
  added in 3.2.0.
- **Docs**: README tool count corrected from `93` to `96` (TOC, comparison
  table, features list, and the `Tools` section heading) to match the actual
  registered tool count and the 3.2.0 CHANGELOG.

### Changed

- **Dev dependencies**: lockfile refreshed (vitest/vite toolchain moved from
  `rollup` to `rolldown` bindings). No runtime/production dependency changes.

Cross-account custom-audience sharing. Meta exposes audience sharing via
`POST /{audience_id}/adaccounts` but the MCP had no tool for it — agencies
managing several ad accounts under one Business Manager could create an
audience but not lend it to a sibling account without leaving the assistant.

### Added

- **`ads_share_custom_audience`** — share a custom audience with one or more
  ad accounts in the same Business Manager (`POST /{audience_id}/adaccounts`).
  Accepts numeric or `act_`-prefixed account ids and an optional
  `relationship_type`. Annotated `UPDATE` (idempotent: re-sharing is a no-op).
- **`ads_unshare_custom_audience`** — revoke a share from one or more accounts
  (`DELETE /{audience_id}/adaccounts`). The audience itself is untouched.
- **`ads_get_audience_shared_accounts`** — list the accounts that currently
  have shared access to an audience (`GET /{audience_id}/adaccounts`).

Both write tools validate Meta's response and fail loudly when the API does
not confirm `success: true`, instead of reporting a false positive on any
2xx body. Tool count: 93 → 96.

## [3.1.0] — 2026-05-13

Audit-driven fixes for `ads_clone_ad_set_bundle` after Meta API error
2500 surfaced a duplicate `destination_type` in the GET fields list.
Verified against Marketing API v25 docs and an independent code review.

### Fixed

- **v22 compat**: `instagram_actor_id` removed from
  `AdCreativeObjectStorySpec` (deprecated in v22.0 changelog). The bundle
  now reads `instagram_user_id` with a fallback for legacy creatives and
  always writes the new field. Also applied in `ads_create_ad_creative`.
- **Write safety**: `MetaApiClient` no longer retries `POST` to
  `/act_*/<collection>` paths on timeout/5xx/transient errors. Meta has no
  native idempotency on creates, so the prior retry behavior could mint
  duplicate ad sets/creatives/ads within a single tool invocation.
  `POST /<id>` (updates) and `DELETE` are unaffected.
- **Targeting roundtrip**: strip read-only fields
  (`targeting_relaxation_types`, `is_whatsapp_destination_ad`,
  `targeting_optimization`) returned by Meta on GET before sending the
  targeting back on POST.
- **Geo override**: `applyGeoOverride` now replaces `geo_locations`
  instead of merging. Previously a Chile-source with city targeting cloned
  to Colombia would inherit Chilean cities — Meta's docs recommend
  redefining `geo_locations` on country swaps.
- **Budget priority**: user-provided `target_ad_set.daily_budget` or
  `lifetime_budget` now wins over the source budget regardless of source
  shape. Previously a daily-budget override was silently dropped when the
  source had a lifetime budget.
- **Empty bundle**: throws before claiming idempotency when no source
  creatives are clonable, instead of creating an empty ad set.
- **`asset_feed_spec` order**: the unsupported-feed check now runs before
  the video/link checks, so dynamic creatives that also expose a
  `link_data` shape aren't silently cloned as static.
- **Hard-coded `WEBSITE` fallback** removed for `destination_type` —
  source value (or user override) is used, otherwise omitted.

### Changed

- **Idempotency cache**: moved from an in-process `Map` to a
  Firestore-backed store (`clone_bundle_operations` collection). Survives
  Cloud Run restarts and multi-instance deployments. Falls back to in-
  memory when Firestore env vars are not set.
- **Partial-failure tracking**: the store records created resources
  incrementally; if a step fails, the error surfaces the partial state
  (`ad_set=…, creatives=[…], ads=[…]`) and the run is marked `failed`.
  Retries with the same `idempotency_key` are rejected with the orphan
  list until the user cleans up.
- **Stale lock reclaim**: `in_progress` records older than 15 minutes
  (e.g. orphaned by a process crash between `claim` and `markFailed`) are
  taken over on retry instead of blocking forever.
- **CTA validation**: `creative_overrides.call_to_action_type` is now
  validated against the shared `ctaEnum` — typos are rejected at schema
  time instead of after creating the ad set.

### Added

- `target_ad_set.end_time` on `ads_clone_ad_set_bundle` (required when
  the user provides `lifetime_budget`).
- CBO support: bundle no longer requires source-level budget when the
  parent campaign uses Campaign Budget Optimization.

## [3.0.0] — 2026-05-06

### Why this release

On 2026-04-29 Meta launched its own remote MCP server at
`mcp.facebook.com/ads` with a curated naming convention (`ads_create_campaign`,
`ads_update_entity`, `ads_insights_*`) and supports ChatGPT, Claude, and
Perplexity natively.

This project's **agency multi-tenant** angle is unchanged — Meta's official MCP
is per-user OAuth and cannot operate across N client accounts on behalf of an
agency. v3.0.0 aligns the **vocabulary** so an agent that learned the official
MCP transfers seamlessly to ours, and adds the diagnostic / help / cross-account
tools the official server doesn't cover.

### Breaking changes

- **All tool names changed**: `meta_ads_*` → `ads_*`. Drop the `meta_` prefix.
- `adset` → `ad_set` (with underscore) in tool names *and* parameter names —
  matches Meta's official `ads_create_ad_set`, `ads_update_ad_set`, etc.
- `ads_get_pages` → `ads_get_pages_for_business` (matches official MCP).
- `meta_ads_get_account_insights` **removed** — replaced by
  `ads_insights_advertiser_context` (richer first-message account snapshot).
- All write tools now declare `ToolAnnotations`
  (`destructiveHint` / `idempotentHint`) and prefix descriptions with
  `⚠️ Modifies live ads/account data.`. MCP clients (Claude, ChatGPT) display
  these as confirmation hints.
- Internal tool registration migrated from the deprecated
  `server.tool(...)` API to `server.registerTool(name, config, handler)`.
  No user-facing change; downstream code that imported `register*Tools` is
  unaffected.

### Added

**Generic entity helpers** (mirror Meta's official vocabulary):
- `ads_get_ad_entities` — generic getter, dispatches by `entity_type`
  (campaign / ad_set / ad).
- `ads_update_entity` — generic updater.
- `ads_activate_entity` — toggle status (ACTIVE / PAUSED / ARCHIVED).

**Insight views** (semantic, agent-friendly):
- `ads_insights_performance_trend` — daily/weekly/monthly KPI series.
- `ads_insights_anomaly_signal` — auto-compare last N days vs prior.
- `ads_insights_auction_ranking_benchmarks` — quality / engagement / conversion
  rankings (ad-level only).
- `ads_insights_industry_benchmark` — observed CTR/CPC/CPM vs curated industry
  medians.
- `ads_insights_advertiser_context` — first-message account snapshot
  (replaces `ads_get_account_insights`).

**Diagnostic tools** (parity with Meta's official MCP):
- `ads_get_opportunity_score` — Meta's 0-100 health/improvement signal.
- `ads_get_dataset_quality` — synthetic pixel/dataset health overview
  (last fired, match rate, AAM status, health score 0-100).
- `ads_get_errors` — current account errors / disapproved ads / restrictions.

**Help center search**:
- `ads_get_help_article` — full-text search across a curated set of
  Meta Business Help Center articles (rejection reasons, pixel setup,
  audience requirements, billing, learning phase, ad rankings, AEM, etc.).

**Agency macros** (cross-account — not in the official MCP):
- `ads_diagnose_underperformance` — bundles anomaly detection,
  ranking lookup, pixel quality, account issues, returns a unified report.
- `ads_portfolio_summary` — parallel aggregation across N ad accounts.

### Tool-name migration table

#### Renamed (drop `meta_` prefix)

| v2 | v3 |
| --- | --- |
| `meta_ads_get_ad_accounts` | `ads_get_ad_accounts` |
| `meta_ads_get_account_info` | `ads_get_account_info` |
| `meta_ads_get_pages` | `ads_get_pages_for_business` |
| `meta_ads_get_campaigns` | `ads_get_campaigns` |
| `meta_ads_get_campaign_details` | `ads_get_campaign_details` |
| `meta_ads_create_campaign` | `ads_create_campaign` |
| `meta_ads_update_campaign` | `ads_update_campaign` |
| `meta_ads_delete_campaign` | `ads_delete_campaign` |
| `meta_ads_get_adsets` | `ads_get_ad_sets` |
| `meta_ads_get_adset_details` | `ads_get_ad_set_details` |
| `meta_ads_clone_adset_bundle` | `ads_clone_ad_set_bundle` |
| `meta_ads_create_adset` | `ads_create_ad_set` |
| `meta_ads_update_adset` | `ads_update_ad_set` |
| `meta_ads_delete_adset` | `ads_delete_ad_set` |
| `meta_ads_get_ads` | `ads_get_ads` |
| `meta_ads_get_ad_details` | `ads_get_ad_details` |
| `meta_ads_create_ad` | `ads_create_ad` |
| `meta_ads_update_ad` | `ads_update_ad` |
| `meta_ads_delete_ad` | `ads_delete_ad` |
| `meta_ads_get_ad_creatives` | `ads_get_ad_creatives` |
| `meta_ads_get_creative_details` | `ads_get_creative_details` |
| `meta_ads_create_ad_creative` | `ads_create_ad_creative` |
| `meta_ads_update_ad_creative` | `ads_update_ad_creative` |
| `meta_ads_upload_ad_image` | `ads_upload_ad_image` |
| `meta_ads_get_ad_images` | `ads_get_ad_images` |
| `meta_ads_get_ad_videos` | `ads_get_ad_videos` |
| `meta_ads_get_video_details` | `ads_get_video_details` |
| `meta_ads_upload_ad_video` | `ads_upload_ad_video` |
| `meta_ads_get_insights` | `ads_get_insights` |
| `meta_ads_search_interests` | `ads_search_interests` |
| `meta_ads_get_interest_suggestions` | `ads_get_interest_suggestions` |
| `meta_ads_search_behaviors` | `ads_search_behaviors` |
| `meta_ads_search_demographics` | `ads_search_demographics` |
| `meta_ads_search_geo_locations` | `ads_search_geo_locations` |
| `meta_ads_estimate_audience_size` | `ads_estimate_audience_size` |
| `meta_ads_get_targeting_description` | `ads_get_targeting_description` |
| `meta_ads_create_budget_schedule` | `ads_create_budget_schedule` |
| `meta_ads_get_lead_forms` | `ads_get_lead_forms` |
| `meta_ads_get_leads` | `ads_get_leads` |
| `meta_ads_get_ad_leads` | `ads_get_ad_leads` |
| `meta_ads_create_lead_form` | `ads_create_lead_form` |
| `meta_ads_get_custom_audiences` | `ads_get_custom_audiences` |
| `meta_ads_get_audience_details` | `ads_get_audience_details` |
| `meta_ads_create_custom_audience` | `ads_create_custom_audience` |
| `meta_ads_create_lookalike_audience` | `ads_create_lookalike_audience` |
| `meta_ads_delete_custom_audience` | `ads_delete_custom_audience` |
| `meta_ads_generate_preview` | `ads_generate_preview` |
| `meta_ads_get_ad_preview` | `ads_get_ad_preview` |
| `meta_ads_get_pixels` | `ads_get_pixels` |
| `meta_ads_get_pixel_details` | `ads_get_pixel_details` |
| `meta_ads_get_pixel_events` | `ads_get_pixel_events` |
| `meta_ads_get_custom_conversions` | `ads_get_custom_conversions` |
| `meta_ads_create_custom_conversion` | `ads_create_custom_conversion` |
| `meta_ads_get_ad_comments` | `ads_get_ad_comments` |
| `meta_ads_hide_comment` | `ads_hide_comment` |
| `meta_ads_reply_comment` | `ads_reply_comment` |
| `meta_ads_delete_comment` | `ads_delete_comment` |
| `meta_ads_get_ad_rules` | `ads_get_ad_rules` |
| `meta_ads_get_rule_details` | `ads_get_rule_details` |
| `meta_ads_create_ad_rule` | `ads_create_ad_rule` |
| `meta_ads_update_ad_rule` | `ads_update_ad_rule` |
| `meta_ads_delete_ad_rule` | `ads_delete_ad_rule` |
| `meta_ads_get_ad_studies` | `ads_get_ad_studies` |
| `meta_ads_get_study_details` | `ads_get_study_details` |
| `meta_ads_create_ad_study` | `ads_create_ad_study` |
| `meta_ads_create_async_report` | `ads_create_async_report` |
| `meta_ads_get_report_status` | `ads_get_report_status` |
| `meta_ads_get_report_results` | `ads_get_report_results` |
| `meta_ads_run_report_and_wait` | `ads_run_report_and_wait` |
| `meta_ads_get_billing_info` | `ads_get_billing_info` |
| `meta_ads_get_spend_limit` | `ads_get_spend_limit` |
| `meta_ads_update_spend_cap` | `ads_update_spend_cap` |
| `meta_ads_rate_status` | `ads_rate_status` |
| `meta_ads_get_instagram_account` | `ads_get_instagram_account` |
| `meta_ads_get_instagram_media` | `ads_get_instagram_media` |
| `meta_ads_list_tokens` | `ads_list_tokens` |
| `meta_ads_set_active_token` | `ads_set_active_token` |
| `meta_ads_register_token` | `ads_register_token` |
| `meta_ads_delete_token` | `ads_delete_token` |

#### Removed

| v2 | Replacement |
| --- | --- |
| `meta_ads_get_account_insights` | `ads_insights_advertiser_context` |

#### Added in v3

| Tool | Category |
| --- | --- |
| `ads_get_ad_entities` | Generic helper |
| `ads_update_entity` | Generic helper |
| `ads_activate_entity` | Generic helper |
| `ads_insights_performance_trend` | Insight view |
| `ads_insights_anomaly_signal` | Insight view |
| `ads_insights_auction_ranking_benchmarks` | Insight view |
| `ads_insights_industry_benchmark` | Insight view |
| `ads_insights_advertiser_context` | Insight view |
| `ads_get_opportunity_score` | Diagnostic |
| `ads_get_dataset_quality` | Diagnostic |
| `ads_get_errors` | Diagnostic |
| `ads_get_help_article` | Help search |
| `ads_diagnose_underperformance` | Agency macro |
| `ads_portfolio_summary` | Agency macro |

### Migration

For client-side updates, see [docs/migration-v3.md](docs/migration-v3.md).

The internal API of `register*Tools(server)` exporters is unchanged, so anyone
embedding this server programmatically only needs to update tool names that
their callers reference.

### Compatibility

- Node 20+ (unchanged)
- `@modelcontextprotocol/sdk` ^1.29
- Same auth model: per-user Meta OAuth + System User token registry, server-to-server
  with API key, encrypted-at-rest token storage in Firestore.
- Same transports: HTTP and stdio.

---

## [2.0.2] — Prior to 2026-05-06

See git history. v2.x ships 80 tools under the `meta_ads_*` prefix.
