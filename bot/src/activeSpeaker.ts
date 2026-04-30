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

const REPORT_DEBOUNCE_MS = 150;
const SNAPSHOT_TIMEOUT_MS = 30_000;

/**
 * Watch Meet's main grid for the currently-speaking tile. Primary signal
 * is the `data-audio-level` attribute on each tile (semantic; survives
 * Meet's CSS-class rotation per Vexa's reverse-engineering reports). We
 * read the speaker's name straight off the tile's
 * `data-requested-participant-id` and the in-tile name label, with a
 * fallback to obfuscated speaking-class tokens.
 *
 * Implementation: a single MutationObserver on the stage's subtree with
 * `attributeFilter: ['data-audio-level']`. Far fewer wake-ups than the
 * old 200 ms setInterval, and sub-100 ms latency between Meet flipping
 * the tile and us pushing the event.
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
    ({ stageSel, tileSel, fallbackTileSel, nameSel, debounceMs, snapshotTimeoutMs }) => {
      function clean(s: string | null | undefined): string {
        return (s ?? "").replace(/\s+/g, " ").trim();
      }
      function isNoise(s: string): boolean {
        if (!s) return true;
        if (s.length > 60) return true;
        if (/^(you|me|presenting|muted|unmuted)$/i.test(s)) return true;
        if (/^\d{1,2}:\d{2}/.test(s)) return true;
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

      function tilesForRoster(stage: Element): Element[] {
        const audioTiles = Array.from(stage.querySelectorAll(tileSel));
        if (audioTiles.length) return audioTiles as Element[];
        return Array.from(stage.querySelectorAll(fallbackTileSel)) as Element[];
      }

      function rosterIdLookup(stage: Element): Map<string, string> {
        // Build a (participantId → name) map from the People-panel rows
        // injected by peoplePanel.ts. The panel's roster items expose
        // `data-participant-id`; tiles expose
        // `data-requested-participant-id` with the same id, so we can
        // canonicalize without scraping the tile's name label.
        const map = new Map<string, string>();
        const rows = document.querySelectorAll('[data-participant-id]');
        rows.forEach((el) => {
          const pid = el.getAttribute("data-participant-id");
          if (!pid) return;
          const aria = clean(el.getAttribute("aria-label"));
          if (aria && !isNoise(aria) && aria.split(/\s+/).length <= 5) {
            map.set(pid, aria);
            return;
          }
          const span = el.querySelector("span");
          const t = clean(span?.textContent ?? "");
          if (t && !isNoise(t)) map.set(pid, t);
        });
        return map;
      }

      function isSpeaking(tile: Element): boolean {
        const lvl = tile.getAttribute("data-audio-level");
        if (lvl !== null) {
          const n = Number(lvl);
          if (Number.isFinite(n) && n > 0) return true;
          return false;
        }
        // Fallback: speaking class tokens (Meet's obfuscated names).
        const cls = (tile.getAttribute("class") ?? "").toLowerCase();
        return /\b(oaajhc|hx2h7|weslmd|ogvli|active|is-active|_active|--active)\b/.test(cls);
      }

      function nameForTile(tile: Element, lookup: Map<string, string>): string {
        const reqPid = tile.getAttribute("data-requested-participant-id")
          ?? tile.getAttribute("data-participant-id");
        if (reqPid) {
          const fromRoster = lookup.get(reqPid);
          if (fromRoster) return fromRoster;
        }
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
        return "";
      }

      let lastName = "";
      let lastEmitMs = 0;
      let snapshotDeadline = Date.now() + snapshotTimeoutMs;

      function emitFor(stage: Element) {
        const lookup = rosterIdLookup(stage);
        const tiles = tilesForRoster(stage);
        let speaker: Element | null = null;
        for (const t of tiles) {
          if (isSpeaking(t)) {
            speaker = t;
            break;
          }
        }
        if (!speaker) {
          if (Date.now() > snapshotDeadline) {
            snapshotDeadline = Date.now() + snapshotTimeoutMs;
            const w = window as unknown as {
              __renateDumpActiveSpeakerSnapshot?: (s: unknown) => Promise<void>;
            };
            if (w.__renateDumpActiveSpeakerSnapshot) {
              void w.__renateDumpActiveSpeakerSnapshot({
                tileSel,
                fallbackTileSel,
                tilesObserved: tiles.length,
                sampleTiles: tiles
                  .slice(0, 3)
                  .map((t) => (t as HTMLElement).outerHTML.slice(0, 400)),
              });
            }
          }
          return;
        }
        const name = nameForTile(speaker, lookup);
        if (!name) return;
        const now = Date.now();
        if (name === lastName && now - lastEmitMs < debounceMs) return;
        lastName = name;
        lastEmitMs = now;
        const w = window as unknown as {
          __renatePushActiveSpeaker?: (ev: unknown) => Promise<void>;
        };
        if (w.__renatePushActiveSpeaker) {
          void w.__renatePushActiveSpeaker({ tMs: now, name });
        }
      }

      function attach(stage: Element) {
        // Initial sweep so we don't wait for the first attribute mutation.
        emitFor(stage);
        const obs = new MutationObserver(() => emitFor(stage));
        obs.observe(stage, {
          attributes: true,
          attributeFilter: ["data-audio-level", "class"],
          subtree: true,
          childList: true,
        });
        (window as unknown as { __renateActiveSpeakerObserver?: MutationObserver })
          .__renateActiveSpeakerObserver = obs;
      }

      const existing = findStage();
      if (existing && existing !== document.body) {
        attach(existing);
        return;
      }
      // Stage hasn't rendered yet; poll briefly and attach.
      const poll = setInterval(() => {
        const s = findStage();
        if (s && s !== document.body) {
          clearInterval(poll);
          attach(s);
        }
      }, 500);
      (window as unknown as { __renateActiveSpeakerPoll?: ReturnType<typeof setInterval> })
        .__renateActiveSpeakerPoll = poll;
    },
    {
      stageSel: selectors.activeStageContainer,
      tileSel: selectors.activeTileCandidates,
      fallbackTileSel: selectors.activeTileFallback,
      nameSel: selectors.activeTileNameLabel,
      debounceMs: REPORT_DEBOUNCE_MS,
      snapshotTimeoutMs: SNAPSHOT_TIMEOUT_MS,
    }
  );

  log.info({ debounceMs: REPORT_DEBOUNCE_MS }, "active-speaker observer attached");

  return {
    async stop() {
      await page
        .evaluate(() => {
          const w = window as unknown as {
            __renateActiveSpeakerObserver?: MutationObserver;
            __renateActiveSpeakerPoll?: ReturnType<typeof setInterval>;
          };
          w.__renateActiveSpeakerObserver?.disconnect();
          if (w.__renateActiveSpeakerPoll) clearInterval(w.__renateActiveSpeakerPoll);
        })
        .catch(() => {});
      log.info({ count }, "active-speaker observer stopped");
    },
    emitted: () => count,
  };
}
