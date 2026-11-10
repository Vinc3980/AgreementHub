'use client';

import { useEffect, useRef, useState } from 'react';

export interface DelayedPendingOptions {
  /** Wait before showing a pending state, so fast responses never flash. */
  delay?: number;
  /** Once shown, keep the pending state visible for at least this long. */
  minDuration?: number;
}

/**
 * Stabilises loading UI: nothing for the first `delay` ms, and once visible it
 * stays for at least `minDuration` ms. Prevents skeleton flashes and jumps.
 */
export function useDelayedPending(
  isPending: boolean,
  { delay = 150, minDuration = 400 }: DelayedPendingOptions = {},
): boolean {
  const [show, setShow] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (isPending) {
      if (show) return;
      timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShow(true);
      }, delay);
      return () => {
        if (timer) clearTimeout(timer);
      };
    }

    if (!show) {
      shownAt.current = null;
      return;
    }

    const elapsed = shownAt.current ? Date.now() - shownAt.current : minDuration;
    const remaining = Math.max(0, minDuration - elapsed);
    timer = setTimeout(() => {
      shownAt.current = null;
      setShow(false);
    }, remaining);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isPending, show, delay, minDuration]);

  return show;
}
