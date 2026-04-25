import type { Page } from "playwright";
import pino from "pino";
import { selectors } from "./selectors.js";

const log = pino({ name: "bot.captions", level: process.env.LOG_LEVEL ?? "info" });

export interface DomCaption {
  speaker: string;
  text: string;
  tStart: number;
  tEnd: number;
}

export type CaptionSink = (c: DomCaption) => void | Promise<void>;

export interface CaptionObserverHandle {
  stop(): Promise<void>;
  received(): number;
}

export async function attachCaptionObserver(
  page: Page,
  sink: CaptionSink
): Promise<CaptionObserverHandle> {
  let count = 0;
  let dumpedFirstHtml = false;

  await page.exposeBinding("__renatePushCaption", async (_src, payload) => {
    try {
      const c = payload as DomCaption;
      if (!c || !c.text) return;
      count++;
      await sink(c);
    } catch (err) {
      log.error({ err }, "caption sink failed");
    }
  });

  await page.exposeBinding("__renateDumpFirstCaptionDom", async (_src, payload) => {
    if (dumpedFirstHtml) return;
    dumpedFirstHtml = true;
    log.info({ firstCaptionDom: String(payload) }, "first-caption-dom");
  });

  await enableCaptions(page);

  await page.evaluate(
    ({ containerSel, speakerBadgeSel, textNodeSel }) => {
      type Tracked = { speaker: string; lastText: string; lastAt: number };
      const seen = new WeakMap<Element, Tracked>();

      // Recall.ai's carry-forward pattern: continuation rows may omit the
      // speaker badge, so we remember the most-recently-named speaker and
      // attribute unbadged rows to them.
      let lastNamedSpeaker = "";
      let sentFirstHtml = false;

      // Skip screen-reader-only / hidden a11y announcer divs — they have
      // `aria-live` but aren't the real caption area.
      function isA11yAnnouncer(el: Element): boolean {
        if (el.getAttribute("data-mdc-dom-announce") !== null) return true;
        const style = (el as HTMLElement).style;
        if (
          style &&
          (style.position === "absolute" && (style.top === "-9999px" || style.left === "-9999px"))
        ) {
          return true;
        }
        const rect = (el as HTMLElement).getBoundingClientRect?.();
        if (rect && rect.width <= 1 && rect.height <= 1) return true;
        return false;
      }

      function findContainer(): Element | null {
        // 1) Prefer a container that actually holds caption rows — i.e.
        //    contains a speaker-badge element. Walk up from the badge.
        const badge = document.querySelector(speakerBadgeSel);
        if (badge) {
          // The caption container is a few ancestors up from a badge.
          // Walk up until we find an element with several children
          // (real caption rows accumulate siblings).
          let cur: Element | null = badge.parentElement;
          for (let i = 0; i < 8 && cur; i++) {
            if (cur.children.length >= 1 && !isA11yAnnouncer(cur)) {
              // Bubble up a bit more to land on the row-list parent.
              if (cur.parentElement && cur.parentElement.children.length >= 1
                  && !isA11yAnnouncer(cur.parentElement)) {
                return cur.parentElement;
              }
              return cur;
            }
            cur = cur.parentElement;
          }
        }
        // 2) Specific Meet selectors.
        for (const sel of containerSel.split(",").map((s: string) => s.trim())) {
          const el = document.querySelector(sel);
          if (el && !isA11yAnnouncer(el)) return el;
        }
        return null;
      }

      function extract(row: Element): { speaker: string; text: string } | null {
        const badge = row.querySelector(speakerBadgeSel);
        const textEl = row.querySelector(textNodeSel);

        const badgeName = (badge?.textContent ?? "").trim();
        // Text fallback chain: documented selectors → any <span> → raw row.
        const text = (
          (textEl?.textContent ?? "").trim()
          || (row.querySelector("span")?.textContent ?? "").trim()
          || (row.textContent ?? "").replace(badgeName, "").trim()
        );
        if (!text) return null;

        if (badgeName) lastNamedSpeaker = badgeName;
        const speaker = badgeName || lastNamedSpeaker || "Unknown";
        return { speaker, text };
      }

      function emit(row: Element) {
        const extracted = extract(row);
        if (!extracted) return;

        const prev = seen.get(row);
        const now = Date.now();
        if (prev && prev.lastText === extracted.text) return;

        const tStart = prev ? prev.lastAt : now;
        seen.set(row, {
          speaker: extracted.speaker,
          lastText: extracted.text,
          lastAt: now,
        });

        const w = window as unknown as {
          __renatePushCaption?: (c: unknown) => Promise<void>;
          __renateDumpFirstCaptionDom?: (html: string) => Promise<void>;
        };

        if (!sentFirstHtml && w.__renateDumpFirstCaptionDom) {
          sentFirstHtml = true;
          try { void w.__renateDumpFirstCaptionDom(row.outerHTML.slice(0, 4000)); } catch {}
        }

        if (w.__renatePushCaption) {
          void w.__renatePushCaption({
            speaker: extracted.speaker,
            text: extracted.text,
            tStart,
            tEnd: now,
          });
        }
      }

      // A caption row must live under the caption-badge subtree — anything
      // else is UI chrome (the floating "Jump to bottom" button, reaction
      // toasts, etc.) that also fires mutations. Cheapest rejection: walk
      // ancestors and bail out if we hit a role="button" before the badge.
      function isUiChrome(el: Element, boundary: Element): boolean {
        let cur: Element | null = el;
        while (cur && cur !== boundary) {
          if (cur.getAttribute("role") === "button") return true;
          cur = cur.parentElement;
        }
        return false;
      }

      function attach(container: Element) {
        for (const child of Array.from(container.children)) emit(child);

        const obs = new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.target instanceof Element) {
              if (isUiChrome(m.target, container)) continue;
              const row =
                m.target.closest('[role="listitem"]') ??
                (m.target.parentElement?.closest('[role="listitem"]') as Element | null) ??
                m.target;
              if (row instanceof Element) emit(row);
            }
            for (const node of Array.from(m.addedNodes)) {
              if (node instanceof Element && !isUiChrome(node, container)) emit(node);
            }
          }
        });
        obs.observe(container, {
          subtree: true,
          childList: true,
          characterData: true,
        });
        (window as unknown as { __renateCaptionObserver?: MutationObserver })
          .__renateCaptionObserver = obs;
      }

      const existing = findContainer();
      if (existing) {
        attach(existing);
        return;
      }

      // Container hasn't rendered yet; poll and attach as soon as it shows.
      const poll = setInterval(() => {
        const c = findContainer();
        if (c) {
          clearInterval(poll);
          attach(c);
        }
      }, 500);
      (window as unknown as { __renateCaptionPoll?: ReturnType<typeof setInterval> })
        .__renateCaptionPoll = poll;
    },
    {
      containerSel: selectors.captionsContainer,
      speakerBadgeSel: selectors.captionSpeakerBadge,
      textNodeSel: selectors.captionTextNode,
    }
  );

  log.info("caption observer attached");

  return {
    async stop() {
      await page
        .evaluate(() => {
          const w = window as unknown as {
            __renateCaptionObserver?: MutationObserver;
            __renateCaptionPoll?: ReturnType<typeof setInterval>;
          };
          w.__renateCaptionObserver?.disconnect();
          if (w.__renateCaptionPoll) clearInterval(w.__renateCaptionPoll);
        })
        .catch(() => {});
      log.info({ count }, "caption observer stopped");
    },
    received: () => count,
  };
}

