import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { withProjectBuildServers } from '../../packages/engine/dist/build-servers.js';
import { buildWorkspace } from '../helpers/build-workspace.mjs';

test('Chromium loads and interacts with both attested static builds on desktop and mobile', async () => {
  const { root, config } = await buildWorkspace();
  config.limits.maxDurationMs = 60000;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const result = await withProjectBuildServers({ config, workspaceRoot: root, allowProjectCommands: true }, async session => {
      for (const side of ['source', 'target']) for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
        try {
          const page = await context.newPage(), errors = [];
          page.on('pageerror', error => errors.push(error.message));
          const response = await page.goto(`${session[side].origin}/page/42`);
          assert.equal(response.status(), 200);
          assert.equal(response.headers()['x-migration-build'], session[side].buildHash);
          await page.getByRole('button', { name: 'Save', exact: true }).click();
          assert.equal(await page.locator('output').textContent(), 'Saved');
          assert.ok((await page.screenshot()).length > 1000);
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
      return 'browser-complete';
    });
    assert.equal(result.value, 'browser-complete');
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
