'use client';

/**
 * CommandPalette, the centre of the masthead.
 * ⌘K / Ctrl-K opens; j/k move; Enter opens; Esc closes. `g d`, `g a`,
 * `g n`, `g s` jump directly. `?` lists every shortcut.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';
import { StatusGlyph } from '@/components/ui/status-stamp';

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: 'Go to' | 'Create' | 'Account';
  href: string;
  shortcut?: string;
  adminOnly?: boolean;
}

const COMMANDS: Command[] = [
  { id: 'desk', label: 'Desk', hint: 'Your dashboard', group: 'Go to', href: '/dashboard', shortcut: 'g d' },
  { id: 'agreements', label: 'Agreements', hint: 'All agreements', group: 'Go to', href: '/agreements', shortcut: 'g a' },
  { id: 'notifications', label: 'Notifications', group: 'Go to', href: '/notifications', shortcut: 'g n' },
  { id: 'settings', label: 'Settings', group: 'Go to', href: '/settings', shortcut: 'g s' },
  { id: 'new', label: 'New agreement', hint: 'Start from a template', group: 'Create', href: '/agreements/new' },
  { id: 'profile', label: 'Profile & security', group: 'Account', href: '/settings?tab=security' },
  { id: 'admin', label: 'Administration', group: 'Account', href: '/admin', adminOnly: true },
];

const SHORTCUTS = [
  ['⌘K / Ctrl-K', 'Open command palette'],
  ['j / k', 'Move through results'],
  ['Enter', 'Open the highlighted result'],
  ['g d', 'Go to Desk'],
  ['g a', 'Go to Agreements'],
  ['g n', 'Go to Notifications'],
  ['g s', 'Go to Settings'],
  ['?', 'Show this list'],
  ['Esc', 'Close'],
];

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

export function CommandPalette() {
  const router = useRouter();
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const gPressed = useRef(false);

  const commands = useMemo(
    () => COMMANDS.filter((c) => !c.adminOnly || user?.isPlatformAdmin),
    [user?.isPlatformAdmin],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.hint?.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q),
    );
  }, [commands, query]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery('');
      router.push(href);
    },
    [router],
  );

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }

      if (open) return;
      if (isTyping(e.target)) return;

      if (e.key === '?') {
        e.preventDefault();
        setHelp((v) => !v);
        return;
      }

      if (e.key.toLowerCase() === 'g') {
        gPressed.current = true;
        window.setTimeout(() => {
          gPressed.current = false;
        }, 900);
        return;
      }

      if (gPressed.current) {
        const routes: Record<string, string> = {
          d: '/dashboard',
          a: '/agreements',
          n: '/notifications',
          s: '/settings',
        };
        const href = routes[e.key.toLowerCase()];
        if (href) {
          e.preventDefault();
          gPressed.current = false;
          router.push(href);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, router]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => Math.min(results.length - 1, i + 1));
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      }
      if (e.key === 'Enter' && results[active]) {
        e.preventDefault();
        go(results[active].href);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, results, active, go]);

  const grouped = useMemo(() => {
    const map = new Map<string, Command[]>();
    for (const c of results) {
      const list = map.get(c.group) ?? [];
      list.push(c);
      map.set(c.group, list);
    }
    return [...map.entries()];
  }, [results]);

  let flatIndex = -1;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-10 w-full items-center gap-2 rounded-control border border-rule bg-sheet px-3 text-left text-sm text-ink-3 transition-colors hover:border-rule-strong hover:text-ink-2"
        aria-label="Search and commands, Command K"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
          <circle cx="7" cy="7" r="4.4" />
          <path d="M10.3 10.3 14 14" />
        </svg>
        <span className="min-w-0 flex-1 truncate">Search or jump to…</span>
        <kbd className="hidden shrink-0 border border-rule px-1.5 py-0.5 font-mono text-2xs text-ink-3 sm:block">
          ⌘K
        </kbd>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="presentation">
          <div className="absolute inset-0 bg-ink/45" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="relative z-10 w-full max-w-xl overflow-hidden rounded-overlay border border-rule-strong bg-sheet"
          >
            <div className="flex items-center gap-2 border-b border-rule px-4">
              <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-ink-3" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
                <circle cx="7" cy="7" r="4.4" />
                <path d="M10.3 10.3 14 14" />
              </svg>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Type a command or page…"
                aria-label="Command"
                className="min-h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="shrink-0 border border-rule px-1.5 py-0.5 font-mono text-2xs text-ink-3 hover:text-ink"
              >
                Esc
              </button>
            </div>
            <div className="max-h-[52vh] overflow-y-auto py-1">
              {results.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-ink-2">
                  No command matches “{query}”.
                </p>
              ) : (
                grouped.map(([group, items]) => (
                  <div key={group} className="px-2 py-1">
                    <p className="px-2 py-1 text-caps text-ink-3">{group}</p>
                    <ul>
                      {items.map((c) => {
                        flatIndex += 1;
                        const index = flatIndex;
                        return (
                          <li key={c.id}>
                            <button
                              type="button"
                              onMouseEnter={() => setActive(index)}
                              onClick={() => go(c.href)}
                              className={`flex min-h-10 w-full items-center gap-3 px-2 py-2 text-left text-sm ${
                                index === active ? 'bg-navy-tint text-ink' : 'text-ink-2 hover:bg-vellum'
                              }`}
                            >
                              <StatusGlyph name="draft" className="h-3 w-3 shrink-0 text-ink-3" />
                              <span className="min-w-0 flex-1 truncate">{c.label}</span>
                              {c.hint ? (
                                <span className="hidden truncate text-xs text-ink-3 sm:block">{c.hint}</span>
                              ) : null}
                              {c.shortcut ? (
                                <kbd className="shrink-0 font-mono text-2xs text-ink-3">{c.shortcut}</kbd>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center justify-between border-t border-rule px-4 py-2 text-2xs text-ink-3">
              <span>j / k to move · Enter to open</span>
              <button type="button" onClick={() => setHelp(true)} className="hover:text-ink">
                ? all shortcuts
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {help ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" role="presentation">
          <div className="absolute inset-0 bg-ink/45" onClick={() => setHelp(false)} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            className="relative z-10 w-full max-w-md rounded-overlay border border-rule-strong bg-sheet"
          >
            <div className="flex items-center justify-between border-b border-rule px-5 py-3">
              <h2 id="shortcuts-title" className="text-lg text-ink">
                Keyboard shortcuts
              </h2>
              <button
                type="button"
                onClick={() => setHelp(false)}
                className="min-h-9 border border-rule px-2 text-2xs text-ink-3 hover:text-ink"
              >
                Esc
              </button>
            </div>
            <dl className="divide-y divide-rule px-5 py-2">
              {SHORTCUTS.map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-4 py-2">
                  <dt className="font-mono text-xs text-ink-2">{key}</dt>
                  <dd className="text-sm text-ink">{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
    </>
  );
}