async function enableCaptions(page: Page): Promise<void> {
  // Enable captions deterministically: find the toggle button by aria-label,
  // click it if it says "Turn on captions", then VERIFY the caption container
  // actually renders. Retry up to 3× with 3s backoff. No keyboard fallback —
  // the global 'c' shortcut silently no-ops when the meeting view doesn't
  // have keyboard focus (which is almost always in a just-joined Playwright
  // page) and masks failures.
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = 3_000;
  const VERIFY_TIMEOUT_MS = 10_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await page.waitForTimeout(BACKOFF_MS);

    // Meet auto-hides the bottom toolbar after ~3s of no mouse movement.
    // Headful Chromium via Playwright rarely generates synthetic mouse
    // events, so the CC button stays hidden and our selector misses. Nudge
    // the mouse into the meeting canvas to force the toolbar to render.
    await revealToolbar(page).catch(() => {});

    const candidates = await page
      .locator(selectors.captionsToggleButton)
      .elementHandles()
      .catch(() => []);

    let clicked: string | null = null;
    let alreadyOn: string | null = null;

    for (const handle of candidates) {
      const aria = ((await handle.getAttribute("aria-label").catch(() => null)) ?? "").trim();
      if (/^turn off captions$/i.test(aria)) {
        alreadyOn = aria;
        break;
      }
      if (/^turn on captions$/i.test(aria)) {
        const visible = await handle.isVisible().catch(() => false);
        if (!visible) continue;
        await handle.click({ timeout: 2_000 }).catch(() => {});
        clicked = aria;
        break;
      }
    }
    for (const h of candidates) await h.dispose().catch(() => {});

    if (alreadyOn) {
      log.info({ attempt, aria: alreadyOn }, "captions already on");
      return;
    }

    if (clicked) {
      const verified = await verifyCaptionsOn(page, VERIFY_TIMEOUT_MS);
      if (verified) {
        log.info({ attempt, aria: clicked }, "captions enabled (verified)");
        return;
      }
      log.warn({ attempt, aria: clicked }, "captions clicked but container not rendered; retrying");
      continue;
    }

    log.warn({ attempt }, "captions toggle button not found; retrying");
  }

  log.error(
    { attempts: MAX_ATTEMPTS },
    "captions enablement FAILED: toggle not found or container never rendered — downstream name attribution will fall back to roster"
  );
}

// Meet hides the bottom toolbar (CC toggle, mic, cam, leave) after a few
// seconds of no mouse activity. We jiggle the cursor across the viewport
// center + bottom to force the toolbar to fade back in before we search
// for the captions button.
async function revealToolbar(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) return;
  const cx = Math.floor(viewport.width / 2);
  const cy = Math.floor(viewport.height / 2);
  const by = viewport.height - 40; // just above the toolbar strip
  // Two small movements guarantee a mousemove event fires regardless of
  // the previous cursor position.
  await page.mouse.move(cx, cy, { steps: 5 });
  await page.mouse.move(cx, by, { steps: 10 });
  await page.waitForTimeout(500);
}

// Resolve when either the toggle flips to "Turn off captions" OR the caption
// container shows up in the DOM. Either proves captions are on.
async function verifyCaptionsOn(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const flipped = await page
      .locator(selectors.captionsToggleButton)
      .evaluateAll((els) =>
        els.some((el) => {
          const aria = (el.getAttribute("aria-label") ?? "").trim();
          return /^turn off captions$/i.test(aria);
        })
      )
      .catch(() => false);
    if (flipped) return true;

    const containerRendered = await page
      .evaluate((sel: string) => {
        for (const s of sel.split(",").map((x) => x.trim())) {
          if (document.querySelector(s)) return true;
        }
        return false;
      }, selectors.captionsContainer)
      .catch(() => false);
    if (containerRendered) return true;

    await page.waitForTimeout(250);
  }
  return false;
}
