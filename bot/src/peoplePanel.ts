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
      const out: string[] = [];
      const items = document.querySelectorAll(sel);
      items.forEach((el) => {
        const aria = (el.getAttribute("aria-label") ?? "").trim();
        if (aria) {
          out.push(aria);
          return;
        }
        const text = (el.textContent ?? "").trim().split("\n")[0]?.trim() ?? "";
        if (text) out.push(text);
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
