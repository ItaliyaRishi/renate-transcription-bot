import type { Page } from "playwright";
import pino from "pino";
import { selectors } from "./selectors.js";

const log = pino({ name: "bot.endDetect", level: process.env.LOG_LEVEL ?? "info" });

export interface EndSignalOptions {
  hardTimeoutMs: number;
  /** How long the bot must read ≤1 participant before firing. Default 60s. */
  aloneSustainedMs?: number;
  /** How long the "Leave call" button must be missing. Default 5s. */
  leaveButtonMissingMs?: number;
  /** Poll interval for alone-detection. Default 5s. */
  pollMs?: number;
}

/**
 * Resolves when the call should be considered ended. Returns the signal
 * name that tripped so the caller can log it.
 *
 * Signals (Promise.race, whichever fires first):
 *   - alone_sustained: participant count stayed ≤1 for aloneSustainedMs
 *   - leave_button_missing: Meet kicked the bot out (no leave button)
 *   - url_changed: navigated away from /<meeting-code>
 *   - hard_timeout: absolute ceiling (default 120 min)
 *
 * The previous text-banner detector ("You're the only one here") was dropped
 * — it never fired in practice because the selector relies on locale-specific
 * strings and Meet often suppresses the banner for third-party clients.
 */
export async function waitForCallEnd(
  page: Page,
  opts: EndSignalOptions
): Promise<string> {
  const aloneSustainedMs = opts.aloneSustainedMs ?? 60_000;
  const leaveMissingGrace = opts.leaveButtonMissingMs ?? 5_000;
  const pollMs = opts.pollMs ?? 5_000;

  const hardTimeout = new Promise<string>((resolve) =>
    setTimeout(() => resolve("hard_timeout"), opts.hardTimeoutMs)
  );

  const leaveMissing = (async () => {
    let absentSince: number | null = null;
    while (true) {
      const present = await page
        .locator(selectors.leaveCallButton)
        .first()
        .isVisible()
        .catch(() => false);
      if (!present) {
        absentSince ??= Date.now();
        if (Date.now() - absentSince >= leaveMissingGrace) return "leave_button_missing";
      } else {
        absentSince = null;
      }
      await page.waitForTimeout(1_500);
    }
  })();

  const aloneSustained = (async () => {
    let aloneSince: number | null = null;
    // Allow a 30s warmup so we don't trip before the real participants
    // render (headful Chromium sometimes takes a beat).
    const warmupUntil = Date.now() + 30_000;
    while (true) {
      await page.waitForTimeout(pollMs);
      if (Date.now() < warmupUntil) continue;

      const count = await readParticipantCount(page);
      if (count === null) {
        // Can't read count — don't falsely trip.
        aloneSince = null;
        continue;
      }
      if (count <= 1) {
        aloneSince ??= Date.now();
        const sustained = Date.now() - aloneSince;
        if (sustained >= aloneSustainedMs) {
          log.info({ count, sustainedMs: sustained }, "alone sustained");
          return "alone_sustained";
        }
      } else {
        aloneSince = null;
      }
    }
  })();

  // When Meet ends the call for the bot, the URL usually navigates away
  // from /<meeting-code> to a home/ended page. Very reliable, no DOM deps.
  const urlChanged = (async () => {
    const initialPath = new URL(page.url()).pathname;
    while (true) {
      const now = new URL(page.url()).pathname;
      if (now !== initialPath) return "url_changed";
      await page.waitForTimeout(1_500);
    }
  })();

  const signal = await Promise.race([
    hardTimeout,
    aloneSustained,
    leaveMissing,
    urlChanged,
  ]);
  log.info({ signal }, "call-end signal");
  return signal;
}

/**
 * Read the participant count from Meet's UI without opening the side panel.
 *
 * Meet exposes the count in two places:
 *   1. The "people" toolbar button's aria-label (fastest, no side effects).
 *   2. A small counter text inside the same button (fallback).
 *
 * Returns null when the button isn't visible — that's "unknown", NOT alone.
 */
async function readParticipantCount(page: Page): Promise<number | null> {
  // Try any of the people-panel aliases first (aria-label regex is locale-varying).
  const handles = await page
    .locator(selectors.peoplePanelButton)
    .elementHandles()
    .catch(() => []);
  try {
    for (const h of handles) {
      const visible = await h.isVisible().catch(() => false);
      if (!visible) continue;
      const aria = ((await h.getAttribute("aria-label").catch(() => null)) ?? "").trim();
      const m = aria.match(/(\d+)/);
      if (m) return Number(m[1]);
      // Fallback: inner text node often carries just the count.
      const txt = ((await h.textContent().catch(() => null)) ?? "").trim();
      const tm = txt.match(/(\d+)/);
      if (tm) return Number(tm[1]);
    }
  } finally {
    for (const h of handles) await h.dispose().catch(() => {});
  }
  return null;
}
