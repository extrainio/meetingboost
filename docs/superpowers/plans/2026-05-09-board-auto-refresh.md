# Board Pack Picker — Auto-Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `onPacksChanged` preload event on the board so the pack picker auto-refreshes whenever the pack list changes (yt-pack import, pack create, delete, edit).

**Architecture:** Extract the existing `getPacks()` call in `board.html` into a standalone `loadPacks()` async function. Call it at init (current behavior) and inside an `onPacksChanged` subscription (new). After each reload, check whether the active pack id still exists; if not, fall back to `packs[0]` via `selectPack`.

**Tech Stack:** Vanilla JS inside `src/board.html`; Electron IPC via `window.electronAPI` (already bridged in `preload.ts`).

**Spec:** `docs/superpowers/specs/2026-05-09-board-auto-refresh-design.md`

---

## Task 1: Extract `loadPacks()` — refactor, no behavior change

**File:** `src/board.html`

The existing `loadPackData()` function fetches packs and stores them in the `packs` array but does **not** call `applyPack`. The `DOMContentLoaded` handler calls `loadPackData()` then `applyPack(savedPack)` separately. This task creates a new `loadPacks()` function that owns the full reload cycle: fetch + re-apply the currently active pack.

- [ ] **Step 1: Read the current init block to confirm the call order**

Locate lines 611–624 (`loadPackData`) and lines 899–918 (`DOMContentLoaded`) in `src/board.html` to confirm no other caller changes are needed.

- [ ] **Step 2: Add `loadPacks()` directly below `loadPackData()`**

Insert this function after the closing brace of `loadPackData()` (around line 624):

```js
// Fetch the latest pack list and re-apply the current active pack.
// Called at init and whenever 'packs-changed' fires.
async function loadPacks() {
  await loadPackData();
  if (activePack) {
    applyPack(activePack.id);
  }
}
```

- [ ] **Step 3: Replace the `loadPackData()` call in `DOMContentLoaded` with `loadPacks()`**

In the `DOMContentLoaded` handler, change:

```js
await loadPackData();
```

to:

```js
await loadPacks();
```

> **Note:** The `applyPack(savedPack || 'classics')` call later in the same handler still runs after `Promise.all` — that is correct. At init time `activePack` is `null`, so `loadPacks()` → `loadPackData()` only, and the explicit `applyPack(savedPack || 'classics')` below does the first render. On subsequent `packs-changed` calls `activePack` will be set, so `loadPacks()` will call `applyPack(activePack.id)` correctly.

- [ ] **Step 4: Verify app boots and the board renders the default pack**

```bash
npm run start
```

Open the board. Confirm Classics (or the last-saved pack) loads normally. Close the app.

---

## Task 2: Add `onPacksChanged` subscription

**File:** `src/board.html`

- [ ] **Step 1: Locate the `onPackSelected` handler**

Find this block (around line 807):

```js
window.electronAPI?.onPackSelected?.(async (_e, packId) => {
  await loadPackData();
  applyPack(packId);
});
```

- [ ] **Step 2: Add the `onPacksChanged` subscription immediately after `onPackSelected`**

```js
// Auto-refresh the pack picker whenever the pack list changes
// (new yt-pack import, pack create/delete/edit from Pack Management).
window.electronAPI?.onPacksChanged?.(() => {
  loadPacks();
});
```

> `loadPacks()` is called without `await` here — the subscription callback is synchronous; the async work runs in the background. This matches the pattern used by `onRecordingsChanged` already in the file.

- [ ] **Step 3: Verify the subscription wires up correctly**

```bash
npm run start
```

Open Sound Manager → Pack Management → create a new pack named "Smoke Test Pack". Without closing or reloading the board, observe the pack picker. The new pack must appear. Delete "Smoke Test Pack" — it must disappear from the picker.

---

## Task 3: Handle the "active pack deleted" edge case

**File:** `src/board.html`

When the active pack is deleted, `packs-changed` fires and `loadPacks()` is called. After `loadPackData()`, `activePack.id` may no longer exist in the updated `packs` array. The current `applyPack` fallback (`packs.find(p => p.id === packId) || packs[0]`) would silently switch to `packs[0]` locally — but `main.ts` still thinks the old pack is active in settings, and the board label would show the deleted pack name.

