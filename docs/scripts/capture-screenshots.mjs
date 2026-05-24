#!/usr/bin/env node
// Capture screenshots of the live InstCombine fold debugger webapp.
// Usage:
//   NODE_PATH=/path/to/playwright-install/node_modules node capture-screenshots.mjs
//   (or run `npm install playwright` in this directory first, then `node capture-screenshots.mjs`).
//
// Default target: https://xuhongxu.com/instcombine-instrumentor/
// Override with INSTCOMBINE_URL env var.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const TARGET_URL = process.env.INSTCOMBINE_URL || "https://xuhongxu.com/instcombine-instrumentor/";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "images");

async function waitForReady(page) {
  // Manifest + default wasm bundle finish loading -> status text loses "loading…".
  await page.waitForFunction(
    () => {
      const s = document.querySelector(".toolbar .status");
      if (!s) return false;
      const t = (s.textContent || "").toLowerCase();
      return !t.includes("loading");
    },
    { timeout: 90_000 },
  );
}

async function clickButtonByText(page, text) {
  await page.locator(`.toolbar button:has-text("${text}")`).first().click();
}

async function shoot(page, name, locator = null, opts = {}) {
  const path = resolve(OUT_DIR, `${name}.png`);
  if (locator) await locator.screenshot({ path, ...opts });
  else await page.screenshot({ path, fullPage: opts.fullPage ?? false, ...opts });
  console.log(`  ✓ ${name}.png`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  console.log(`→ ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 90_000 });
  await waitForReady(page);
  await page.waitForTimeout(500);

  // 1. Overview — full window screenshot (light theme, sample IR loaded).
  await shoot(page, "overview");

  // 2. Toolbar close-up.
  await shoot(page, "toolbar", page.locator(".toolbar"));

  // 3. Run InstCombine on the default IR.
  await clickButtonByText(page, "Run");
  await page.waitForFunction(
    () => {
      const s = document.querySelector(".toolbar .status");
      const t = (s?.textContent || "").toLowerCase();
      return t.includes("trace") && t.includes("byte");
    },
    { timeout: 60_000 },
  );
  await page.waitForTimeout(500);

  // Default view is "structured". Switch to text mode first for the text-trace capture.
  await page.locator('.view-mode-toggle button:has-text("text")').click();
  await page.waitForTimeout(400);
  await shoot(page, "after-run-text-trace");

  // 5. Switch trace view back to Structured.
  await page.locator('.view-mode-toggle button:has-text("structured")').click();
  await page.waitForSelector(".structured-trace", { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shoot(page, "structured-trace");

  // 6. Expand the first value card's <details> stack.
  const firstStack = page.locator(".trace-card details.trace-frames").first();
  if (await firstStack.count()) {
    await firstStack.evaluate((el) => (el.open = true));
    await page.waitForTimeout(200);
    await shoot(page, "structured-stack-expanded", page.locator(".trace-card").first());
  }

  // 7. Type into the rule filter and capture filtered state.
  const ruleInput = page.locator('.trace-filter-bar input[placeholder="rule (visit*)"]');
  await ruleInput.fill("visitAdd");
  await page.waitForTimeout(400);
  await shoot(page, "structured-filtered", page.locator(".structured-trace"));
  await ruleInput.fill("");
  await page.waitForTimeout(200);

  // 8. Click a replacement pointer (cross-link to value card).
  const ptrLink = page.locator(".ptr-link").first();
  if (await ptrLink.count()) {
    await ptrLink.click();
    await page.waitForTimeout(400);
    await shoot(page, "pointer-crosslink", page.locator(".structured-trace"));
  }

  // 9. Share button -> "link copied".
  //    Grant clipboard permission so the button reports success.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(TARGET_URL).origin });
  await page.locator('.toolbar button:has-text("Share")').click();
  await page.waitForTimeout(300);
  await shoot(page, "share-link-copied", page.locator(".toolbar"));
  await page.waitForTimeout(1500); // let "link copied" revert

  // 10. Toggle theme to dark.
  const themeSelect = page.locator(".theme-picker select");
  await themeSelect.selectOption("dark");
  await page.waitForTimeout(400);
  await shoot(page, "theme-dark");

  // Back to light for the resize capture.
  await themeSelect.selectOption("system");
  await page.waitForTimeout(300);

  // 11. Drag the vertical resize handle to a non-default position.
  const handle = page.locator(".pane-resize-handle.vertical");
  const box = await handle.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 220, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await shoot(page, "pane-resize");
  }

  await browser.close();
  console.log(`\nAll screenshots written to ${OUT_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
