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

    // Track every RTCPeerConnection so leaveMeet can close them explicitly.
    // Without this, if the Leave-call button click misses (host-kicked, UI
    // changed, race), the WebRTC session stays alive at the TURN/ICE layer
    // for ~minutes — which makes Meet think the bot account is still in
    // the prior call and shows "Switch here" on the next join.
    const Native = (window as unknown as { RTCPeerConnection: typeof RTCPeerConnection })
      .RTCPeerConnection;
    if (Native) {
      const registry: RTCPeerConnection[] = [];
      const Patched = function (this: RTCPeerConnection, ...args: unknown[]) {
        const pc = new (Native as unknown as new (...a: unknown[]) => RTCPeerConnection)(...args);
        registry.push(pc);
        return pc;
      } as unknown as typeof RTCPeerConnection;
      Patched.prototype = Native.prototype;
      Object.defineProperty(window, "RTCPeerConnection", {
        configurable: true,
        writable: true,
        value: Patched,
      });
      (window as unknown as { __renatePeerConnections: RTCPeerConnection[] })
        .__renatePeerConnections = registry;
    }
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

    // Race three possible join states. Whichever button appears first wins.
    //   1. "Join now"    — invited / workspace member
    //   2. "Switch here" — same Google account is already in another call;
    //                       Meet offers a clean device handoff that bypasses
    //                       the "Ask to join" gate. Common when a prior bot
    //                       container exited without fully tearing down its
    //                       WebRTC session.
    //   3. "Ask to join" — knock-to-join, host must admit
    type JoinKind = "joinNow" | "switchHere" | "askToJoin";
    const candidates: Array<{ kind: JoinKind; selector: string }> = [
      { kind: "joinNow", selector: selectors.joinNowButton },
      { kind: "switchHere", selector: selectors.switchHereButton },
      { kind: "askToJoin", selector: selectors.askToJoinButton },
    ];

    const probe = async ({ kind, selector }: { kind: JoinKind; selector: string }) => {
      await page
        .locator(selector)
        .first()
        .waitFor({ state: "visible", timeout: joinTimeout });
      return kind;
    };

    let joinKind: JoinKind;
    try {
      joinKind = await Promise.any(candidates.map(probe));
    } catch {
      // No join button appeared at all within joinTimeout.
      throw new Error(
        `no join button visible within ${joinTimeout}ms (none of joinNow/switchHere/askToJoin)`
      );
    }

    const winningSelector = candidates.find((c) => c.kind === joinKind)!.selector;
    const joinButton = page.locator(winningSelector).first();
    log.info({ joinKind }, "clicking join");
    await joinButton.click({ timeout: 10_000 });

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
      // Wait for Meet's "you left" landing OR the leave-call button to
      // disappear, whichever comes first. Capped at 5s so a stuck UI
      // doesn't hold the container open.
      await Promise.race([
        result.page
          .waitForURL(/meet\.google\.com\/(landing|home|_meet)/i, { timeout: 5_000 })
          .catch(() => {}),
        result.page
          .locator(selectors.leaveCallButton)
          .waitFor({ state: "hidden", timeout: 5_000 })
          .catch(() => {}),
      ]);
    }

    // Belt-and-suspenders: explicitly close every RTCPeerConnection the page
    // ever opened. Even if the Leave click missed or fired before signaling
    // could ack, this severs ICE and Meet's signaling layer drops the
    // participant immediately. Without it, the bot's Google account can
    // appear "still in another call" for several minutes on the next join.
    await result.page
      .evaluate(() => {
        const w = window as unknown as { __renatePeerConnections?: RTCPeerConnection[] };
        const conns = w.__renatePeerConnections ?? [];
        let closed = 0;
        for (const pc of conns) {
          try {
            pc.getSenders().forEach((s) => s.track?.stop());
            pc.getReceivers().forEach((r) => r.track?.stop());
            pc.close();
            closed++;
          } catch {
            /* already closed */
          }
        }
        return { tracked: conns.length, closed };
      })
      .then((stats) => log.info(stats, "peer connections closed"))
      .catch((err) => log.warn({ err }, "peer-connection close failed"));
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
