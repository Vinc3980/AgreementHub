/**
 * Hash Rosette geometry and SVG rendering (pure, deterministic, no I/O).
 * Shared by the web UI and the server-side document renderer so the same
 * document hash always produces the same mark everywhere.
 */

export interface RosetteGeometry {
  petals: number;
  innerPetals: number;
  outer: number;
  inner: number;
  phase: number;
  stroke: number;
  spin: number;
}

const CACHE = new Map<string, RosetteGeometry>();

function bytesOf(input: string): number[] {
  const clean = input.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (clean.length >= 16) {
    const out: number[] = [];
    for (let i = 0; i + 1 < clean.length; i += 2) {
      out.push(parseInt(clean.slice(i, i + 2), 16));
    }
    return out;
  }
  return Array.from(input).map((c) => c.charCodeAt(0) % 256);
}

export function rosetteGeometry(hash: string): RosetteGeometry {
  const key = hash || 'unsealed';
  const cached = CACHE.get(key);
  if (cached) return cached;
  const b = bytesOf(key);
  const at = (i: number) => b[i % b.length] ?? 0;
  const geometry: RosetteGeometry = {
    petals: 10 + (at(0) % 7),
    innerPetals: 5 + (at(1) % 6),
    outer: 40 + (at(2) % 5),
    inner: 15 + (at(3) % 9),
    phase: (at(4) / 255) * Math.PI * 2,
    stroke: 0.42 + (at(5) % 3) * 0.12,
    spin: (at(6) / 255) * 360,
  };
  CACHE.set(key, geometry);
  return geometry;
}

export function fingerprintLabel(hash: string | null | undefined): string {
  const prefix = (hash ?? '').slice(0, 8) || 'unsealed';
  return `Document fingerprint, first 8 characters ${prefix}`;
}

export interface RosetteSvgOptions {
  hash: string | null | undefined;
  size: number;
  /** Stroke/fill color (CSS color value). Defaults to currentColor. */
  color?: string;
  /** Multiplier applied to computed stroke widths. Defaults to 1. */
  strokeScale?: number;
  /** Draw the signature line through the mark (logo/seal variant). */
  withSignature?: boolean;
  /** Accessible label; omitted when decorative. */
  label?: string;
  decorative?: boolean;
  className?: string;
}

function escAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the rosette as a standalone SVG string (for server-side documents/PDFs).
 * Geometry is identical to the web component for the same hash.
 */
export function rosetteSvg(options: RosetteSvgOptions): string {
  const {
    hash,
    size,
    color = 'currentColor',
    strokeScale = 1,
    withSignature = false,
    decorative = false,
    className,
  } = options;
  const g = rosetteGeometry(hash ?? 'unsealed');
  const sw = (v: number) => v * strokeScale;
  const petalLength = g.outer * 0.92;
  const petalWidth = g.outer * 0.16;
  const innerLength = g.inner * 0.95;
  const innerWidth = g.inner * 0.2;
  const label = decorative ? undefined : options.label ?? fingerprintLabel(hash);

  const parts: string[] = [];
  parts.push(`<circle cx="50" cy="50" r="${g.outer}" stroke-width="${sw(g.stroke)}"/>`);
  parts.push(
    `<circle cx="50" cy="50" r="${g.outer - 2.4}" stroke-width="${sw(g.stroke * 0.7)}" stroke-dasharray="1.1 2.4"/>`,
  );
  parts.push(`<circle cx="50" cy="50" r="${g.outer - 5}" stroke-width="${sw(g.stroke * 0.5)}"/>`);

  for (let i = 0; i < g.petals; i++) {
    const angle = (360 / g.petals) * i + (g.phase * 180) / Math.PI;
    parts.push(
      `<g transform="rotate(${angle} 50 50)">` +
        `<ellipse cx="50" cy="${50 - petalLength / 2 + 4}" rx="${petalWidth}" ry="${petalLength / 2}" stroke-width="${sw(g.stroke)}"/>` +
        `<line x1="50" y1="50" x2="50" y2="${50 - g.outer + 1}" stroke-width="${sw(g.stroke * 0.45)}"/>` +
        `</g>`,
    );
  }

  parts.push(`<circle cx="50" cy="50" r="${g.inner}" stroke-width="${sw(g.stroke)}"/>`);
  for (let i = 0; i < g.innerPetals; i++) {
    const angle = (360 / g.innerPetals) * i - (g.phase * 180) / Math.PI;
    parts.push(
      `<ellipse cx="50" cy="${50 - innerLength / 2 + 1.5}" rx="${innerWidth}" ry="${innerLength / 2}" stroke-width="${sw(g.stroke * 0.8)}" transform="rotate(${angle} 50 50)"/>`,
    );
  }
  parts.push(`<circle cx="50" cy="50" r="${g.inner * 0.34}" stroke-width="${sw(g.stroke * 0.7)}"/>`);
  parts.push(`<circle cx="50" cy="50" r="0.9" fill="${escAttr(color)}" stroke="none"/>`);

  const signature = withSignature
    ? `<path d="M18 62c7-1 9-9 14-9s3 10 9 10 6-7 11-7 5 6 10 6 5-4 10-3" stroke="${escAttr(color)}" stroke-width="${sw(1.6)}" stroke-linecap="square" fill="none"/>`
    : '';

  const role = decorative ? '' : ` role="img"`;
  const ariaHidden = decorative ? ' aria-hidden="true"' : '';
  const ariaLabel = label ? ` aria-label="${escAttr(label)}"` : '';
  const cls = className ? ` class="${escAttr(className)}"` : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"` +
    `${cls} fill="none" stroke="${escAttr(color)}"${role}${ariaHidden}${ariaLabel}>` +
    `<g transform="rotate(${g.spin} 50 50)">${parts.join('')}</g>` +
    signature +
    `</svg>`
  );
}
