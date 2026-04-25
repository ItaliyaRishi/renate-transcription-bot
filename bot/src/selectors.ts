// Single source of truth for Meet DOM selectors.
//
// Strategy: prefer aria-label / role-based locators. Meet's `jsname` and
// CSS class attributes change frequently; aria-labels are required for a11y
// and change rarely. When Google ships a UI update, only this file should
// need patching.

export const selectors = {
  // Pre-join screen — the panel shown before clicking "Join now".
  // Consumer accounts: name input visible. Workspace (our case): pre-filled.
  preJoinNameInput: 'input[aria-label="Your name"]',

  // Mic / camera toggles on the pre-join screen. aria-label includes either
  // "Turn on" or "Turn off" depending on current state; we match on the
  // device name only.
  preJoinMicToggle: '[aria-label*="microphone" i][role="button"]',
  preJoinCamToggle: '[aria-label*="camera" i][role="button"]',

  // Join button. Workspace meetings show "Join now" for invited attendees,
  // "Ask to join" for knock-to-join. We try both.
  joinNowButton: 'button:has-text("Join now")',
  askToJoinButton: 'button:has-text("Ask to join")',

  // Post-join: the persistent "Leave call" button. This is the most reliable
  // join-success signal.
  leaveCallButton: 'button[aria-label="Leave call"]',

  // End-of-call detection now goes through peoplePanelButton (below) — we
  // read the count from its aria-label without opening the side panel. The
  // previous locale-dependent text banner and narrow "people" selector
  // proved unreliable.

  // --- Captions ---
  // aria-label for the CC toggle contains "captions" (sometimes with
  // "on"/"off" prefix). Match on the substring only, case-insensitive.
  // Note: `*="aptions"` (no leading c) is intentional — covers "Turn on
  // captions" / "Turn off captions" / "Captions" equally.
  captionsToggleButton: 'button[aria-label*="aptions" i]',

  // Caption container — specific Meet selectors first. We dropped the
  // generic `[aria-live="polite"]` fallback because it matches throwaway
  // screen-reader announcer divs ("Your camera is off") before real
  // captions render. The real container is now found primarily by walking
  // up from the nearest speaker-badge element (see captions.ts).
  captionsContainer:
    '[jsname="r8qRAd"], [role="region"][aria-label*="aption" i]',

  // Speaker-name "badge" within a single caption row. Proven values from
  // Recall.ai's Meet bot; kept additional fallbacks in case Google ships
  // a rename.
  captionSpeakerBadge: '.NWpY1d, .xoMHSc, [class*="zs7s8d"]',

  // Caption text node within a row.
  captionTextNode: '.bh44bd, .VbkSUe, [jsname="tgaKEf"]',

  // --- People panel (participant roster) ---
  // Toolbar button that opens the people/participants side panel. aria-label
  // varies across Meet locales and states: "Show everyone", "People",
  // "Participants", sometimes with a count suffix. We match loosely.
  peoplePanelButton:
    'button[aria-label*="people" i], button[aria-label*="participants" i], button[aria-label*="everyone" i]',

  // Close-panel control when the side panel is open.
  peoplePanelCloseButton: 'button[aria-label*="close" i]',

  // Each roster row. Meet renders them as [role="listitem"] within the panel;
  // display name lives in a nested span. Fall back to common class names.
  peoplePanelRosterItem: '[role="listitem"][aria-label], div[data-participant-id]',

  // --- Active-speaker tile ---
  // Main-stage container that wraps the grid/speaker view. The poller scopes
  // its tile search to this to avoid picking up preview thumbnails.
  activeStageContainer:
    '[data-allocation-index], [jsname="A5il2e"], main [role="main"], [role="main"]',

  // Any element that could be a participant tile. First match wins across
  // the three strategies in `activeSpeaker.ts`; order them cheapest-first.
  activeTileCandidates:
    '[data-participant-id], [data-self-name], [data-requested-participant-id], [class*="participant-tile"]',

  // Within a tile, where the displayName label tends to live. Meet's tile
  // bottom-left shows name + mic status; the shortest non-empty text node
  // inside these matches the name robustly even as Google renames classes.
  activeTileNameLabel: '[data-self-name], [jsname*="A5il2e"] span, span',
} as const;

export type SelectorKey = keyof typeof selectors;
