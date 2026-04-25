import type { Page } from "playwright";
import pino from "pino";
import { selectors } from "./selectors.js";

const log = pino({ name: "bot.peoplePanel", level: process.env.LOG_LEVEL ?? "info" });

const OPEN_TIMEOUT_MS = 10_000;
const POLL_MS = 250;

export async function scrapeRoster(page: Page, botName: string): Promise<string[]> {
  const opened = await openPanel(page);
  if (!opened) {
    log.warn("people panel did not open");
    return [];
  }

  const names = await extractNames(page);
  await closePanel(page).catch(() => {});

  const filtered = dedupe(names.map((n) => n.trim()).filter(Boolean))
    .filter((n) => !isBotName(n, botName));
  return filtered;
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

async function extractNames(page: Page): Promise<string[]> {
  return page
    .evaluate((sel: string) => {
      // aria-label on the [role="listitem"] in modern Meet is polluted:
      //   "keep_outlinePin <Name> to your main screen…<Name> <Name> devices"
      // Strategy:
      //   1. Prefer an inner <span> whose text is a plausible human name
      //      (non-empty, no icon ligatures, not starting with "keep_outline"
      //      or other Material-icon glyphs).
      //   2. If multiple spans match, pick the shortest non-empty one —
      //      it's almost always the name (vs menu-button labels).
      //   3. Fall back to the longest repeated substring in the aria-label
      //      (the real name appears 2-3× in the polluted label).
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
        // must contain at least one letter
        if (!/[a-z]/i.test(s)) return false;
        return true;
      };

      // Scope to the participants-panel container when we can find it.
      // Without this, a listitem inside a tile's "⋮" action sub-menu
      // ("Remove this tile") leaks into the roster.
      function findPanel(): ParentNode {
        const byAria = document.querySelector(
          '[aria-label*="articipants" i][role], [aria-label*="eople" i][role]'
        );
        if (byAria) return byAria;
        const complementary = document.querySelector('[role="complementary"]');
        if (complementary) return complementary;
        return document;
      }
      const scope = findPanel();

      const isActionMenuItem = (el: Element): boolean => {
        if (el.getAttribute("role") === "menuitem") return true;
        return el.closest('[role="menu"]') !== null;
      };

      const out: string[] = [];
      const items = scope.querySelectorAll(sel);
      // Spans inside a button / role=button are action-button labels (e.g.
      // "Show in a tile", "Pin to your screen") — never the participant's
      // display name. Skip them so action labels don't end up in the roster.
      const isInsideButton = (el: Element): boolean => {
        return el.closest('button, [role="button"]') !== null;
      };
      items.forEach((el) => {
        if (isActionMenuItem(el)) return;
        // 1) Best: find a clean inner span that isn't inside a button.
        const spans = Array.from(el.querySelectorAll("span"))
          .filter((s) => !isInsideButton(s));
        const candidates = spans
          .map((s) => (s.textContent ?? "").trim())
          .filter(looksLikeName);
        if (candidates.length) {
          // shortest likely = the bare name
          candidates.sort((a, b) => a.length - b.length);
          out.push(candidates[0]);
          return;
        }
        // 2) Fallback: longest repeated token run inside aria-label.
        const aria = (el.getAttribute("aria-label") ?? "").trim();
        if (aria) {
          const tokens = aria.split(/\s+/).filter(Boolean);
          const counts = new Map<string, number>();
          tokens.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
          // Find consecutive runs of repeated tokens — names repeat as
          // "Rishi Italiya Rishi Italiya" inside the polluted label.
          for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if ((counts.get(t) ?? 0) >= 2 && looksLikeName(t)) {
              // Try to greedily extend with the next repeated token.
              const next = tokens[i + 1];
              const full =
                next && (counts.get(next) ?? 0) >= 2 && looksLikeName(next)
                  ? `${t} ${next}`
                  : t;
              out.push(full);
              return;
            }
          }
          // 3) Last resort: first line of textContent.
          const text = (el.textContent ?? "").trim().split("\n")[0]?.trim() ?? "";
          if (looksLikeName(text)) out.push(text);
        }
      });
      return out;
    }, selectors.peoplePanelRosterItem)
    .catch(() => [] as string[]);
}

async function closePanel(page: Page): Promise<void> {
  const handles = await page
    .locator(selectors.peoplePanelCloseButton)
    .elementHandles()
    .catch(() => []);
  for (const h of handles) {
    const visible = await h.isVisible().catch(() => false);
    if (visible) {
      await h.click({ timeout: 1_000 }).catch(() => {});
      break;
    }
  }
  for (const h of handles) await h.dispose().catch(() => {});
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
