/**
 * The toolbar action icon, tinted with the current profile's colour.
 *
 * Redraws the delta mark from icon.svg on an OffscreenCanvas: the profile
 * colour fills the rounded square and the white delta outline sits on top,
 * so the icon both brands the extension and shows which profile is active —
 * the same job the original's dynamically drawn omega icon did.
 *
 * With an auto switch active the icon carries two colours: the matched
 * profile fills the square and the switch profile's own colour rings its
 * boundary, so the icon says both "auto switch is on" and "this is where
 * the current tab goes".
 */

const SIZES = [16, 24, 32];

export async function setActionIcon(color: string, borderColor?: string): Promise<void> {
  const imageData: Record<number, ImageData> = {};
  for (const size of SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const scale = size / 128;

    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, 26 * scale);
    ctx.fillStyle = color;
    ctx.fill();

    if (borderColor && borderColor !== color) {
      // Stroke centred on an inset path, so its outer edge lands exactly on
      // the square's edge and nothing bleeds outside the rounded silhouette.
      const border = Math.max(1.5, 14 * scale);
      ctx.beginPath();
      ctx.roundRect(
        border / 2,
        border / 2,
        size - border,
        size - border,
        Math.max(1, 26 * scale - border / 2),
      );
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = border;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(64 * scale, 31 * scale);
    ctx.lineTo(99 * scale, 95 * scale);
    ctx.lineTo(29 * scale, 95 * scale);
    ctx.closePath();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, 13 * scale);
    ctx.lineJoin = 'round';
    ctx.stroke();

    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  await chrome.action.setIcon({ imageData });
}

/** The red "=" badge the original showed when proxy control is lost. */
export function setControlLostBadge(): void {
  void chrome.action.setBadgeText({ text: '=' });
  void chrome.action.setBadgeBackgroundColor({ color: '#da4f49' });
}

export function clearBadge(): void {
  void chrome.action.setBadgeText({ text: '' });
}
