import { writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import pino from "pino";

const log = pino({ name: "bot.debug", level: process.env.LOG_LEVEL ?? "info" });

/**
 * One-shot DOM diagnostic. Captures enough information about the live Meet
 * to identify current speaker-tile selectors without guessing from old blog
 * posts. Writes JSON to `outPath` (default: /chunks/debug_dom.json).
 *
 * Safe to call mid-call — it's read-only from the page's perspective.
 */
export async function dumpMeetDom(
  page: Page,
  outPath = "/chunks/debug_dom.json"
): Promise<void> {
  try {
    const [pageSnapshot, a11yTree] = await Promise.all([
      page.evaluate(() => collectDomEvidence()),
      page.accessibility.snapshot({ interestingOnly: false }).catch(() => null),
    ]);

    const payload = {
      collectedAt: new Date().toISOString(),
      url: page.url(),
      a11yTree,
      ...pageSnapshot,
    };

    await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
    log.info(
      {
        outPath,
        mediaElementCount: pageSnapshot.mediaElements.length,
        tileCandidateCount: pageSnapshot.tileCandidates.length,
      },
      "dumpMeetDom: wrote diagnostic"
    );
  } catch (err) {
    log.error({ err }, "dumpMeetDom failed");
  }
}

// This function is serialized into the page context by page.evaluate,
// so it must be fully self-contained (no imports, no closures from outside).
function collectDomEvidence(): {
  mediaElements: Array<{
    tag: string;
    id: string;
    className: string;
    hasSrcObject: boolean;
    paused: boolean;
    muted: boolean;
    audioTracks: number;
    videoTracks: number;
    ancestorChain: string[];
    nearestTileHtml: string;
    nearestTileText: string;
  }>;
  tileCandidates: Array<{
    selector: string;
    count: number;
    samples: string[]; // first 3 outerHTML snippets, capped
  }>;
  interestingAttrs: Array<{
    attr: string;
    sampleElements: Array<{ tag: string; value: string; textSnippet: string }>;
  }>;
  bodyClassSnippet: string;
} {
  function truncate(s: string | null | undefined, n: number): string {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function describe(el: Element): string {
    const cls = el.getAttribute("class") ?? "";
    const jsname = el.getAttribute("jsname") ?? "";
    const role = el.getAttribute("role") ?? "";
    const parts = [el.tagName.toLowerCase()];
    if (jsname) parts.push(`[jsname="${jsname}"]`);
    if (role) parts.push(`[role="${role}"]`);
    if (cls) {
      const first = cls.split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      if (first) parts.push(`.${first}`);
    }
    return parts.join("");
  }

  function ancestorChain(el: Element, depth = 6): string[] {
    const chain: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; i < depth && cur; i++) {
      chain.push(describe(cur));
      cur = cur.parentElement;
    }
    return chain;
  }

  function nearestTile(el: Element): Element | null {
    // Walk up until we find a div with a visible, short text node (the name)
    // that is NOT the element itself, and which contains this element.
    let cur: Element | null = el.parentElement;
    for (let i = 0; i < 8 && cur; i++) {
      const text = (cur.textContent ?? "").trim();
      if (text.length >= 2 && text.length <= 80) return cur;
      cur = cur.parentElement;
    }
    return el.parentElement;
  }

  const mediaEls = Array.from(
    document.querySelectorAll<HTMLMediaElement>("audio, video")
  );
  const mediaElements = mediaEls.map((el) => {
    const stream = (el as HTMLMediaElement).srcObject as MediaStream | null;
    const tile = nearestTile(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      className: truncate(el.className, 200),
      hasSrcObject: Boolean(stream),
      paused: (el as HTMLMediaElement).paused,
      muted: (el as HTMLMediaElement).muted,
      audioTracks: stream ? stream.getAudioTracks().length : 0,
      videoTracks: stream ? stream.getVideoTracks().length : 0,
      ancestorChain: ancestorChain(el),
      nearestTileHtml: tile ? truncate(tile.outerHTML, 1500) : "",
      nearestTileText: tile ? truncate((tile.textContent ?? "").trim(), 200) : "",
    };
  });

  const candidateSelectors = [
    "[data-participant-id]",
    "[data-self-name]",
    "[data-allocation-index]",
    "[data-requested-participant-id]",
    "[jsname]",
    '[role="listitem"]',
    '[aria-label*="aptions" i]',
    '[aria-label*="Main menu" i]',
    "div:has(> video)",
    "div:has(> audio)",
  ];

  const tileCandidates = candidateSelectors.map((sel) => {
    let matches: Element[] = [];
    try {
      matches = Array.from(document.querySelectorAll(sel));
    } catch {
      return { selector: sel, count: -1, samples: [] };
    }
    return {
      selector: sel,
      count: matches.length,
      samples: matches.slice(0, 3).map((m) => truncate(m.outerHTML, 800)),
    };
  });

  const attrsOfInterest = [
    "data-self-name",
    "data-participant-id",
    "data-allocation-index",
    "data-requested-participant-id",
  ];
  const interestingAttrs = attrsOfInterest.map((attr) => {
    const els = Array.from(document.querySelectorAll(`[${attr}]`)).slice(0, 6);
    return {
      attr,
      sampleElements: els.map((e) => ({
        tag: e.tagName.toLowerCase(),
        value: e.getAttribute(attr) ?? "",
        textSnippet: truncate((e.textContent ?? "").trim(), 120),
      })),
    };
  });

  return {
    mediaElements,
    tileCandidates,
    interestingAttrs,
    bodyClassSnippet: truncate(document.body.className, 300),
  };
}
