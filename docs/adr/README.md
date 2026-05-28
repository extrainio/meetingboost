# Architecture Decision Records

This directory captures the architectural and process decisions that shape MeetingBoost. An ADR is a short, dated, immutable record: what we chose, what we considered, and why.

## When to write one

Write an ADR for decisions that are:

- **Hard or expensive to reverse** — runtime choices, primary frameworks, persistence shape, public IPC contracts, security posture.
- **Cross-cutting** — touches more than one module or affects how new code gets written.
- **Non-obvious** — the reasoning isn't in the code or PR description; future contributors would otherwise wonder "why this way?"

Don't write one for choices a code review and a PR description already cover (renaming a variable, picking a fixture, polishing CSS). The bar is "I would want to find this in six months."

## Naming and format

- File name: `NNNN-kebab-case-title.md`, where `NNNN` is a zero-padded sequence number (`0001`, `0002`, …). Numbers are assigned at PR time and never reused, even when an ADR is superseded.
- Format: see [`template.md`](./template.md). Lightly adapted from [MADR](https://adr.github.io/madr/).
- One decision per file. If a decision splits, write a follow-up ADR and link to it.

## Status lifecycle

Every ADR carries a status:

- **Proposed** — under discussion, not yet enacted. Lives on a branch.
- **Accepted** — merged. The team has committed to this decision.
- **Superseded by NNNN** — a later ADR replaces this one. The old file stays; status header points at the successor. **Never delete an ADR.**
- **Deprecated** — no longer relevant (e.g., the feature was removed entirely). Keep the file.

Status changes happen via a new PR that edits only the status header. The body of an accepted ADR is immutable — if you'd change the reasoning, write a successor.

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-runtime-and-architecture.md) | Stay on Electron; tactical main.ts split; defer Tauri spike to post-v1 | Accepted |
