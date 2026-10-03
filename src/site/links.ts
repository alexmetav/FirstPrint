/**
 * The public website links to the browser-only practice build at /play/. Where the full app (real
 * accounts and points) is available, those links point at it instead. Only links with a known label
 * are rewritten, so a new link is never pointed somewhere by accident. Used by the Vercel build
 * (APP_URL) and by the app server, which serves the website at / and the app at /app/.
 */
const LABELS: [string, string][] = [
  ['>Launch app<', '>Launch app<'],
  ['>Markets<', '>Markets<'],
];

/** Rewrites every /play/ link in a website file to `appHref` (no trailing slash, e.g. "/app" or "https://…"). */
export function linkSiteToApp(text: string, appHref: string, file = 'site file'): string {
  let out = text;
  for (const [from, to] of LABELS) out = out.replaceAll(`href="/play/"${from}`, `href="${appHref}/"${to}`);
  if (out.includes('href="/play/"')) throw new Error(`${file} has a /play/ link with an unexpected label; add it to src/site/links.ts.`);
  return out;
}
