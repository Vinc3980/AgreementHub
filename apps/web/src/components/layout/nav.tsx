'use client';

/** The masthead replaces the old sidebar: wordmark, text nav, command search. */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { LogOut, Settings, UserRound } from 'lucide-react';
import { RosetteMark } from '@/components/ui/rosette';
import { Avatar } from '@/components/ui/avatar';
import { Dropdown, MenuItem } from '@/components/ui/dropdown';
import { CommandPalette } from '@/components/ui/command-palette';
import { useSession } from '@/lib/session';

interface NavItem {
  href: string;
  label: string;
  match: (path: string) => boolean;
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Desk', match: (p) => p.startsWith('/dashboard') },
  { href: '/agreements', label: 'Agreements', match: (p) => p.startsWith('/agreements') },
  { href: '/obligations', label: 'Obligations', match: (p) => p.startsWith('/obligations') },
  { href: '/notifications', label: 'Notifications', match: (p) => p.startsWith('/notifications') },
  { href: '/settings', label: 'Settings', match: (p) => p.startsWith('/settings') },
];

export function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <Link
      href="/dashboard"
      onClick={onClick}
      className="flex items-center gap-2.5"
      aria-label="AgreementHub home"
    >
      <RosetteMark size={26} className="shrink-0 text-ink" />
      <span className="flex flex-col leading-none">
        <span className="font-serif text-[1.05rem] font-medium tracking-[-0.01em] text-ink">
          AgreementHub
        </span>
        <span className="mt-1 text-caps text-ink-3">The instrument</span>
      </span>
    </Link>
  );
}

function NotificationBell({ unread }: { unread: number }) {
  return (
    <Link
      href="/notifications"
      className="relative flex h-11 w-11 items-center justify-center rounded-control text-ink-2 hover:bg-vellum hover:text-ink"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
    >
      <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden>
        <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5 1.5 5h-13S5 12 5 8Z" />
        <path d="M8.2 16a2 2 0 0 0 3.6 0" />
      </svg>
      {unread > 0 ? (
        <span className="absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center border border-paper bg-danger px-1 font-mono text-[0.625rem] leading-none font-semibold text-sheet tabular-nums">
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </Link>
  );
}

/** User menu shared by masthead and mobile bar. */
export function UserMenu({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { user, logout } = useSession();

  async function onLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <Dropdown
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex min-h-11 items-center gap-2 rounded-control py-1 pr-2 pl-1 hover:bg-vellum"
          aria-label="Your account"
        >
          <Avatar
            name={user?.displayName ?? user?.email ?? ''}
            userId={user?.id}
            src={user?.avatarUrl}
            size={32}
          />
          {compact ? null : (
            <span className="hidden max-w-32 truncate text-xs font-medium text-ink md:block">
              {user?.displayName ?? user?.email}
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="border-b border-rule px-3 py-2">
            <p className="truncate text-sm font-medium text-ink">{user?.displayName}</p>
            <p className="truncate text-xs text-ink-2">{user?.email}</p>
          </div>
          <MenuItem
            onClick={() => {
              close();
              router.push('/settings');
            }}
          >
            <UserRound className="h-4 w-4" aria-hidden />
            Profile
          </MenuItem>
          <MenuItem
            onClick={() => {
              close();
              router.push('/settings?tab=security');
            }}
          >
            <Settings className="h-4 w-4" aria-hidden />
            Security &amp; sessions
          </MenuItem>
          <MenuItem
            danger
            onClick={() => {
              close();
              void onLogout();
            }}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Sign out
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}

export function Masthead({ unread }: { unread: number }) {
  const pathname = usePathname() ?? '';
  const { user } = useSession();
  const items = user?.isPlatformAdmin
    ? [...NAV, { href: '/admin', label: 'Admin', match: (p: string) => p.startsWith('/admin') }]
    : NAV;

  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-paper/95">
      <div className="mx-auto flex h-16 w-full max-w-[88rem] items-center gap-4 px-4 sm:px-6">
        <Brand />

        <nav className="ml-2 hidden items-center gap-1 lg:flex" aria-label="Main">
          {items.map((item) => {
            const active = item.match(pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={[
                  'inline-flex min-h-11 items-center border-b-2 px-3 text-sm transition-colors',
                  active
                    ? 'border-navy font-medium text-ink'
                    : 'border-transparent text-ink-2 hover:border-rule-strong hover:text-ink',
                ].join(' ')}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto hidden w-full max-w-xs md:block">
          <CommandPalette />
        </div>

        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <Link
            href="/agreements/new"
            className="hidden min-h-10 items-center border border-navy bg-navy px-3 text-xs font-medium text-sheet hover:bg-navy-hover sm:inline-flex"
          >
            New agreement
          </Link>
          <NotificationBell unread={unread} />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

/** Mobile bottom bar: text labels, 44px targets, safe-area aware. */
export function MobileBar() {
  const pathname = usePathname() ?? '';
  const { user } = useSession();
  const items = user?.isPlatformAdmin
    ? [...NAV, { href: '/admin', label: 'Admin', match: (p: string) => p.startsWith('/admin') }]
    : NAV;

  const glyph = (label: string) => {
    const common = {
      viewBox: '0 0 20 20',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      className: 'h-[18px] w-[18px]',
      'aria-hidden': true,
    } as const;
    switch (label) {
      case 'Desk':
        return (
          <svg {...common}>
            <path d="M3 9.5 10 3l7 6.5" />
            <path d="M5 8.5V17h10V8.5" />
          </svg>
        );
      case 'Agreements':
        return (
          <svg {...common}>
            <path d="M5 2.5h6.5L15 6v11.5H5Z" />
            <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" />
          </svg>
        );
      case 'Obligations':
        return (
          <svg {...common}>
            <circle cx="10" cy="10" r="6.5" />
            <path d="M10 6.5V10l2.5 1.5" />
            <path d="M6.5 4.5l-1-1M13.5 4.5l1-1" />
          </svg>
        );
      case 'Notifications':
        return (
          <svg {...common}>
            <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5 1.5 5h-13S5 12 5 8Z" />
            <path d="M8.2 16a2 2 0 0 0 3.6 0" />
          </svg>
        );
      case 'Settings':
        return (
          <svg {...common}>
            <circle cx="10" cy="10" r="2.6" />
            <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M14.9 5.1l-1.4 1.4M6.5 13.5l-1.4 1.4" />
          </svg>
        );
      default:
        return (
          <svg {...common}>
            <path d="M10 2.5 16.5 6v8L10 17.5 3.5 14V6Z" />
          </svg>
        );
    }
  };

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-rule bg-sheet pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {items.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={[
              'flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[0.6875rem]',
              active ? 'border-t-2 border-navy text-ink' : 'border-t-2 border-transparent text-ink-3',
            ].join(' ')}
          >
            {glyph(item.label)}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
