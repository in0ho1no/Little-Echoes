# Little Echoes

Little Echoes is an OpenAI Build Week project exploring a calm way to capture a
child's first words and turn them into illustrated diary entries. The repository
is currently at **Phase 0 (requirements and repository baseline)**. It contains
the specification and initial directory scaffolding only; no product feature,
runnable demo, or setup procedure is available yet.

## Build Week provenance

The baseline boundary is commit
[`faba8a0fef600bcb971e4df717e53b326ab748e7`](../../commit/faba8a0fef600bcb971e4df717e53b326ab748e7).
That commit and earlier work predate Little Echoes development. Work after that
commit is Little Echoes development for OpenAI Build Week.

| Category | Scope |
| --- | --- |
| Pre-existing reference | VoiceInteractionGadget had already validated Atom VoiceS3R, USB connectivity, and an OpenAI API voice-conversation prototype. It is reference material only. |
| Built during OpenAI Build Week | At Phase 0, only the Little Echoes requirements and repository baseline. This row will list the PC reference client, audio ring buffer, Cloudflare backend and Workflows, web application, transcription, word dictionary, and illustrated diary experience only as each feature is implemented and verified. |
| Optional target | Atom VoiceS3R wireless support, only if it is completed and verified during Build Week. |

The `reference/` directory is not part of Little Echoes runtime code. Little
Echoes must build, test, run, and be distributed without that directory; it is
not imported, included, or accessed at runtime.

Security, privacy, bounded cost, and user-experience decisions are
human-directed. Codex is being used to accelerate specification work,
implementation, review, and automated testing. Build Week claims in this README
will be updated only after the corresponding work is implemented and verified.

## Privacy and data handling

This demo must use no real children's data. When the planned product flow is
implemented, it will send:

- selected audio directly to the Audio Transcriptions API for transcription;
- transcript text and any parent-supplied context to the Responses API for
  word-candidate analysis;
- confirmed transcript text, confirmed words, scene context, and parent notes
  to the Responses API for diary-text generation; and
- approved diary content to the Image Generations API for illustration.

OpenAI API data is not used to train OpenAI models by default; however,
applicable abuse-monitoring logs may retain customer content for up to 30 days.
This is not a zero-retention guarantee. The project will not opt in to data
sharing.

The planned implementation will set `store: false` on every Responses API
request. This disables application-state storage for those responses but does
not disable applicable abuse-monitoring retention. The flow will not use OpenAI
background mode, Conversations, Assistants, Threads, Vector Stores, or the Files
API. Asynchronous orchestration will instead use Cloudflare Workflows and D1.
Audio will be submitted directly for transcription, and generated images
returned by the API will be stored in private application storage with
restricted access and defined deletion handling.

See [SPEC.md](SPEC.md) for the current requirements, security controls, and
acceptance criteria. See [tasks.md](tasks.md) for development phases, validation,
and review status.
