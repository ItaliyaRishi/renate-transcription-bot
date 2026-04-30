import type { Page } from "playwright";
import pino from "pino";
import { selectors } from "./selectors.js";

const log = pino({ name: "bot.peoplePanel", level: process.env.LOG_LEVEL ?? "info" });

const OPEN_TIMEOUT_MS = 10_000;
const POLL_MS = 250;
const WATCHDOG_MS = 2_000;

export interface RosterObserverHandle {
  /** Force a re-scan of the panel right now (e.g. before SIGTERM). */
  snapshot(): Promise<string[]>;
  stop(): Promise<void>;
}

/**
 * Live roster observer. Opens the People panel once, attaches a
 * MutationObserver to the participants container, and emits the current
 * roster every time childList/subtree changes. Catches joiners + leavers
 * within ~50 ms — including silent participants who never appear in the
 * captions stream. A 2 s watchdog re-opens the panel if the user closes
 * it (or Meet collapses it on a layout change).
 */
export async function startRosterObserver(
  page: Page,
  botName: string,
  sink: (names: string[]) => void | Promise<void>
): Promise<RosterObserverHandle> {
  let lastRosterJSON = "";

  await page.exposeBinding("__renatePushRoster", async (_src, payload) => {
    try {
      const raw = payload as { names?: unknown };
      if (!raw || !Array.isArray(raw.names)) return;
      const cleaned = dedupe(
        (raw.names as unknown[])
          .map((n) => String(n ?? "").trim())
          .filter(Boolean)
      ).filter((n) => !isBotName(n, botName));
      const json = JSON.stringify(cleaned);
      if (json === lastRosterJSON) return;
      lastRosterJSON = json;
      const prev = lastRosterJSON ? safeParse(lastRosterJSON) : [];
      const added = cleaned.filter((n) => !prev.includes(n));
      const removed = prev.filter((n) => !cleaned.includes(n));
      log.info({ total: cleaned.length, added, removed, names: cleaned }, "roster delta");
      await sink(cleaned);
    } catch (err) {
      log.error({ err }, "roster sink failed");
    }
  });

  const opened = await openPanel(page);
  if (!opened) {
    log.warn("people panel did not open initially; observer will retry via watchdog");
  }

  await attachObserver(page);
  startWatchdog(page);

  log.info("roster observer attached");

  return {
    async snapshot(): Promise<string[]> {
      const names = await scrapeOnce(page);
      const cleaned = dedupe(names.map((n) => n.trim()).filter(Boolean))
        .filter((n) => !isBotName(n, botName));
      const json = JSON.stringify(cleaned);
      if (json !== lastRosterJSON) {
        lastRosterJSON = json;
        log.info({ total: cleaned.length, names: cleaned }, "roster snapshot (final)");
        await sink(cleaned);
      }
      return cleaned;
    },
    async stop(): Promise<void> {
      await page
        .evaluate(() => {
          const w = window as unknown as {
            __renateRosterObserver?: MutationObserver;
            __renateRosterWatchdog?: ReturnType<typeof setInterval>;
          };
          w.__renateRosterObserver?.disconnect();
          if (w.__renateRosterWatchdog) clearInterval(w.__renateRosterWatchdog);
        })
        .catch(() => {});
      log.info("roster observer stopped");
    },
  };
}

