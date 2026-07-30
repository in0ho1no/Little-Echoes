# Little Echoes

Little Echoes captures a child's first words and turns approved recordings into
illustrated diary entries and a word dictionary. The repository contains the PC
reference client, Cloudflare backend and web application, transcription and word
extraction, and diary text and image generation.

## Repository boundaries

Product code lives under `main/`. If the legacy `reference/` directory is
present, it is optional technical reference material for Atom VoiceS3R and an
older voice-conversation prototype. Little Echoes does not import, include, or
access it at runtime and must build, test, run, and be distributed without it.

## Privacy and data handling

Test and demo environments must use no real children's data. The implemented
flow sends:

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

The implementation sets `store: false` on every Responses API request. This
disables application-state storage for those responses but does not disable
applicable abuse-monitoring retention. The flow does not use OpenAI
background mode, Conversations, Assistants, Threads, Vector Stores, or the Files
API. Asynchronous orchestration uses Cloudflare Workflows and D1. Audio is
submitted directly for transcription, and generated images returned by the API
are stored in private application storage with restricted access and defined
deletion handling.

See [SPEC.md](SPEC.md) for the current requirements, security controls, and
acceptance criteria. See [tasks.md](tasks.md) for development phases, validation,
and review status.
