# Little Echoes — tasks.md

## Purpose and document boundary

This document is the executable project plan for Little Echoes. It records phase work, validation, review loops, submission preparation, and implementation gates. Product requirements, architecture, API contracts, security requirements, and acceptance criteria belong in [SPEC.md](SPEC.md).

When a request changes product behavior or a security, cost, or privacy rule, update `SPEC.md` before implementation. When it changes execution order, progress, validation, or review work, update this document.

## Phase command contract

The command `Phase Nを実施してください` starts the named phase using this workflow:

1. Read `AGENTS.md`, `SPEC.md`, this document, and the target phase's gates.
2. Check prerequisites and required user approvals. Ask only when a missing decision, new dependency, configuration change, or external credential would materially change the work.
3. Publish a short implementation plan, then complete the phase in small, reviewable changes.
4. Run relevant automated checks and preserve their results.
5. Run the Agentic review loop. Fix findings, then rerun affected checks.
6. Update this document with completion evidence and remaining gates. Update `SPEC.md` first if implementation revealed a specification change.

## Agentic review loop

Use this loop by default unless the user asks for a different process.

1. **Terra implementation** — implement the phase and run the smallest relevant automated tests.
2. **Sol independent review** — review the changed files against `SPEC.md`, security, bounded cost, user experience, and test coverage. Fix accepted findings, then rerun affected tests.
3. **Fable5 independent review** — run it when Fable5 is available in the active environment. Fix accepted findings and rerun affected tests. If it is unavailable, record the review as pending; never describe it as completed.

For Python changes, use the existing Python Quality/Review agents and the project quality commands in `AGENTS.md`. For cross-component security and architecture reviews, use `ag-little-echoes-architecture-review`.

## Phase status

| Phase | Status | Completion evidence / entry gate |
| --- | --- | --- |
| 0 — Baseline | Complete (submission artifact pending) | README added and reviewed; commit `61a122b`; preserve `/feedback` Session ID before submission |
| 1 — Contracts, security, data design | Not started | First align the Python source/test layout with `main/` or explicitly approve an alternative configuration |
| 1A — PC audio spike | Not started | Run in parallel with Phase 1 after its source layout is ready |
| 2 — Fixed-data vertical slice | Not started | Start with Workflows; use the narrowly defined fallback only under the conditions in `SPEC.md`. Custom domain and Cloudflare zone setup are user prerequisites |
| 3 — Approval, timestamps, dictionary | Not started | Phase 2 vertical slice validated |
| 4 — PC reference client | Not started | Phase 1A findings reflected in `SPEC.md` |
| 5 — OpenAI analysis | Not started | Mock vertical slice and cost controls validated |
| 6 — Diary and images | Not started | Approval flow validated |
| 7 — Security and submission hardening | Not started | Core flows complete |
| 8 — Atom VoiceS3R | Optional | PC, backend, and web flows stable |

## Phase 0 — Baseline

- [x] Confirm the public-repository policy.
- [x] Record the reference boundary and baseline commit in README.
- [x] State that `reference/` is not a runtime dependency.
- [x] State Pre-existing, Build Week, and optional scope in README.
- [x] Start the Codex work session.
- [ ] Preserve the required `/feedback` Session ID for submission.

## Phase 1 — Contracts, security, and data design

1. Create the threat model and data-flow artifact.
2. Synchronize state-transition tables/diagram with API schemas.
3. Define Recording, Transcript, WordCandidate, WordOccurrence, DiaryEntry, DiaryImage, DictionaryWord, ProcessingAttempt, AsyncJob, and UsageCounter.
4. Define OpenAPI or JSON Schema and common error schema.
5. Define D1 schema, uniqueness constraints, foreign keys, and transaction boundaries.
6. Define private R2 key layout plus retention/deletion policy.
7. Define management/device routes, Access JWT validation, and device-token authorization.
8. Define Workflow job identity, state, explicit retry settings, and D1 consistency rules.
9. Define idempotency, optimistic locking, per-item/daily cost caps, expiry, and emergency stop behavior.
10. Define `store: false`, no OpenAI background mode, and disclosure requirements.
11. Add sample JSON and API-contract tests.

### Phase 1 entry gate

`pyproject.toml` and the Python quality configuration currently target `src/`, while the repository scaffold is `main/src/`. Choose and approve one source layout before changing configuration or adding Python product code. The recommended direction is to keep product code under `main/` as specified in `SPEC.md`, then update all test/type/lint paths together in one reviewed change.

## Phase 1A — PC audio spike

Timebox this cloud-disconnected script to half a day. `sounddevice` 0.5.5 is already approved and locked.

1. Enumerate input devices.
2. Check 24 kHz input and the 48 kHz fallback.
3. Obtain `bytes` blocks from `RawInputStream` and implement a 10-second overwrite ring buffer.
4. Implement the 1.5-second hold rule, five-second post-roll, and 24 kHz/16-bit/mono WAV save.
5. Verify GUI/callback/worker separation plus disconnect detection and one automatic reopen attempt.

