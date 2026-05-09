# Board Pack Picker — Auto-Refresh on `packs-changed`

**Status:** Approved (design)
**Date:** 2026-05-09
**Author:** brainstormed with Claude Code (superpowers)

## Goal

When the pack list changes — new pack from YouTube Pack import, pack creation, deletion, or edit — the board's pack picker updates automatically without a manual reload.

## Non-goals

- Diffing picker options (atomic full swap is sufficient).
- Debouncing rapid `packs-changed` events (fires at most once per user action in v1).
- Handling a completely empty pack list (Classics is bundled; treated as impossible).
- Any change to `main.ts`, `preload.ts`, or any file other than `src/board.html`.

## Scope summary

| Dimension | Decision |
|---|---|
| Trigger | `packs-changed` IPC push event (already emitted by main on create/delete/edit/import) |
| Subscription point | `onPacksChanged` in `preload.ts` — already exposed, no preload change needed |
| Board change | Wrap existing `getPacks()` call into `loadPacks()`; call at init and on `packs-changed` |
| Active-pack-deleted fallback | Re-check active pack id after reload; fall back to `packs[0]` via `selectPack` |
| Files changed | `src/board.html` only |
| Effort | ~30 min |

## Architecture

The board currently calls `getPacks()` once inside `loadPackData()` at `DOMContentLoaded`. The refactor extracts a standalone `loadPacks()` async function that calls `getPacks()`, stores the result, then calls `applyPack(activePack?.id)` — preserving the current active pack where possible. Both the init sequence and the `onPacksChanged` subscription call `loadPacks()`.

Call sequence on a `packs-changed` event:

```
main.ts emits 'packs-changed'
  → preload bridges to renderer via onPacksChanged
    → loadPacks() called in board.html
      → getPacks() IPC call → returns updated pack array
        → if activePack.id still present → applyPack(activePack.id)   // no visual change
        → if activePack.id gone         → selectPack(packs[0].id)     // falls back to first pack
```

`selectPack` sends `select-pack` to main, which saves the new active pack in settings and re-emits `pack-selected` to the board, which calls `applyPack` via the existing `onPackSelected` handler — so the board UI and `activePack` state both update correctly.

## UI / behavior

The user observes: after completing a YouTube Pack import (or any pack create/delete/edit), the board's pack picker reflects the updated pack list immediately — no reload required. If the currently active pack was deleted, the board silently switches to the first available pack and shows that pack's name in the title label.

## Data flow

```
USER ACTION          MAIN                    BOARD
───────────          ────                    ─────
Create/delete pack → emit 'packs-changed' → loadPacks()
                                             → getPacks() IPC
                                             ← updated pack array
                                             → active id still in list?
                                               yes → applyPack(same id)
                                               no  → selectPack(packs[0].id)
                                                     → 'select-pack' IPC
                                                     ← 'pack-selected' event
                                                     → applyPack(packs[0].id)
```

## Error handling

| Scenario | Handling |
|---|---|
| Active pack deleted | Fall back to `packs[0]` via `selectPack(packs[0].id)` |
| `getPacks()` rejects | Silently swallowed — stale `packs` array remains in memory; board continues to function with pre-change state |
| `selectPack` fails (IPC error) | `selectPack` is fire-and-forget (send, not invoke) — no error surface; board will show stale label until next `pack-selected` event |
| Empty pack list | Documented as out of scope; Classics is always bundled |

## Testing

No Playwright spec is required for this change — the feature is a subscriber wiring, not a new UI surface. The existing `youtube-pack-import.spec.ts` e2e test (step 6: "assert new pack appears in Pack Selection") exercises the full chain and implicitly validates `packs-changed` → board update once that spec is implemented.

**Manual smoke check (run after implementation):**

1. Open the board. Note the current pack picker contents.
2. Open Sound Manager → YouTube Pack tab → paste `https://www.youtube.com/watch?v=aBr2kKAHN6M` (no-chapters control case) → confirm redirect to YouTube Clip tab (no pack created).
3. Open Pack Management → create a new pack named "Smoke Test Pack" → close Pack Management.
4. Observe the board: "Smoke Test Pack" must appear in the pack picker without any manual reload.
5. Delete "Smoke Test Pack" from Pack Management.
6. Observe the board: picker updates; active pack falls back to Classics (or whichever pack was first).

## File-level change list

- `src/board.html` — extract `loadPacks()`, add `onPacksChanged` subscription, add active-pack-deleted fallback.

No changes to: `main.ts`, `preload.ts`, any other renderer, tests, or config files.
