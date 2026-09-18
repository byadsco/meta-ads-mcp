# Migrating from v3 to v4

v4.0.0 is a major because two things that installers and clients depend on
changed: the minimum Node.js version, and the JSON Schemas the server
publishes for its tools. Nothing about tool names, parameters, authentication
or transports changed. Most deployments need to do nothing beyond running on
Node 22.13 or later.

## TL;DR

- **Node.js 22.13+** is required. `engines.node` moved from `>=20.10.0` to
  `>=22.13.0`; npm warns on older Node by default and refuses under
  `engine-strict`.
- **Tool names and parameters are unchanged.** Every `ads_*` and `whatsapp_*`
  tool accepts the same valid input it did in 3.6.0; the only inputs zod 4
  now rejects are ones no real call sends (see the runtime tightenings).
- **The published JSON Schemas changed** because the server now uses zod 4,
  whose converter emits different JSON Schema than the one zod 3 used. The
  differences are listed below; none of them changes what the server accepts.
- **Results over stdio are budgeted to 6 MiB of media** so they fit the MCP
  SDK's read buffer. HTTP is unchanged.
- **`@modelcontextprotocol/sdk` ^1.30** is the dependency; ^1.29 was.

## What changed

### Node.js 22.13 floor

Node 20 left support in April 2026. The production image had run Node 22
since the video pipeline landed, while CI still tested on Node 20, and the
mismatch was blocking dependency updates: `@google-cloud/firestore` 9 requires
Node 22 as its only breaking change, vitest 5 requires 22.12, and ESLint 10
requires 22.13 on the 22 line. The floor is 22.13 so that the runtime and the
contributor toolchain agree on one number. CI, the deploy preflight and the
publish workflow now run Node 22.

If you install the package with `engine-strict=true`, `npm install` fails on
Node 20 rather than warning. If you run the Docker image, nothing changes: it
was already `node:22`.

### Tool schemas as clients see them

The MCP SDK converts each tool's zod schema into the JSON Schema it publishes
in `tools/list`. On zod 3 it used `zod-to-json-schema`; on zod 4 it uses zod's
own converter, and the two do not produce the same output. All 142 schemas
were dumped through a real client on each version and compared field by
field. What a client sees differently:

| Difference | Where | What it means |
|---|---|---|
| `additionalProperties: false` is gone | 138 top-level schemas and 43 nested objects | This was a promise the runtime never kept: `z.object` strips unknown keys rather than rejecting them, in both zod majors. MCP allows the keyword to be omitted. |
| `$ref` to a reused sub-schema is now an inline copy | 23 places | Clients that do not resolve references, Gemini among them, can now read those fields. |
| `propertyNames: {type: "string"}` on free-form records | 12 fields such as `targeting`, `promoted_object`, `updates` | Valid JSON Schema; says the keys are strings, which they always were. |
| Safe-integer `minimum` and `maximum` on integer fields | 6 fields | Informative bounds. |
| `pattern` next to `format: email` | 1 field | Informative. |
| `.passthrough()` objects say `additionalProperties: {}` instead of `true` | 7 fields | Same meaning. |

Serialized compactly, the `tools/list` payload shrinks by about 1%.

**OpenAI strict function calling.** Strict mode requires
`additionalProperties: false` on every object together with every field being
required. 102 tools have optional fields and never qualified. 4 take no
parameters and never carried the keyword. The remaining 36 have every
top-level field required and did carry it, and no longer do; whether any of
them satisfied strict mode in full also depended on their nested objects and
free-form records, which strict mode needs closed too. No MCP client is known to expose
tools that way; if yours does, add `additionalProperties: false` on the client
side when building the function definition.

**Runtime tightenings from zod 4 itself**, none reachable by valid input:
`.int()` rejects integers beyond ±2^53−1, which no Meta id or offset reaches;
`z.number()` rejects ±Infinity, which JSON only produces from an overflowing
literal such as `1e400`; and `.url()` strips surrounding whitespace and
embedded tab, CR and LF, so a WhatsApp website or endpoint is sent trimmed.
Validation error messages changed wording; the field, the options and
`isError: true` are the same.

