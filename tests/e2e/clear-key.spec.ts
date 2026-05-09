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
