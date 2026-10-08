import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler, User } from './api';

interface AuthCtx {
  user: User | null;
  isAdmin: boolean;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  setUser: (u: User) => void;
}

const Ctx = createContext<AuthCtx | null>(null);
interface Session { token: string; user: User }

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!getToken());

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    qc.clear();
  }, [qc]);

  // restore the session after a refresh
  useEffect(() => {
    if (!getToken()) return;
    api.get<User>('/auth/me').then(setUser).catch(() => setToken(null)).finally(() => setReady(true));
  }, []);

  // any 401 from the API (expired token, deleted account) signs the user out
  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const start = (s: Session) => { setToken(s.token); setUser(s.user); };
  const value = useMemo<AuthCtx>(() => ({
    user,
    isAdmin: user?.role === 'admin',
    ready,
    login: async (email, password) => start(await api.post<Session>('/auth/login', { email, password })),
    register: async (name, email, password) => start(await api.post<Session>('/auth/register', { name, email, password })),
    logout,
    setUser,
  }), [user, ready, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside <AuthProvider>');
  return c;
}
