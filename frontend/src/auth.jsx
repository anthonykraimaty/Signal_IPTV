import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as api from './api.js';

const AuthContext = createContext(null);

// Role helpers — admin ⊃ control ⊃ view.
const RANK = { view: 0, control: 1, admin: 2 };
export function atLeast(role, min) {
  return (RANK[role] ?? -1) >= (RANK[min] ?? 99);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.me();
      setUser(user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (username, password) => {
    const { user } = await api.login(username, password);
    setUser(user);
    return user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = {
    user,
    loading,
    login,
    logout,
    refresh,
    setUser,
    is: (min) => !!user && atLeast(user.role, min),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
