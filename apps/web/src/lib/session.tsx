'use client';

/**
 * Session context: who is signed in, backed by the React Query cache.
 * The session is an httpOnly cookie, the client never sees the token.
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, isAuthError, post, ApiError } from './api';
import type { Organization, PublicUser, SessionResponse } from './types';

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface SessionState {
  user: PublicUser | null;
  organizations: Organization[];
  status: SessionStatus;
  /** Re-read the session from the server (after login/register/profile save). */
  refresh: () => Promise<void>;
  /** End the current session and drop all cached private data. */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

async function fetchSession(): Promise<SessionResponse | null> {
  try {
    return await get<SessionResponse>('/auth/session');
  } catch (err) {
    if (isAuthError(err)) return null;
    throw err;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['session'],
    queryFn: fetchSession,
    staleTime: 30_000,
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['session'] });
    await queryClient.refetchQueries({ queryKey: ['session'], type: 'active' });
  }, [queryClient]);

  const logout = useCallback(async () => {
    try {
      await post('/auth/logout');
    } catch {
      // Session may already be gone server-side; clear locally regardless.
    }
    queryClient.setQueryData(['session'], null);
    queryClient.removeQueries({
      predicate: (q) => q.queryKey[0] !== 'session',
    });
  }, [queryClient]);

  const value = useMemo<SessionState>(() => {
    const data = query.data ?? null;
    return {
      user: data?.user ?? null,
      organizations: data?.organizations ?? [],
      status: query.isPending ? 'loading' : data?.user ? 'authenticated' : 'unauthenticated',
      refresh,
      logout,
    };
  }, [query.data, query.isPending, refresh, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
