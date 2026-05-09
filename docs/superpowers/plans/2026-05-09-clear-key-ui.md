# Discoverable Clear-Key UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hover-`×` affordance to bound key tiles in Pack Management's pack-detail grid. Mouse users see the `×` on hover; keyboard users Tab to a tile and press Delete/Backspace. Routes through the existing `packUnbindKey` IPC. The board right-click shortcut is untouched.

**Architecture:** Renderer-only. No new IPC channels. `packUnbindKey(packId, key)` is already exposed via `window.electronAPI`. The `selected` object already carries `origin` so bundled-pack detection requires no new data. All changes are confined to `src/packs.html`.

**Tech Stack:** Vanilla HTML/CSS/JS in `src/packs.html`, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-05-09-clear-key-ui-design.md`

---

## Task 1: CSS — `.row-clear-x` hover and focus-visible affordance

**File:** `src/packs.html` (the `<style>` block)

Add the following CSS immediately after the `.mini-key.user-bound::after` rule (around line 415):

- [ ] **Step 1: Add CSS for the clear button**

```css
/* ── Clear-key × affordance ──────────────────────────── */
.row-clear-x {
  position: absolute; top: 4px; right: 4px;
  width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1;
  color: var(--muted2);
  background: transparent;
  border: none; border-radius: 2px;
  cursor: pointer; padding: 0;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
}
.mini-key:hover .row-clear-x,
.mini-key:focus-visible .row-clear-x {
  opacity: 1;
}
.row-clear-x:hover {
  color: var(--amber);
  background: var(--amber-bg);
}
.row-clear-x:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--amber-ring);
  opacity: 1;
}
```

- [ ] **Step 2: Verify visually** — open `src/packs.html` in the app, hover a bound key, confirm `×` appears top-right and glows amber on secondary hover. Empty tiles must show no `×`.

---

## Task 2: Render `×` button in bound-key rows

**File:** `src/packs.html` (the `renderSounds()` function, bound-key branch)

The current bound-key `innerHTML` block (inside the `if (entry)` branch of `renderSounds()`) looks like:

```js
el.innerHTML = `
  <div class="mini-letter">${k.toUpperCase()}</div>
  <div class="mini-div"></div>
  <div class="mini-bottom">
    <div class="mini-name"></div>
  </div>
`;
```

- [ ] **Step 1: Add `×` button and `tabindex` to the bound-key tile**

Replace that `innerHTML` assignment with:

```js
el.innerHTML = `
  <div class="mini-letter">${k.toUpperCase()}</div>
  <div class="mini-div"></div>
  <div class="mini-bottom">
    <div class="mini-name"></div>
  </div>
  <button class="row-clear-x"
          aria-label="Clear ${k.toUpperCase()}"
          tabindex="0"
          data-clear-key="${k}">×</button>
`;
el.setAttribute('tabindex', '0');
```

The tile gets `tabindex="0"` so keyboard users can Tab into it. Empty tiles remain `pointer-events: none` via the existing `.mini-key.empty` rule and receive no `×` button (the empty branch is unchanged).

- [ ] **Step 2: Verify in app** — bound keys show `×` top-right on hover; empty tiles do not.

---

## Task 3: Wire click handler — confirm → `packUnbindKey` → toast

**File:** `src/packs.html` (JS section, after `renderSounds` definition)

Add a delegated listener on the sounds grid. Mirror the board's right-click handler verbatim (board.html:730–744):

- [ ] **Step 1: Add click delegation block**

Find the line `attachDropHandlers(el, k);` inside `renderSounds()` — add the following listener block just after the existing `renderSounds` function closes (around line 892), before `previewSound`:

```js
// ── Clear-key × click handler ──────────────────────
document.getElementById('soundsGrid').addEventListener('click', async e => {
  const btn = e.target.closest('.row-clear-x');
  if (!btn) return;
  e.stopPropagation();           // don't fire the tile's own onclick (previewSound)
  const key  = btn.dataset.clearKey;
  const name = btn.closest('.mini-key')?.querySelector('.mini-name')?.textContent || key.toUpperCase();
  const isBundled = selected?.origin !== 'user';
  const packLabel = isBundled ? `your ${selected?.name || 'pack'}` : (selected?.name || 'this pack');
  if (!confirm(`Clear ${key.toUpperCase()} from ${packLabel}?`)) return;
  const res = await window.electronAPI?.packUnbindKey?.(selected.id, key);
  if (res?.ok) {
    const prefix = isBundled ? `Cleared ${key.toUpperCase()} from your ${selected?.name || 'pack'}` : `Cleared ${key.toUpperCase()}`;
    showToast(res.changed ? prefix : `${key.toUpperCase()} was already empty`);
  } else {
    showToast(res?.error || 'Could not clear pad');
  }
  renderSounds();
});
```

Note: The listener must be registered after the DOM element exists. Since `soundsGrid` is a static element in the HTML (not dynamically created), registering it once at script-init time is fine. If `renderSounds()` re-creates inner HTML, event delegation on the static `#soundsGrid` container handles all dynamically created `×` buttons correctly.

