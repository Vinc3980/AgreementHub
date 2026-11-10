import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_THEME } from '../src/services/documentTheme.js';

function normalizeHex(v: string): string {
  return v.trim().toLowerCase();
}

describe('document theme parity with website', () => {
  it('matches the website palette tokens in globals.css', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const cssPath = join(__dirname, '..', '..', 'web', 'src', 'app', 'globals.css');
    const css = readFileSync(cssPath, 'utf8');

    const expectToken = (cssVar: string, value: string) => {
      const re = new RegExp(`${cssVar}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`);
      const m = css.match(re);
      expect(m, `${cssVar} not found in globals.css`).toBeTruthy();
      expect(normalizeHex(m![1]!), `${cssVar} drifted`).toBe(normalizeHex(value));
    };

    expectToken('--color-paper', DOCUMENT_THEME.paper);
    expectToken('--color-sheet', DOCUMENT_THEME.sheet);
    expectToken('--color-ink', DOCUMENT_THEME.ink);
    expectToken('--color-ink-2', DOCUMENT_THEME.ink2);
    expectToken('--color-ink-3', DOCUMENT_THEME.ink3);
    expectToken('--color-rule', DOCUMENT_THEME.rule);
    expectToken('--color-rule-strong', DOCUMENT_THEME.ruleStrong);
    expectToken('--color-navy', DOCUMENT_THEME.navy);
    expectToken('--color-seal', DOCUMENT_THEME.seal);
    expectToken('--color-seal-tint', DOCUMENT_THEME.sealTint);
    expectToken('--color-attention', DOCUMENT_THEME.attention);
    expectToken('--color-attention-tint', DOCUMENT_THEME.attentionTint);
    expectToken('--color-danger', DOCUMENT_THEME.danger);
  });
});
