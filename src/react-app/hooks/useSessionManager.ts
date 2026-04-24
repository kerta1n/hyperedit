import { useState, useCallback } from 'react';
import type { SessionInfo } from './useProject';

const LOCAL_FFMPEG_URL = 'http://localhost:3333';

export interface SessionSummary {
  sessionId: string;
  name: string;
  createdAt: number;
  assetCount: number;
  clipCount: number;
}

interface UseSessionManagerOptions {
  currentSession: SessionInfo | null;
  saveProjectImmediate: () => Promise<void>;
  setSession: (s: SessionInfo | null) => void;
  resetProjectState: () => void;
  resetLocalState: () => void;
}

export function useSessionManager({
  currentSession,
  saveProjectImmediate,
  setSession,
  resetProjectState,
  resetLocalState,
}: UseSessionManagerOptions) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${LOCAL_FFMPEG_URL}/sessions`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error('Failed to fetch sessions');
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {
      setError('Could not load sessions');
      setSessions([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const renameSession = useCallback(async (sessionId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    // Optimistic update
    setSessions(prev => prev.map(s =>
      s.sessionId === sessionId ? { ...s, name: trimmed } : s
    ));

    // Also update current session if renaming active one
    if (currentSession && currentSession.sessionId === sessionId) {
      setSession({ ...currentSession, name: trimmed });
    }

    try {
      const res = await fetch(`${LOCAL_FFMPEG_URL}/session/${sessionId}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        // Revert on failure
        await fetchSessions();
      }
    } catch {
      await fetchSessions();
    }
  }, [currentSession, setSession, fetchSessions]);

  const switchToSession = useCallback(async (summary: SessionSummary) => {
    if (isSwitching) return;
    if (currentSession && currentSession.sessionId === summary.sessionId) return;

    setIsSwitching(true);
    setError(null);

    try {
      await saveProjectImmediate();
      resetProjectState();
      resetLocalState();
      setSession({
        sessionId: summary.sessionId,
        name: summary.name,
        createdAt: summary.createdAt,
      });
    } catch (e) {
      setError('Failed to switch session');
      console.error('[SessionManager] Switch failed:', e);
    } finally {
      setIsSwitching(false);
    }
  }, [isSwitching, currentSession, saveProjectImmediate, resetProjectState, resetLocalState, setSession]);

  const deleteSession = useCallback(async (sessionId: string) => {
    if (currentSession && currentSession.sessionId === sessionId) return;

    try {
      const res = await fetch(`${LOCAL_FFMPEG_URL}/session/${sessionId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Delete failed');
      await fetchSessions();
    } catch {
      setError('Failed to delete session');
    }
  }, [currentSession, fetchSessions]);

  const createAndSwitch = useCallback(async () => {
    if (isSwitching) return;

    setIsSwitching(true);
    setError(null);

    try {
      if (currentSession) {
        await saveProjectImmediate();
      }

      const res = await fetch(`${LOCAL_FFMPEG_URL}/session/create`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to create session');
      const data = await res.json();

      resetProjectState();
      resetLocalState();
      setSession({
        sessionId: data.sessionId,
        name: data.name || 'Untitled Project',
        createdAt: Date.now(),
      });
    } catch (e) {
      setError('Failed to create session');
      console.error('[SessionManager] Create failed:', e);
    } finally {
      setIsSwitching(false);
    }
  }, [isSwitching, currentSession, saveProjectImmediate, resetProjectState, resetLocalState, setSession]);

  return {
    sessions,
    isLoading,
    isSwitching,
    error,
    fetchSessions,
    renameSession,
    switchToSession,
    deleteSession,
    createAndSwitch,
  };
}
