/**
 * Document theme tokens shared with the website (apps/web/src/app/globals.css).
 * Keep in sync with the web palette, a test asserts parity.
 */
export const DOCUMENT_THEME = {
  paper: '#F3EFE6',
  sheet: '#FCFBF7',
  ink: '#16181D',
  ink2: '#4A4D55',
  ink3: '#62656D',
  rule: '#D9D3C4',
  ruleStrong: '#B9B2A0',
  navy: '#1C2B4A',
  seal: '#0F5F53',
  sealTint: '#E3EFEA',
  attention: '#7A4E00',
  attentionTint: '#F6E7C4',
  danger: '#A3321E',
} as const;

export type DocumentTheme = typeof DOCUMENT_THEME;