- [ ] **Step 2: Smoke test** — click `×` on a bound key → cancel → nothing changes. Click `×` → confirm → tile empties, toast appears.

---

## Task 4: Keyboard handler — Delete/Backspace on focused tile

**File:** `src/packs.html` (JS section, after the click handler block)

- [ ] **Step 1: Add keydown delegation block**

```js
// ── Clear-key keyboard: Delete / Backspace on focused tile ──
document.getElementById('soundsGrid').addEventListener('keydown', async e => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const tile = e.target.closest('.mini-key[data-key]');
  if (!tile || tile.classList.contains('empty')) return;
  e.preventDefault();
  const key  = tile.dataset.key;
  const isBundled = selected?.origin !== 'user';
  const packLabel = isBundled ? `your ${selected?.name || 'pack'}` : (selected?.name || 'this pack');
  if (!confirm(`Clear ${key.toUpperCase()} from ${packLabel}?`)) return;
  const res = await window.electronAPI?.packUnbindKey?.(selected.id, key);
  if (res?.ok) {
    const prefix = isBundled ? `Cleared ${key.toUpperCase()} from your ${selected?.name || 'pack'}` : `Cleared ${key.toUpperCase()}`;
    showToast(res.changed ? prefix : `${key.toUpperCase()} was already empty`);
  } else {
    showToast(res?.error || 'Could not clear pad');
  }
  renderSounds();
});
```

- [ ] **Step 2: Smoke test** — Tab to a bound tile (focus ring appears) → press Delete → confirm dialog → cancel → nothing changes. Press Delete again → confirm OK → tile empties, toast appears.

---

## Task 5: Playwright e2e — happy path

**File:** Create `tests/e2e/clear-key.spec.ts`

- [ ] **Step 1: Create the spec**

```typescript
import { test, expect } from '@playwright/test';

test.describe('Clear-key affordance', () => {
  test('hover-× clears a bound key and shows toast', async ({ electronApp, page }) => {
    // Open Pack Management
    await page.click('[data-testid="nav-packs"]');   // or however navigation works
    await page.waitForSelector('.pack-row');

    // Select a pack that has at least one bound key (Classics is always present)
    await page.click('.pack-row:first-child');
    await page.waitForSelector('.mini-key:not(.empty)');

    // Hover the first bound tile
    const boundTile = page.locator('.mini-key:not(.empty)').first();
    await boundTile.hover();

    // × button should now be visible
    const clearBtn = boundTile.locator('.row-clear-x');
    await expect(clearBtn).toBeVisible();

    // Click × — handle the confirm dialog
    page.on('dialog', dialog => dialog.accept());
    await clearBtn.click();

    // Toast should appear
    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).toContainText('Cleared');

    // The tile that had the sound should now be empty
    // (renderSounds re-runs; tile gets .empty class)
    // We check that at least one fewer bound tile exists than before
  });
});
```

- [ ] **Step 2: Run the spec**

```bash
npx playwright test tests/e2e/clear-key.spec.ts
```

Expected: 1 test passes (or is skipped if the app fixture is not yet configured for this machine).

---

## Task 6: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add src/packs.html tests/e2e/clear-key.spec.ts
git commit -m "$(cat <<'EOF'
feat(packs): discoverable clear-key UI in Pack Management

Adds a hover-× affordance to bound key tiles in the pack-detail
grid. Keyboard users can Tab to a tile and press Delete/Backspace.
Routes through existing packUnbindKey IPC; bundled packs get a
'from your X' toast to surface the clone-on-write override.
Right-click on board pads is unchanged.
EOF
)"
```

---

## Self-Review Checklist

- [ ] **Spec coverage:** does the implementation cover all spec sections?
  - Goal — bound key rows get × ✓
  - Non-goals — board pads unchanged ✓, no main.ts changes ✓
  - Accessibility — `tabindex`, `aria-label`, Delete/Backspace, focus-visible ring ✓
  - Error handling — IPC error fallback, bundled-pack "your" toast, already-empty toast ✓
  - Bundled-pack detection — `selected.origin !== 'user'` ✓
- [ ] **Placeholder scan:** no `TODO`, `FIXME`, or `???` left in committed code.
- [ ] **Type consistency:** `packUnbindKey` returns `{ ok, changed?, error? }` — handler reads all three branches.
- [ ] **Empty-row guard:** `×` button is only injected in the `if (entry)` branch; `.empty` tiles untouched.
- [ ] **Event delegation:** listener on static `#soundsGrid` — survives `renderSounds()` re-renders correctly.
- [ ] **Board refresh dependency noted in spec:** this feature ships independently; full "board reflects unbind" UX requires Design #1 (board auto-refresh on `packs-changed`).
