---
name: little-echoes-phase
description: >-
  Little Echoesプロジェクトの各Phaseを実行・管理する。
  「Phase Nを実施してください」と依頼されたとき、Phase進捗の更新、
  SPEC.mdとtasks.mdの分離・同期、実装-レビュー-テストのループを
  回すときは、明示されなくても必ずこのスキルを使うこと。
---

# Little Echoes Phase

Read `AGENTS.md`, `SPEC.md`, and `tasks.md` before acting. `SPEC.md` defines normative product requirements; `tasks.md` defines phase execution, validation, and review work.

## Execute a phase

1. Locate the requested phase and its entry gates in `tasks.md`.
2. Verify prerequisites. Request direction only for a material product decision, new dependency, configuration/workflow change, or external credential.
3. State a short plan and implement in coherent, reviewable increments.
4. Run the smallest relevant automated checks.
5. Apply the default review loop: Terra implementation, Sol independent review, then Fable5 only when available. Fix accepted findings and rerun affected checks. Never claim an unavailable review was completed.
6. Update `tasks.md` with completion evidence and remaining gates. Update `SPEC.md` before code if requirements changed.

## Preserve document boundaries

- Put requirements, architecture, API/data contracts, security/privacy/cost rules, acceptance conditions, and decision records in `SPEC.md`.
- Put phase tasks, status, test execution plans, demo/submission work, review loops, blockers, and tool catalogues in `tasks.md`.
- Report conflicting normative and historical requirements instead of choosing silently.

## Review selection

- Use the existing Python Quality/Review agents for Python code.
- Use the `Little Echoes Architecture Review` agent (via the Agent tool) for cross-component changes.
- Add a skill or custom agent only for a repeated or fragile workflow; record its trigger and validation in `tasks.md`. Mirror tools across runtimes as applicable: `.agents/skills` (Codex), `.github/agents` (Copilot), `.claude/skills` and `.claude/agents` (Claude Code).
