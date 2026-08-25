/**
 * Accept only `#rgb` / `#rrggbb`. A stored `url(...)` (or any other CSS)
 * must not become `style.background`.
 *
 * Kept out of `profile-view.ts` so the toolbar popup can sanitise swatches
 * without pulling `@switchydelta/pac` onto its static import graph.
 */
export function sanitizeHexColor(color: string | undefined | null): string | undefined {
  if (!color) return undefined;
  const raw = color.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(raw);
  if (short) {
    const [r, g, b] = short[1]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(raw);
  if (full) return `#${full[1]!}`.toLowerCase();
  return undefined;
}
