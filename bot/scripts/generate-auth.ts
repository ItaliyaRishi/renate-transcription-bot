// One-time helper: launches a headful Chromium, lets the operator sign in
// to Google manually, and saves the authenticated storage state to
// `auth/auth.json` for later reuse by the headless bot.
//
// Usage (from repo root):
//   cd bot && npm run generate-auth
//
// The resulting `auth/auth.json` is gitignored. Mount it into the bot
// container at /auth/auth.json.

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const OUTPUT = resolve(process.cwd(), "../auth/auth.json");
const LOGIN_URL = "https://accounts.google.com/";
const READY_MARKER = "https://myaccount.google.com";

async function main() {
  await mkdir(dirname(OUTPUT), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  console.log(`→ opening ${LOGIN_URL}`);
  console.log("→ sign in manually (including 2FA).");
  console.log(`→ once you land on ${READY_MARKER}, the session will be saved automatically.`);

  await page.goto(LOGIN_URL);

  await page.waitForURL(
    (url) => url.toString().startsWith(READY_MARKER),
    { timeout: 10 * 60 * 1000 }
  );

  await context.storageState({ path: OUTPUT });
  console.log(`✓ auth state saved to ${OUTPUT}`);

  await browser.close();
}

main().catch((err) => {
  console.error("generate-auth failed:", err);
  process.exit(1);
});
