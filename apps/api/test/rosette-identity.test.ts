import { describe, expect, it } from 'vitest';
import { rosetteGeometry, rosetteSvg } from '@agreementhub/domain';
import { documentFontsCss } from '../src/services/documentFonts.js';

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('rosette identity', () => {
  const hashes = [
    'a'.repeat(64),
    '0123456789abcdef'.repeat(4),
    'f'.repeat(64),
    'unsealed',
    '7c3b1e9a2d4f00112233445566778899aabbccddeeff00112233445566778899',
  ];

  it('SVG output matches shared geometry for several hashes', () => {
    for (const hash of hashes) {
      const g = rosetteGeometry(hash);
      const svg = rosetteSvg({ hash, size: 80, color: '#0F5F53', withSignature: true });
      expect(svg).toContain(`transform="rotate(${g.spin} 50 50)"`);
      expect(svg).toContain(`r="${g.outer}"`);
      expect(svg).toContain(`r="${g.inner}"`);
      expect(countOccurrences(svg, '<ellipse')).toBe(g.petals + g.innerPetals);
      // outer, inner-dashed, inner-band, inner ring, center dot, inner accent ring = 6 circles
      expect(countOccurrences(svg, '<circle')).toBe(6);
      expect(svg).toContain(`stroke-width="${g.stroke}"`);
      // signature path present
      expect(svg).toContain('<path d="M18 62');
    }
  });

  it('embeds document fonts within size budget', () => {
    const css = documentFontsCss();
    // 7 faces expected
    expect(countOccurrences(css, '@font-face')).toBe(7);
    // base64 payload size proxy: total CSS under ~350KB string, embedded woff2 data well under 250KB total files
    expect(Buffer.byteLength(css, 'utf8')).toBeLessThan(350 * 1024);
  });
});
