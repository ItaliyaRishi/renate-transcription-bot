import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import pino from "pino";
import { selectors } from "./selectors.js";

const log = pino({ name: "bot.join", level: process.env.LOG_LEVEL ?? "info" });

export interface JoinResult {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  joinedAt: Date;
}

export interface JoinOptions {
  meetUrl: string;
  authProfile: string;
  joinTimeoutMs?: number;
  displayName?: string;
}

const DEFAULT_JOIN_TIMEOUT_MS = 60_000;

export async function joinMeet(opts: JoinOptions): Promise<JoinResult> {
  const joinTimeout = opts.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;

  // Headful inside Xvfb — headless-shell doesn't route audio to PulseAudio,
  // so we'd capture silence. See bot/docker/entrypoint.sh.
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-gpu",
      // Keep the Meet tab's renderer alive while the bot sits idle. Without
      // these, Chromium throttles background timers ~5 min in and the
      // WebRTC-to-PulseAudio path starves — we saw digital silence in
      // chunks 12-38 of session fc7b1ae1.
      "--disable-background-media-suspend",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
    ],
  });

  const context = await browser.newContext({
    storageState: opts.authProfile,
    viewport: { width: 1280, height: 800 },
    permissions: ["microphone", "camera"],
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  // Minimal stealth: hide the automation flag and align a couple of
  // properties Meet's detection scripts have historically checked.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });

  await context.grantPermissions(["microphone", "camera"], {
    origin: "https://meet.google.com",
  });

  const page = await context.newPage();

  try {
    log.info({ meetUrl: opts.meetUrl }, "navigating to Meet");
    await page.goto(opts.meetUrl, { waitUntil: "domcontentloaded", timeout: joinTimeout });

    // Pre-join: mic + cam should be OFF before we click Join. Meet's default
    // for the bot account is usually off, but we enforce it defensively.
    await ensureMuted(page);

    // Some flows show a name input (consumer accounts, guest mode); if so,
    // fill it. Workspace authenticated accounts skip this.
    if (opts.displayName) {
      const nameInput = page.locator(selectors.preJoinNameInput);
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill(opts.displayName);
      }
    }

    // Click join. "Join now" (invited) beats "Ask to join" (knock) when both
    // are present, but in practice only one is rendered.
    const joinNow = page.locator(selectors.joinNowButton).first();
    const askToJoin = page.locator(selectors.askToJoinButton).first();
    const joinButton = (await joinNow.isVisible().catch(() => false)) ? joinNow : askToJoin;

    log.info("clicking join");
    await joinButton.click({ timeout: joinTimeout });

    // Join success = "Leave call" button appears in the post-join UI.
    // For knock-to-join, this may take longer as host must admit; caller's
    // joinTimeoutMs should account for that.
    log.info("waiting for post-join UI");
    await page.locator(selectors.leaveCallButton).waitFor({
      state: "visible",
      timeout: joinTimeout,
    });

    // Post-join, Meet can re-enable mic/cam depending on room policy. Re-mute
    // now that we're in.
    await ensureMutedInCall(page);

    const joinedAt = new Date();
    log.info({ joinedAt }, "joined");
    return { browser, context, page, joinedAt };
  } catch (err) {
    log.error({ err }, "join failed");
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Join with exponential backoff. Useful when Google throws a transient
 * "can't join right now" or the lobby host is slow.
 */
export async function joinMeetWithRetry(
  opts: JoinOptions,
  maxAttempts = 3
): Promise<JoinResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await joinMeet(opts);
    } catch (err) {
      lastErr = err;
      const backoffMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      log.warn({ attempt, maxAttempts, backoffMs, err }, "join failed; backing off");
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

export async function leaveMeet(result: JoinResult): Promise<void> {
  try {
    const leave = result.page.locator(selectors.leaveCallButton);
    if (await leave.isVisible().catch(() => false)) {
      log.info("clicking leave");
      await leave.click({ timeout: 10_000 }).catch(() => {});
      // Give Meet a moment to record the leave event.
      await result.page.waitForTimeout(500);
    }
  } finally {
    await result.context.close().catch(() => {});
    await result.browser.close().catch(() => {});
    log.info("bot left meet");
  }
}

async function ensureMuted(page: Page): Promise<void> {
  await toggleIfOn(page, selectors.preJoinMicToggle, "mic");
  await toggleIfOn(page, selectors.preJoinCamToggle, "cam");
}

async function ensureMutedInCall(page: Page): Promise<void> {
  // In-call mic/cam buttons use the same aria-label scheme as pre-join.
  await toggleIfOn(page, selectors.preJoinMicToggle, "mic (in-call)");
  await toggleIfOn(page, selectors.preJoinCamToggle, "cam (in-call)");
}

async function toggleIfOn(page: Page, selector: string, label: string): Promise<void> {
  const btn = page.locator(selector).first();
  if (!(await btn.isVisible().catch(() => false))) return;

  // aria-label flips between "Turn off <device>" (currently ON) and
  // "Turn on <device>" (currently OFF). We click only when it's ON.
  const aria = (await btn.getAttribute("aria-label").catch(() => null)) ?? "";
  if (/turn off/i.test(aria)) {
    log.info({ device: label }, "muting");
    await btn.click().catch(() => {});
  }
}
