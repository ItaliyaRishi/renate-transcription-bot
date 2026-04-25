import type { Page } from "playwright";
import pino from "pino";
import { selectors } from "./selectors.js";

const log = pino({ name: "bot.activeSpeaker", level: process.env.LOG_LEVEL ?? "info" });

export interface ActiveSpeakerEvent {
  tMs: number;
  name: string;
}

export type ActiveSpeakerSink = (ev: ActiveSpeakerEvent) => void | Promise<void>;

export interface ActiveSpeakerHandle {
  stop(): Promise<void>;
  emitted(): number;
}

const POLL_MS = 200;

/**
 * Poll the Meet DOM at 5 Hz for the active-speaker tile. Meet highlights
 * the currently-speaking tile visually regardless of whether its own ASR
 * fires — crucial for Hindi / code-switch spans where the caption stream
 * is silent but audio is live.
 *
 * Strategies tried in order (cheapest first):
 *   1. element with `data-active-speaker="true"` inside the stage
 *   2. tile whose border/outline/boxShadow is Meet accent blue
 *   3. first tile whose class list contains an "active" token
 */
export async function startActiveSpeakerPoller(
  page: Page,
  sink: ActiveSpeakerSink
): Promise<ActiveSpeakerHandle> {
  let count = 0;
  let dumpedSnapshot = false;

  await page.exposeBinding("__renatePushActiveSpeaker", async (_src, payload) => {
    try {
      const ev = payload as ActiveSpeakerEvent;
      if (!ev || !ev.name) return;
      count++;
      await sink(ev);
    } catch (err) {
      log.error({ err }, "active-speaker sink failed");
    }
  });

  await page.exposeBinding("__renateDumpActiveSpeakerSnapshot", async (_src, payload) => {
    if (dumpedSnapshot) return;
    dumpedSnapshot = true;
    log.info({ activeSpeakerSnapshot: payload }, "active-speaker snapshot");
  });

  await page.evaluate(
    ({ stageSel, tileSel, nameSel, pollMs }) => {
      // Heuristic for Meet's accent blue (≈ rgb(11, 87, 208) / #0b57d0).
      // Tolerates minor shade drift across Meet themes.
      function isAccentBlue(val: string): boolean {
        const m = val.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (!m) return false;
        const r = Number(m[1]);
        const g = Number(m[2]);
        const b = Number(m[3]);
        return b > 150 && b > r + 50 && b > g + 40;
      }

      function clean(s: string | null | undefined): string {
        return (s ?? "").replace(/\s+/g, " ").trim();
      }

      function isNoise(s: string): boolean {
        if (!s) return true;
        if (s.length > 60) return true;
        if (/^(you|me|presenting|muted|unmuted)$/i.test(s)) return true;
        if (/^\d{1,2}:\d{2}/.test(s)) return true; // call-duration ticker
        if (!/[a-z]/i.test(s)) return true;
        return false;
      }

      function findStage(): Element {
        for (const sel of stageSel.split(",").map((x: string) => x.trim())) {
          const el = document.querySelector(sel);
          if (el) return el;
        }
        return document.body;
      }

      function findActiveTile(stage: Element): Element | null {
        // Strategy 1: explicit attribute, if Meet ever exposes it.
        const explicit = stage.querySelector('[data-active-speaker="true"]');
        if (explicit) return explicit;

        const tiles = Array.from(stage.querySelectorAll(tileSel));

        // Strategy 2: accent-blue border/outline/boxShadow.
        for (const t of tiles) {
          const s = window.getComputedStyle(t as Element);
          const concat = [
            s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor,
            s.outlineColor, s.boxShadow,
          ].join(" ");
          if (isAccentBlue(concat)) return t;
        }

        // Strategy 3: "active"-suffixed class token.
        for (const t of tiles) {
          const cls = (t.getAttribute("class") ?? "").toLowerCase();
          if (/\bactive\b|is-active|_active|--active/.test(cls)) return t;
        }
        return null;
      }

      function extractName(tile: Element): string {
        const self = tile.getAttribute("data-self-name");
        if (self && !isNoise(self)) return clean(self);
        const aria = tile.getAttribute("aria-label");
        if (aria && !isNoise(aria)) return clean(aria);

        const candidates: string[] = [];
        for (const node of Array.from(tile.querySelectorAll(nameSel))) {
          const t = clean((node as HTMLElement).textContent);
          if (!t || isNoise(t)) continue;
          candidates.push(t);
        }
        if (candidates.length) {
          candidates.sort((a, b) => a.length - b.length);
          return candidates[0];
        }
        const raw = clean(tile.textContent);
        if (!isNoise(raw)) {
          const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
          lines.sort((a, b) => a.length - b.length);
          if (lines[0] && !isNoise(lines[0])) return lines[0];
        }
        return "";
      }

      let lastName = "";
      let firstMissLogged = false;

      const tick = () => {
        try {
          const stage = findStage();
          const tile = findActiveTile(stage);
          if (!tile) {
            if (!firstMissLogged) {
              firstMissLogged = true;
              const w = window as unknown as {
                __renateDumpActiveSpeakerSnapshot?: (s: unknown) => Promise<void>;
              };
              if (w.__renateDumpActiveSpeakerSnapshot) {
                const sample = Array.from(stage.querySelectorAll(tileSel))
                  .slice(0, 3)
                  .map((t) => (t as HTMLElement).outerHTML.slice(0, 400));
                void w.__renateDumpActiveSpeakerSnapshot({
                  tileSel,
                  sampleTiles: sample,
                });
              }
            }
            return;
          }
          const name = extractName(tile);
          if (!name || name === lastName) return;
          lastName = name;
          const w = window as unknown as {
            __renatePushActiveSpeaker?: (ev: unknown) => Promise<void>;
          };
          if (w.__renatePushActiveSpeaker) {
            void w.__renatePushActiveSpeaker({ tMs: Date.now(), name });
          }
        } catch {
          // The Meet DOM can briefly tear between renders; a single failed
          // tick is fine — the next 200ms will retry.
        }
      };

      const timer = setInterval(tick, pollMs);
      (window as unknown as { __renateActiveSpeakerTimer?: ReturnType<typeof setInterval> })
        .__renateActiveSpeakerTimer = timer;
    },
    {
      stageSel: selectors.activeStageContainer,
      tileSel: selectors.activeTileCandidates,
      nameSel: selectors.activeTileNameLabel,
      pollMs: POLL_MS,
    }
  );

  log.info({ pollMs: POLL_MS }, "active-speaker poller attached");

  return {
    async stop() {
      await page
        .evaluate(() => {
          const w = window as unknown as {
            __renateActiveSpeakerTimer?: ReturnType<typeof setInterval>;
          };
          if (w.__renateActiveSpeakerTimer) clearInterval(w.__renateActiveSpeakerTimer);
        })
        .catch(() => {});
      log.info({ count }, "active-speaker poller stopped");
    },
    emitted: () => count,
  };
}