The correct fix: after reload, check explicitly and call `selectPack` so main saves the new selection.

- [ ] **Step 1: Update `loadPacks()` to include the fallback check**

Replace the `loadPacks()` function body from Task 1 with:

```js
async function loadPacks() {
  await loadPackData();
  if (!activePack) return;

  const stillExists = packs.some(p => p.id === activePack.id);
  if (stillExists) {
    applyPack(activePack.id);
  } else if (packs.length > 0) {
    // Active pack was deleted — fall back to the first available pack.
    // selectPack sends 'select-pack' to main which persists the choice
    // and re-emits 'pack-selected', which calls applyPack via onPackSelected.
    window.electronAPI?.selectPack?.(packs[0].id);
  }
}
```

- [ ] **Step 2: Confirm `applyPack` is NOT called redundantly on the fallback path**

Because `selectPack` → `select-pack` → `pack-selected` → `onPackSelected` → `loadPackData` + `applyPack`, calling `applyPack` directly here would double-render. The `else if` branch intentionally omits a direct `applyPack` call.

- [ ] **Step 3: Manual smoke test — deleted-pack fallback**

```bash
npm run start
```

1. Open Pack Management, note the active pack (e.g., Classics).
2. Create a new pack "Temp Pack" and select it on the board — confirm "Temp Pack" is shown as active.
3. Delete "Temp Pack" from Pack Management.
4. Observe the board: it must switch to Classics (or the first available pack) without any manual action. The pack label in the board header must update.

---

## Task 4: Manual smoke test via yt-pack import flow + commit

This task verifies the full end-to-end path: `library-create-pack-from-clips` → `packs-changed` → board auto-refresh.

- [ ] **Step 1: Run the full yt-pack import smoke test**

```
1. Open the board.
2. Open Sound Manager → YouTube Pack tab.
3. Paste: https://www.youtube.com/watch?v=aBr2kKAHN6M
   Expected: "No chapters detected" → redirect to YouTube Clip tab.
   (This is the no-chapters control case — no pack is created.)
4. For the chapters path: a stable chaptered CC0 URL is TBD
   (same open question as the yt-pack import spec — resolve before writing
   the Playwright e2e spec for youtube-pack-import.spec.ts).
   When available: paste URL → Detect → review candidates → Create Pack →
   observe pack appears in board picker without reload.
```

> The Playwright e2e test `tests/e2e/youtube-pack-import.spec.ts` (planned in the yt-pack import plan, step 6) will be the definitive automated verification once a stable chaptered URL is selected.

- [ ] **Step 2: Run TypeScript type check**

```bash
npx tsc --noEmit
```

Expected: no errors. `loadPacks` only uses already-typed APIs (`getPacks`, `selectPack`, `applyPack`) — no new types introduced.

- [ ] **Step 3: Commit**

```bash
git add src/board.html
git commit -m "$(cat <<'EOF'
feat(board): auto-refresh pack picker on packs-changed

Extracts loadPacks() from the existing loadPackData() init call and
wires it to the onPacksChanged IPC event so the board pack picker
updates after yt-pack imports, pack create/delete/edit — no reload
required. Handles the active-pack-deleted edge case by falling back
to packs[0] via selectPack so main persists the new selection.
EOF
)"
```

---

## Self-review checklist

- [ ] **Spec coverage:** every item in the spec's "Scope summary" table has a corresponding task step.
- [ ] **Placeholder scan:** no `TODO`, `FIXME`, `XXX`, or `<placeholder>` strings introduced.
- [ ] **Type consistency:** `loadPacks()` uses only existing typed APIs; no `any` casts added.
- [ ] **No double-render:** the deleted-pack fallback path routes through `selectPack` → `onPackSelected` → `applyPack`; `loadPacks()` does not also call `applyPack` on that path.
- [ ] **Existing behavior preserved:** `loadPackData()` is unchanged; the browser-preview fallback (non-Electron path) still works.
- [ ] **No preload or main.ts changes:** confirmed — the subscription uses `onPacksChanged` which is already exposed in `preload.ts` line 101–102.
