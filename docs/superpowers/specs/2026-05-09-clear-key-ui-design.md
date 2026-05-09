# Discoverable Clear-Key UI in Pack Management

**Status:** Approved (design)
**Date:** 2026-05-09
**Author:** brainstormed with Claude Code (superpowers)

## Goal

Make unbinding a sound from a key visible and discoverable in Pack Management. The right-click shortcut on board pads stays as the power-user path; this adds an explicit affordance for first-time users who never right-click.

## Non-goals

- Hover-× on board pads (adds visual noise during the operator's mid-meeting surface — explicitly out of scope).
- Right-click context menu on board pads (already ships; unchanged).
- Undo / undo stack for unbind operations.
- Any changes to `main.ts`, `preload.ts`, or any file other than `src/packs.html`.

## Scope summary

| Dimension | Decision |
|---|---|
| UI surface | Pack Management (`src/packs.html`) — pack-detail key grid only |
| Trigger (mouse) | Hover over a bound key row → `×` icon appears; click → confirm → unbind |
| Trigger (keyboard) | Tab to a bound key tile; press Delete or Backspace → confirm → unbind |
| Empty rows | No `×` rendered; `empty` class rows are skipped entirely |
| IPC | Existing `packUnbindKey(packId, key)` — zero new IPC channels |
| Bundled-pack override | Toast says "Cleared Q from your Classics" (note "your") to surface the clone-on-write |
| Board refresh | Depends on Design #1 (board auto-refresh on `packs-changed`); ships independently |

## Architecture

No new IPC channels and no changes to `main.ts` or `preload.ts`. The existing `packUnbindKey(packId, key)` handler (exposed at `window.electronAPI.packUnbindKey`) already handles both user packs and bundled packs via clone-on-write. The renderer calls the same handler used by the board's right-click flow and reads the same `{ ok, changed?, error? }` response shape to branch the toast message. All changes are confined to `src/packs.html`: one CSS block for the hover/focus-visible affordance and one wiring block in `renderSounds()` / a delegated click handler.

## UI / Behavior

Each bound key tile in the pack-detail grid gains a small `×` button, hidden by default and revealed on hover or focus.

```
┌─────────────────────────────────┐
│  Q                              │  ← .mini-letter
│  ─────────────────────────────  │  ← .mini-div
│  AIR HORN              [×]      │  ← .mini-name + .row-clear-x (hover)
└─────────────────────────────────┘
```

The `×` sits inside `.mini-bottom`, right-aligned. It is invisible at rest (`opacity: 0`) and fades in on `.mini-key:hover` or when the tile has `:focus-visible`. Clicking `×` triggers:

```
confirm("Clear Q from Classics?")  →  packUnbindKey(packId, 'q')  →  toast  →  renderSounds()
```

Empty tiles (`.mini-key.empty`) do not receive the `×` button.

## Data Flow

```
USER                    RENDERER (packs.html)            IPC / MAIN
────                    ─────────────────────            ──────────

hover tile ──────────► .mini-key:hover → .row-clear-x opacity:1
[or Tab + focus-vis]   :focus-visible  → .row-clear-x opacity:1

click × ─────────────► confirm("Clear Q from Classics?")
                        [cancel] → nothing

                        [ok] ──────────────────────────► packUnbindKey(packId, 'q')
                                                         (clone-on-write if bundled)
                        ◄── { ok, changed?, error? } ──

                        ok + changed  → showToast("Cleared Q")
                        ok + !changed → showToast("Q was already empty")
                        bundled pack  → showToast("Cleared Q from your Classics")
                        error         → showToast(error || "Could not clear pad")
                        renderSounds()
```

## Error Handling

| Condition | Toast text |
|---|---|
| IPC returns `error` | `res.error` or `"Could not clear pad"` |
| `ok` but `changed` is false | `"Q was already empty"` |
| Bundled pack (clone-on-write) | `"Cleared Q from your Classics"` — "your" signals the override |
| User pack success | `"Cleared Q"` |

The bundled-pack detection uses `selected.origin !== 'user'` (already available on the `selected` object).

## Accessibility

- The `×` button carries `aria-label="Clear Q"` and `tabindex="0"` so screen readers announce it correctly.
- Keyboard users can Tab into a tile (tiles already receive `tabindex="0"` after this change) and press Delete or Backspace to trigger the same confirm → unbind flow.
- Focus ring uses `box-shadow: 0 0 0 2px var(--amber-ring)` matching the existing `search-inp:focus` pattern.
- The confirm dialog is a native `window.confirm()` — accessible by default.

## Testing

**Manual smoke (pre-commit):**
1. Open Pack Management → select Classics (bundled pack).
2. Hover a bound key — confirm `×` appears.
3. Click `×` → confirm → verify toast says "Cleared Q from your Classics".
4. Hover same key again — confirm `×` is gone (key now empty).
5. Tab to a bound key → press Delete → confirm dialog → cancel → verify nothing changes.
6. Keyboard unbind (press Delete → confirm OK) → verify toast + tile empties.

**Playwright e2e:** `tests/e2e/clear-key.spec.ts` — happy path:
1. Boot app → open Pack Management → select a user pack with at least one bound key.
2. Hover the first bound tile → assert `.row-clear-x` is visible.
3. Click `×` → handle confirm dialog (accept) → wait for toast → assert tile now shows empty state.

## File-Level Change List

- `src/packs.html` — CSS block for `.row-clear-x` hover/focus affordance; `×` button injected in bound-key branch of `renderSounds()`; delegated click + keydown handlers for confirm → IPC → toast flow.

No changes to: `main.ts`, `preload.ts`, `board.html`, `packs.json` schema, or any other file.