Completion criteria: no blocking callback I/O; repeatable WAV includes preceding audio; either direct 24 kHz or 48 kHz fallback works on the demo PC; spike findings are recorded in `SPEC.md` before product integration.

## Phase 2 — Fixed-data vertical slice

1. Create Worker, Workflows, D1, and R2 projects; pin a compatible Wrangler `compatibility_date`.
2. Separate management and device hosts, implement authorization, and validate Access JWT signature, `iss`, `aud`, and `exp`.
3. Upload fixed WAV input and store it in R2/D1.
4. Accept a mock Workflow with `202 Accepted`, poll state, and add mock transcription/word candidates.
5. Add authorized state lookup, audio playback, review queue/detail screens, and explicit state/error display.
6. Deduplicate both `client_capture_id` and `AsyncJob.id`.

Do not call OpenAI during this phase. Deterministically test authentication, state, UI, and data boundaries first.

### Phase 2 architecture gate

Start with Cloudflare Workflows. If its integration takes more than the timebox defined in `SPEC.md`, the documented `ctx.waitUntil()` plus `AsyncJob` fallback may be considered only after the required `SPEC.md` update and explicit recording of the recovery limitations. Do not silently select a fallback.

## Phase 3 — Approval, timestamps, and word dictionary

1. Save review drafts and edit timestamps with audit events.
2. Edit transcription/candidates and implement the approval transaction.
3. Create WordOccurrence records and recompute first-record and `NEW` values.
4. Implement dictionary and utterance history.
5. Test duplicate approval, concurrent approval, and late approval of older recordings.

## Phase 4 — PC reference-client integration

1. Productize the Phase 1A recorder and add the `tkinter` GUI, state/hold progress, and local spool.
2. Add automatic upload, process start, bounded retry, recovery controls, and sample-audio sending.
3. Repeat fixed-sample tests.

## Phase 5 — OpenAI analysis

1. Integrate transcription and structured word extraction.
2. Keep user data separate from instructions and validate JSON Schema.
3. Enforce `store: false`, disable OpenAI SDK retries, and do not use background mode.
4. Configure Workflow retries/terminal errors and `partial` fallback.
5. Record AsyncJob/ProcessingAttempt data and enforce all cost caps.
6. Verify the real API with fixed samples only after the mock vertical slice is secure and deterministic.

## Phase 6 — Diary and images

1. Generate diary text from approved data through a Workflow with `202 Accepted` plus polling.
2. Provide manual diary editing and explicit image generation.
3. Keep one active image, require replacement confirmation, and preserve it on failure.
4. Enforce lifetime and daily image limits.

## Phase 7 — Security and submission hardening

1. Check authentication, authorization, IDOR, CSRF, XSS, input limits, host routing, and Access JWT validation.
2. Check cost caps, bounded retries, expiry, and `DEMO_WRITE_ENABLED`.
3. Prepare fixed samples, automated core-flow tests, retention/deletion, recovery instructions, and a `reference/`-free demo.
4. Prepare judge instructions, demo-data initialization, protected/read-only demo environment, and video.
5. Add the required English OpenAI data-handling disclosure to README, Project Story, and Testing instructions.

## Phase 8 — Atom VoiceS3R (optional)

Begin only after PC, Cloudflare, and web flows are stable. Check audio memory; prototype the dedicated ring buffer; add Wi-Fi, HTTPS upload, fixed-audio upload, and hold action; display Unit HEX states; connect to the same API; verify a hardware demo.

## Automated verification plan

Run the smallest applicable subset after each change; run the complete relevant suite at each phase boundary. Python commands, once the source layout is aligned, are:

```powershell
uv run ruff check <target>
uv run ruff format --check <target>
uv run mypy <target>
uv run pyright <target>
uv run pytest
```

### Unit coverage

- Ring-buffer boundaries, concurrent snapshots, pre/post-roll, hold gesture, 48-to-24 kHz conversion, WAV validation, and spool retention.
- API validation, legal/illegal state transitions, idempotency, locking, timestamp rules, dictionary first-record recomputation, and deletion.
- Workflow job deduplication, explicit retry limits, terminal errors, `UPSTREAM_RESULT_UNKNOWN`, stale-job reconciliation, and no sensitive Workflow payload/state.
- Cost caps, expiry/kill switch, `store: false`, and no implicit SDK retry.

### Integration coverage

- Fixed WAV upload through `202 Accepted`, Workflow polling, and mock analysis.
- Device ownership, cross-household denial, authorized private-R2 playback, and management/device host separation.
- Approval through diary Workflow, image replacement behavior, concurrent image requests, and asynchronous deletion.
- Real transcription only after Phase 5 preconditions are met.

### Security and reproducibility coverage