async function attachObserver(page: Page): Promise<void> {
  await page.evaluate(
    ({ panelSel, rowSel }) => {
      type RosterScraper = () => string[];

      const NOISE_PREFIXES = [
        "keep_outline", "more_vert", "mic_off", "mic_on", "videocam",
        "present_to_all", "volume", "spatial_audio",
        "remove", "mute", "unmute", "pin", "unpin", "present",
      ];
      const ACTION_PHRASES = /\bthis (tile|call|person)\b/i;
      const looksLikeName = (s: string): boolean => {
        if (!s) return false;
        if (s.length > 60) return false;
        const low = s.toLowerCase();
        if (NOISE_PREFIXES.some((p) => low.startsWith(p))) return false;
        if (/^(devices?|menu|options|more|pin|unpin|remove|mute)$/i.test(s.trim())) return false;
        if (ACTION_PHRASES.test(s)) return false;
        if (!/[a-z]/i.test(s)) return false;
        return true;
      };

      function findPanel(): ParentNode | null {
        for (const sel of panelSel.split(",").map((s: string) => s.trim())) {
          const el = document.querySelector(sel);
          if (el) return el;
        }
        return null;
      }

      function isInsideButton(el: Element): boolean {
        return el.closest('button, [role="button"]') !== null;
      }
      function isActionMenuItem(el: Element): boolean {
        if (el.getAttribute("role") === "menuitem") return true;
        return el.closest('[role="menu"]') !== null;
      }

      const scrape: RosterScraper = () => {
        const panel = findPanel();
        if (!panel) return [];
        const names: string[] = [];
        const rows = (panel as ParentNode).querySelectorAll(rowSel);
        rows.forEach((el) => {
          if (isActionMenuItem(el)) return;
          // Strategy 1: aria-label on the row that's purely a name.
          const aria = (el.getAttribute("aria-label") ?? "").trim();
          if (aria && looksLikeName(aria) && !aria.includes("\n") && aria.split(" ").length <= 5) {
            names.push(aria);
            return;
          }
          // Strategy 2: shortest clean inner span outside any button.
          const spans = Array.from(el.querySelectorAll("span")).filter(
            (s) => !isInsideButton(s as Element)
          );
          const candidates = spans
            .map((s) => (s.textContent ?? "").trim())
            .filter(looksLikeName);
          if (candidates.length) {
            candidates.sort((a, b) => a.length - b.length);
            names.push(candidates[0]);
            return;
          }
          // Strategy 3: longest repeated token run in aria-label.
          if (aria) {
            const tokens = aria.split(/\s+/).filter(Boolean);
            const counts = new Map<string, number>();
            tokens.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
            for (let i = 0; i < tokens.length; i++) {
              const t = tokens[i];
              if ((counts.get(t) ?? 0) >= 2 && looksLikeName(t)) {
                const next = tokens[i + 1];
                const full =
                  next && (counts.get(next) ?? 0) >= 2 && looksLikeName(next)
                    ? `${t} ${next}`
                    : t;
                names.push(full);
                return;
              }
            }
          }
        });
        return names;
      };

      const w = window as unknown as {
        __renateRosterObserver?: MutationObserver;
        __renatePushRoster?: (p: { names: string[] }) => Promise<void>;
        __renateScrapeRoster?: RosterScraper;
      };
      w.__renateScrapeRoster = scrape;

      const fire = () => {
        try {
          const names = scrape();
          if (w.__renatePushRoster) void w.__renatePushRoster({ names });
        } catch {
          // single-tick failure is fine; the next mutation triggers another
        }
      };

      const panel = findPanel();
      if (panel) {
        const obs = new MutationObserver(() => fire());
        obs.observe(panel as Node, { childList: true, subtree: true });
        w.__renateRosterObserver = obs;
        // Initial fire so we don't wait for the first mutation.
        fire();
      }
    },
    {
      panelSel: selectors.peoplePanelContainer,
      rowSel: selectors.peoplePanelRosterItem,
    }
  );
}

function startWatchdog(page: Page): void {
  // Re-open the panel + re-attach the observer if Meet ever collapses it.
  // We poll only every WATCHDOG_MS so it's near-zero overhead.
  void page
    .evaluate(
      ({ panelSel, watchdogMs }) => {
        const w = window as unknown as {
          __renateRosterWatchdog?: ReturnType<typeof setInterval>;
        };
        if (w.__renateRosterWatchdog) return;
        w.__renateRosterWatchdog = setInterval(() => {
          // We only flag when the panel is missing; the Node side handles
          // re-opening (Playwright clicks). Setting a flag keeps client-side
          // logic minimal.
          const present = !!document.querySelector(panelSel.split(",")[0].trim());
          (window as unknown as { __renateRosterPanelPresent?: boolean })
            .__renateRosterPanelPresent = present;
        }, watchdogMs);
      },
      { panelSel: selectors.peoplePanelContainer, watchdogMs: WATCHDOG_MS }
    )
    .catch(() => {});

  // Node-side polling tied to the same cadence — opens the panel + reattaches
  // the observer if it's gone.
  const nodeWatchdog = setInterval(async () => {
    try {
      const present = await page
        .evaluate(
          () =>
            (window as unknown as { __renateRosterPanelPresent?: boolean })
              .__renateRosterPanelPresent ?? true
        )
        .catch(() => true);
      if (!present) {
        log.warn("people panel disappeared; re-opening");
        const opened = await openPanel(page);
        if (opened) await attachObserver(page);
      }
    } catch {
      // ignore
    }
  }, WATCHDOG_MS);
  (globalThis as { __renateRosterNodeWatchdog?: ReturnType<typeof setInterval> })
    .__renateRosterNodeWatchdog = nodeWatchdog;
}

async function scrapeOnce(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const w = window as unknown as { __renateScrapeRoster?: () => string[] };
      return w.__renateScrapeRoster ? w.__renateScrapeRoster() : [];
    })
    .catch(() => [] as string[]);
}

async function openPanel(page: Page): Promise<boolean> {
  const handles = await page
    .locator(selectors.peoplePanelButton)
    .elementHandles()
    .catch(() => []);
  let clicked = false;
  for (const h of handles) {
    const visible = await h.isVisible().catch(() => false);
    if (!visible) continue;
    await h.click({ timeout: 2_000 }).catch(() => {});
    clicked = true;
    break;
  }
  for (const h of handles) await h.dispose().catch(() => {});
  if (!clicked) return false;

  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const count = await page
      .locator(selectors.peoplePanelRosterItem)
      .count()
      .catch(() => 0);
    if (count > 0) return true;
    await page.waitForTimeout(POLL_MS);
  }
  return false;
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function isBotName(candidate: string, botName: string): boolean {
  const c = candidate.toLowerCase();
  if (c === "you" || c.startsWith("you ") || c.endsWith(" (you)")) return true;
  return c === botName.toLowerCase();
}

function safeParse(s: string): string[] {
  try {
    const j = JSON.parse(s);
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}
