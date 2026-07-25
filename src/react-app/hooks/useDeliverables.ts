import { useState, useCallback, useMemo } from 'react';

import { API_BASE as LOCAL_FFMPEG_URL } from '@/react-app/utils/api-helpers';

export interface RenderItem {
  id: string;
  filename: string;
  title: string;
  createdAt: number | null;
  fileSize: number;
  duration: number | null;
  codec: string | null;
  containerFormat: string | null;
  thumbnailUrl: string | null;
  downloadUrl: string;
}

export function useDeliverables() {
  const [renders, setRenders] = useState<RenderItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  const fetchRenders = useCallback(async (sessionId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${LOCAL_FFMPEG_URL}/session/${sessionId}/renders`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      const items: RenderItem[] = data.renders || [];
      setRenders(items);
      const validIds = new Set(items.map((r) => r.id));
      setSelectedIds((prev) => prev.filter((id) => validIds.has(id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load renders');
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteRenders = useCallback(
    async (sessionId: string, ids: string[]) => {
      for (const id of ids) {
        await fetch(`${LOCAL_FFMPEG_URL}/session/${sessionId}/renders/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      }
      await fetchRenders(sessionId);
    },
    [fetchRenders],
  );

  const renameRender = useCallback(async (sessionId: string, id: string, title: string) => {
    setRenders((prev) => prev.map((r) => (r.id === id ? { ...r, title } : r)));
    await fetch(`${LOCAL_FFMPEG_URL}/session/${sessionId}/renders/${encodeURIComponent(id)}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const clearSelection = useCallback(() => setSelectedIds([]), []);

  const totalSelectedSize = useMemo(
    () => renders.filter((r) => selectedIds.includes(r.id)).reduce((sum, r) => sum + r.fileSize, 0),
    [renders, selectedIds],
  );

  return {
    renders,
    selectedIds,
    loading,
    error,
    pendingDelete,
    fetchRenders,
    deleteRenders,
    renameRender,
    toggleSelect,
    clearSelection,
    totalSelectedSize,
    setPendingDelete,
  };
}