- Reject invalid/expired device tokens, incorrect Access JWTs, IDOR, CSRF, unwanted CORS, invalid WAV/JSON, prompt injection, and XSS.
- Verify logs/responses/Workflow state do not expose tokens, audio, transcripts, notes, or R2 keys.
- Use three fixed samples: clear word, short sentence, and unclear speech.
- Verify normal/partial flows reach human editing and failures show a recovery action.

## Demo and submission tasks

**Submission deadline: 2026-07-21 17:00 PDT (2026-07-22 09:00 JST). Reconfirm on Devpost before final submission.** Category: Apps for Your Life. The demo video must be a public YouTube video under 3 minutes with spoken narration; Japanese dialogue is acceptable with English subtitles and English (or English TTS) narration.

Use only the developer's voice and synthetic/sample data. Show the PC ring buffer, record a sample phrase, show saving/upload/asynchronous processing, review it on mobile, approve with a scene, explicitly generate a diary/image, and show the dictionary. Add Atom only if actually complete and verified.

Before submission, recheck current Devpost requirements and prepare the English Project Story, public video, Codex/GPT-5.6 explanation, source access, OSS license, samples, judge instructions, and `/feedback` Session ID. Keep tokens out of public material. Include named-address Access instructions, token expiry, route separation, and the OpenAI data-handling disclosure required by `SPEC.md`.

### Pre-publication checklist

- [ ] No tokens or secrets anywhere in the public repository or public README.
- [ ] Cloudflare Access allows only the named addresses (no domain-wide rules); state this in Testing instructions and do not claim otherwise.
- [ ] Judge Testing instructions cover: allowed addresses, one-time PIN steps, device-token entry method and expiry, and a contact for other addresses (all in English).
- [ ] Demo write expiry (2026-09-01 00:00 JST at the latest) and `DEMO_WRITE_ENABLED` kill switch verified working.
- [ ] The OpenAI data-handling disclosure (data sent per feature, no training by default, up-to-30-day abuse-monitoring retention, `store: false` scope, no real children's data) appears in all three artifacts: README, Project Story, and Testing instructions, in English.
- [ ] `reference/`-free build, test, and demo verified; repository visibility decision executed (public, or private shared with `testing@devpost.com` and `build-week-event@openai.com`).

## Skills and custom agents

### Available project tools

- `little-echoes-phase`: project-local phase runner for Phase execution, `SPEC.md`/`tasks.md` synchronization, and the Agentic review loop.
- `ag-little-echoes-architecture-review`: read-only cross-component reviewer for requirements, security, bounded cost, user experience, and test gaps.
- Existing Python Quality/Review agents and `sk-python-quality`: use for Python implementation and static analysis.

Claude Code mirrors (deployed 2026-07-20): the phase runner is available as the `little-echoes-phase` skill at `.claude/skills/little-echoes-phase/SKILL.md`, and the reviewer as the `Little Echoes Architecture Review` agent at `.claude/agents/ag-little-echoes-architecture-review.agent.md`. The Codex-only `agents/openai.yaml` interface file has no Claude equivalent. When the source under `.agents/` or `.github/agents/` changes, update the `.claude/` mirror in the same commit.

### When to add more

Create a skill only for a repeated or fragile workflow. Create a custom agent only for a clearly distinct role.

| Trigger | Candidate | Do not create before |
| --- | --- | --- |
| Repeated Cloudflare deployment/configuration | Cloudflare deployment skill | Phase 2 has a real Wrangler configuration and approved deployment workflow |
| Repeated browser E2E checks | Browser E2E agent/skill | a stable web UI and reproducible test data exist |
| Atom hardware debugging becomes active | Atom hardware review agent | Phase 8 starts and device-specific failures recur |

New skills belong in `.agents/skills`, must use the skill-creator workflow, and must be validated. New custom agents belong in `.github/agents`, must have a narrow role, and must not duplicate an existing agent. Tools intended for Claude Code are mirrored under `.claude/skills` and `.claude/agents` in Claude Code format. Record the trigger, owner, and validation command here when a tool is introduced.

## Working rules

- Present a short plan before a major implementation.
- Keep changes small and commit by coherent feature.
- Do not weaken security, privacy, cost, or user-experience requirements for schedule reasons.
- Use proven libraries for external formats; obtain approval before adding a dependency.
- Never import, include, or access `reference/` at runtime.
- Keep the `/feedback` Session ID and record major implementation sessions for submission.

## Open implementation decisions

- Choose the final Python source/test layout before Phase 1 configuration work.
- Select `tkinter` and direct-24-kHz versus 48-kHz fallback after the Phase 1A spike.
- Finalize the D1 schema during Phase 1.
- Define public-demo data initialization during Phase 7.
- Decide Atom PSRAM placement only if Phase 8 begins.
- Choose an OSS license before submission; this is a legal/product decision and must not be assumed by an agent.
