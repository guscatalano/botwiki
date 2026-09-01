// Shared design tokens. The page views and the graph view both draw from these,
// so the two never drift apart.

export const TOKENS = `
:root{
  --bg:#fbfbf9;--panel:#fff;--ink:#1b1b1a;--muted:#6b6b66;--line:#e4e3dd;
  --accent:#7c5cff;--accent-soft:#efeaff;--code:#f4f3ef;--warn:#b4531f;
  --g-root:#7c5cff;--g-hosts:#2f8f6f;--g-services:#c2643a;--g-runbooks:#3b74c4;
  --g-meta:#8a8a84;--g-decisions:#a8478c;--g-scratch:#9a8f5c;
  --edge:#cfcec7;--edge-similar:#dedcd4;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#131315;--panel:#1a1a1d;--ink:#e9e8e4;--muted:#9a988f;--line:#2c2c30;
  --accent:#a99bff;--accent-soft:#252140;--code:#202024;--warn:#e0925c;
  --g-root:#a99bff;--g-hosts:#4fc49b;--g-services:#e89466;--g-runbooks:#6ba3e8;
  --g-meta:#a3a19a;--g-decisions:#d97ab8;--g-scratch:#c4b478;
  --edge:#3a3a3f;--edge-similar:#2e2e33;
  color-scheme:dark;
}}
`;

// Canvas cannot read CSS variables, so the graph reads these through
// getComputedStyle at paint time. Keep the keys in step with the tokens above.
export const GROUP_VARS = [
  'root',
  'hosts',
  'services',
  'runbooks',
  'meta',
  'decisions',
  'scratch',
];
