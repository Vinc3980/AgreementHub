# AgreementHub: The Instrument

A sealed, tamper-evident legal document aesthetic. Ink, vellum, and verdigris.
The interface should read like a register, not a SaaS dashboard: ruled lines,
generous margins, serif document text, monospace identifiers, and one accent
that means "this is the action".

## Principles

1. **The document is the product.** Screens frame the instrument; they do not
   compete with it. Prefer a hairline and a margin over a box and a shadow.
2. **Structure before decoration.** Rules, spacing, and type create hierarchy.
   Icons are inline glyphs only where a status or control needs one.
3. **One action colour.** Navy means "do this". Verdigris means "sealed and
   verified". Everything else is ink on paper.
4. **Never colour alone.** Every status carries a glyph and a written label.
5. **Irreversible acts must feel irreversible.** Sealing uses a three-step
   ceremony with press-and-hold; signing uses Review → Consent → Sign.
6. **Show provenance.** Hashes are grouped and copyable. The rosette is
   deterministic: the same document yields the same mark.

## Tokens

All tokens live in `src/app/globals.css` under `@theme`. Components may use
only token-named utilities; never raw hex values or Tailwind palette classes.

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `paper` | `#F3EFE6` | Page background |
| `sheet` | `#FCFBF7` | Document and panel surface |
| `vellum` | `#EDE8DC` | Hover / inset surface |
| `ink` | `#16181D` | Primary text |
| `ink-2` | `#4A4D55` | Secondary text (7.4:1) |
| `ink-3` | `#62656D` | Minimum text tone (5.1:1) |
| `rule` | `#D9D3C4` | Hairline dividers |
| `rule-strong` | `#B9B2A0` | Strong rules and inactive controls |
| `navy` | `#1C2B4A` | The only action colour |
| `seal` | `#0F5F53` | Sealed / verified / final |
| `seal-tint` | `#E3EFEA` | Sealed surface |
| `attention` | `#7A4E00` on `#F6E7C4` | Needs a human |
| `redline` | `#1D4FA8` | Insertions in diffs |
| `danger` | `#A3321E` on `#F5DDD6` | Failure / destructive |

Expired is **neutral**, not red. Cancelled, terminated, and rejected are
danger only because they close the record.

### Type

- **Newsreader**: display and document text (`--font-newsreader`).
- **Instrument Sans**: interface text (`--font-instrument`).
- **JetBrains Mono**: IDs, hashes, timestamps (`--font-jetbrains`).

Scale (rem): `0.75 / 0.8125 / 0.9375 (body) / 1.0625 / 1.375 / 1.75 / 2.5`.
Body text is at least 15px. Numerals are tabular wherever figures align.
Small-caps labels use `.text-caps`; loud all-caps is not used.

### Shape and motion

- `rounded-control` = 6px for controls (buttons, inputs, selects, status stamps).
- `rounded-panel` = 8px for cards and panels.
- `rounded-overlay` = 12px for dialogs, menus, and toasts.
- Radius stays `0` for the document sheet, tables, and ledger lines (part of the product identity). Only avatars and the status dot may be circular.
- Floating layers use a strong rule (`border-rule-strong`) rather than shadows.
- Motion uses `--duration-ui` and `--ease-instrument`. All motion is disabled
  under `prefers-reduced-motion`.

## Layout

There is no sidebar. A slim **masthead** carries the wordmark, text navigation
(Desk · Agreements · Notifications · Settings), the command search in the
centre, and the user menu. On small screens a bottom bar replaces the nav.
Content sits on paper under a single rule, with a maximum width of 88rem.

## Components

### Primitives

`Button`, `Badge`, `Card`, `Table`, `Field`, `Modal`, `Tabs`, `PageHeader`,
`EmptyState`, `ErrorState`, `Skeleton`, `Dropdown`, `Avatar`.

Existing names and props are preserved so legacy screens keep compiling;
internals are restyled. `Badge` remains for categorical labels. `StatusBadge`
and `VersionBadge` delegate to the new stamps.

### Signature components

- **`Rosette`**: deterministic guilloche generated from a SHA-256. Pure and
  cached. `RosetteMark` is the logo (fixed hash + signature line).
- **`LifecycleTrack`**: Draft → Review/negotiate → Signatures → Sealed, with a
  broken terminal line for cancelled, terminated, rejected, and expired.
- **`NextStepLine`**: one plain sentence: what happens now, who is blocking.
- **`HashText`**: monospace hash in blocks of four; first eight characters
  emphasised; copy control.
- **`LedgerRow`**: a ruled audit line: sequence, time, actor, event, class,
  hash.
- **`Marginalia`**: a note set outside the document body, with a coloured
  left rule and a small-caps label.
- **`StatusStamp` / `VersionStamp`**: a glyph plus label for every state.
- **`Sheet`**: the document surface (`SheetHeader`, `SheetBody`,
  `SheetFooter`); double rules and watermarks are allowed only here.
- **`SealCeremony`**: Review → Consent → press-and-hold Seal.
- **`CommandPalette`**: ⌘K / Ctrl-K, j/k, Enter, Esc; `g d`, `g a`, `g n`,
  `g s`; `?` for the shortcut list.

## Screens

### Desk

Counts render as one ruled ledger strip, not six KPI cards. The expiring
horizon is a ninety-day ruled timeline. "Waiting on you" is a numbered list.
Recent activity is "The register". A marginal note explains the hash chain.

### Agreement detail

Identity block: rosette, title in Newsreader, public ID and hash in
monospace, status stamp. Lifecycle and next-step share a ruled band. The
specification strip is a definition list. The document tab is a sheet with a
marginalia rail (record, signatures, integrity). Tabs are ruled, never pills.

### Verify

The public page is a certificate: double verdigris rules, rosette, a checklist
with glyphs and labels, metadata, hash blocks, and a QR code. States:
`VERIFIED`, `MISMATCH`, `NOT FOUND`, and "existing but not yet sealed". Nothing
reveals document contents.

## Voice

- Plain sentences. No exclamation marks.
- "Needs your signature" rather than "Action required!!".
- AI output is a **suggestion slip** with the fixed disclaimer. No sparkles,
  purple, or chat bubbles; nothing is written without explicit acceptance.
- Errors say what happened and that data is unchanged.

## Accessibility

- WCAG 2.2 AA contrast; `ink-3` is the floor for text.
- All touch targets are at least 44px (or 44px on touch, 36px compact desktop).
- Focus is a 2px navy outline with 2px offset; inputs also show a navy ring.
- Full keyboard support, including command palette and dialog escape.
- Reduced motion is respected globally.
- Status is never conveyed by colour alone.

## Banned

`rounded-*` utilities are allowed only through token classes: `rounded-control`,
`rounded-panel`, and `rounded-overlay`. Never use `rounded-xl`, `rounded-2xl`,
`rounded-3xl`, or `rounded-full` (except avatars and the status dot). Never use
`shadow-*`, `bg-gradient`, `backdrop-blur`, or raw Tailwind palette classes
(`indigo-*`, `gray-*`, `slate-*`, `blue-*`, …). No ad-hoc hex values in
components.

## Legacy mapping

Compatibility aliases (`canvas`, `surface`, `muted`, `brand`, `success`,
`warning`, `info`, `neutral-soft`, …) map to the palette above so older
screens cannot drift back to the previous SaaS colours while they are
rewritten.