### Results over stdio

SDK 1.30.0 reads stdio through a buffer that, by default, closes the
transport on any single message above 10 MiB, and it does so on the client
side, where a tool result arrives. `ads_get_video_media` is new since 3.6.0,
and its first version advertised `inline` video up to 50 MiB over stdio; a
client on that SDK could never have received it.

The raw media budget for one result over stdio is now 6 MiB, shared by
everything in the message: the inline video or the frames, the poster, and the
images that `ads_get_creative_media`, `ads_library_get_ad_details` and
`ads_get_ad_dossier` attach before the video part. Base64 adds a third on top
and the JSON block shares the message too; that is what the remaining room is
for. HTTP is unchanged: 20 MiB per inline video and 30 MiB per result.

What to do about it:

- The budget is a property of the transport, not of the model. Any client
  connected over stdio (Claude Desktop, and Claude Code when it runs the
  server locally) should use `delivery=frames`, which returns a contact sheet
  of keyframes well under the budget. For those two clients the choice costs
  nothing, since the Claude models read images, not video.
- A `max_inline_bytes` above the transport's cap is clamped, not rejected;
  existing calls keep working and get a smaller file.
- Clients that raise the SDK's `maxBufferSize` gain nothing yet; the budget is
  a constant, not a setting.

### MCP SDK 1.30

The dependency moved from ^1.29 to ^1.30. Beyond the stdio buffer above, the
1.30.0 release notes list two server-side changes that clients can notice: the
Streamable HTTP transport validates the request `Content-Type` by parsed media
type rather than by substring, and it sends SSE keep-alive comment frames,
which helps long tool calls such as video extraction survive idle proxies.

### Self-hosting

- **Cloud Run must run on the second generation execution environment** when
  the in-memory `/tmp` volume is mounted. Left unset, the platform's choice
  stopped starting this container on 2026-09-17; the deploy workflow now pins
  `--execution-environment=gen2`. If you deploy with your own command, add
  that flag.
- **The image contains ffmpeg and `skills/`.** ffmpeg is what `frames`, the
  compact `inline` transcode and the compaction before a Gemini upload need.
  Without it, `frames` falls back to thumbnails with a warning, `inline` only
  delivers an original that already fits the cap, and `ads_analyze_video`
  cannot shrink a video that is over its upload limit. The skills are
  published as MCP resources at runtime.
- **`docker-compose.yml` mounts a tmpfs on `/tmp`** sized like the Cloud Run
  volume, and wires every `VIDEO_*` and `GEMINI_*` variable.
- **`/health` reports `ffmpeg: true|false`** once the startup probe has been
  conclusive, and omits the key until then.

### Server version

The server now reports the version from `package.json`. The constant it used
before had drifted: it reported 3.0.0 while the package was at 3.6.0.

## Compatibility

- Node 22.13+.
- `@modelcontextprotocol/sdk` ^1.30 (annotations + `registerTool` API).
- HTTP and stdio transports unchanged.
- Per-user OAuth, System User token registry, server-to-server API key,
  Firestore-backed encrypted token store: all unchanged.
- The `register*Tools(server)` exports remain stable, and no tool name changed.
- ffmpeg is optional; `delivery=frames`, the compact `inline` transcode and
  the pre-upload compaction for Gemini use it, and each degrades as described
  above without it.

## Why no compatibility shim for the schemas?

The old schemas claimed a strictness the server never enforced. The keyword
could be put back by post-processing the converter's output without touching
validation, but that would restore a claim the runtime does not honour, and
making the runtime honour it (`z.strictObject`) would reject unknown keys, a
behaviour change this release should not make. The schemas now describe what
the server does, and every call that worked on 3.6.0 works on 4.0.0.
