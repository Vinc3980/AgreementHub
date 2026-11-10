'use client';

/**
 * Avatar: the authenticated picture when present, otherwise deterministic
 * initials on a token-coloured disc. The colour is derived from the user id so
 * the same person keeps the same mark everywhere.
 */
import { useEffect, useState } from 'react';
import { initials } from '@/lib/format';

export type AvatarSize = 24 | 32 | 40 | 96;

const SIZE_CLASSES: Record<AvatarSize, string> = {
  24: 'h-6 w-6 text-[0.625rem]',
  32: 'h-8 w-8 text-[0.6875rem]',
  40: 'h-10 w-10 text-xs',
  96: 'h-24 w-24 text-2xl',
};

/** Token-only palette; never a raw colour value. */
const TONES = [
  'bg-navy-tint text-navy',
  'bg-seal-tint text-seal',
  'bg-attention-tint text-attention',
  'bg-danger-tint text-danger',
  'bg-vellum text-ink-2',
  'bg-rule text-ink',
] as const;

function toneFor(seed: string): string {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return TONES[Math.abs(hash) % TONES.length]!;
}

export function Avatar({
  name,
  userId,
  src,
  size = 32,
  className = '',
}: {
  name: string | null | undefined;
  /** Stable colour seed; falls back to the display name. */
  userId?: string | null;
  /** Authenticated avatar URL from the API. */
  src?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [src]);

  const label = name?.trim() || 'User';
  const base = `inline-flex ${SIZE_CLASSES[size]} shrink-0 items-center justify-center overflow-hidden border border-rule-strong [border-radius:9999px] ${className}`;

  if (src && !broken) {
    return (
      <span className={base}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`${label} profile picture`}
          width={size}
          height={size}
          loading="lazy"
          draggable={false}
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  return (
    <span className={`${base} ${toneFor(userId ?? label)} font-medium`} aria-hidden>
      {initials(name)}
    </span>
  );
}
