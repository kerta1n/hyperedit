import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, ChevronDown, Pencil, Loader2, Trash2, Plus, Folder, X, Check } from 'lucide-react';
import type { SessionInfo } from '../hooks/useProject';
import { useSessionManager } from '../hooks/useSessionManager';
import type { SessionSummary } from '../hooks/useSessionManager';

interface SessionManagerProps {
  currentSession: SessionInfo | null;
  saveProjectImmediate: () => Promise<void>;
  setSession: (s: SessionInfo | null) => void;
  resetProjectState: () => void;
  resetLocalState: () => void;
}

function formatRelativeDate(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SessionManager({
  currentSession,
  saveProjectImmediate,
  setSession,
  resetProjectState,
  resetLocalState,
}: SessionManagerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const {
    sessions,
    isLoading,
    isSwitching,
    error,
    fetchSessions,
    renameSession,
    switchToSession,
    deleteSession,
    createAndSwitch,
  } = useSessionManager({
    currentSession,
    saveProjectImmediate,
    setSession,
    resetProjectState,
    resetLocalState,
  });

  // Fetch sessions when dropdown opens
  useEffect(() => {
    if (isOpen) fetchSessions();
  }, [isOpen, fetchSessions]);

  // Click-outside to close dropdown
  useEffect(() => {
    if (!isOpen) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current && !dropdownRef.current.contains(target) &&
        triggerRef.current && !triggerRef.current.contains(target)
      ) {
        setIsOpen(false);
        setIsRenaming(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen]);

  // Focus rename input
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const startRename = useCallback(() => {
    if (!currentSession) return;
    setRenameValue(currentSession.name);
    setIsRenaming(true);
  }, [currentSession]);

  const confirmRename = useCallback(() => {
    if (!currentSession || !renameValue.trim()) {
      setIsRenaming(false);
      return;
    }
    renameSession(currentSession.sessionId, renameValue);
    setIsRenaming(false);
  }, [currentSession, renameValue, renameSession]);

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') confirmRename();
    else if (e.key === 'Escape') setIsRenaming(false);
  }, [confirmRename]);

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    await deleteSession(pendingDelete.sessionId);
    setPendingDelete(null);
  }, [pendingDelete, deleteSession]);

  const otherSessions = sessions.filter(
    s => s.sessionId !== currentSession?.sessionId
  );

  const displayName = currentSession?.name || 'No Session';
  const truncatedName = displayName.length > 20
    ? displayName.substring(0, 20) + '���'
    : displayName;

  const toggleDropdown = useCallback(() => {
    if (!isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left });
    }
    setIsOpen(prev => !prev);
  }, [isOpen]);

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        ref={triggerRef}
        onClick={toggleDropdown}
        disabled={isSwitching}
        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-800/60 hover:bg-zinc-700/60 border border-zinc-700/50 rounded-lg text-sm transition-colors"
      >
        {isSwitching ? (
          <Loader2 className="w-3.5 h-3.5 text-orange-400 animate-spin" />
        ) : (
          <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
        )}
        <span className="text-zinc-200 max-w-[160px] truncate">{truncatedName}</span>
        <ChevronDown className="w-3 h-3 text-zinc-500" />
      </button>

      {/* Dropdown panel — portaled to body to escape header stacking context */}
      {isOpen && createPortal(
        <div
          ref={dropdownRef}
          className="fixed bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-[200] w-72"
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
        >
          {/* Current session */}
          {currentSession && (
            <div className="p-3 border-b border-zinc-700/50">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5">Current Session</div>
              {isRenaming ? (
                <div className="flex items-center gap-1.5">
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={confirmRename}
                    className="flex-1 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-orange-500"
                  />
                  <button
                    onClick={confirmRename}
                    className="p-1 hover:bg-zinc-700 rounded transition-colors"
                  >
                    <Check className="w-3.5 h-3.5 text-green-400" />
                  </button>
                  <button
                    onClick={() => setIsRenaming(false)}
                    className="p-1 hover:bg-zinc-700 rounded transition-colors"
                  >
                    <X className="w-3.5 h-3.5 text-zinc-400" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white font-medium truncate">{currentSession.name}</span>
                  <button
                    onClick={startRename}
                    className="p-1 hover:bg-zinc-700 rounded transition-colors"
                    title="Rename session"
                  >
                    <Pencil className="w-3.5 h-3.5 text-zinc-400" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Other sessions list */}
          <div className="max-h-64 overflow-y-auto">
            {error && (
              <p className="text-xs text-red-400 px-3 py-2">{error}</p>
            )}
            {isLoading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-4 h-4 text-zinc-400 animate-spin" />
              </div>
            )}
            {!isLoading && otherSessions.length === 0 && !error && (
              <p className="text-zinc-500 text-xs text-center py-3">No other sessions</p>
            )}
            {!isLoading && otherSessions.map(s => (
              <div
                key={s.sessionId}
                className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-700/50 group cursor-pointer"
                onClick={() => {
                  switchToSession(s);
                  setIsOpen(false);
                }}
              >
                <Folder className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-200 truncate">{s.name}</div>
                  <div className="text-[10px] text-zinc-500">
                    {s.assetCount} asset{s.assetCount !== 1 ? 's' : ''} · {formatRelativeDate(s.createdAt)}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(s);
                  }}
                  className="p-1 opacity-0 group-hover:opacity-100 hover:bg-zinc-600 rounded transition-all"
                  title="Delete session"
                >
                  <Trash2 className="w-3.5 h-3.5 text-zinc-400 hover:text-red-400" />
                </button>
              </div>
            ))}
          </div>

          {/* New session button */}
          <div className="border-t border-zinc-700/50 p-2">
            <button
              onClick={() => {
                createAndSwitch();
                setIsOpen(false);
              }}
              disabled={isSwitching}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700/50 rounded-md transition-colors disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" />
              New Session
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* Delete confirmation dialog */}
      {pendingDelete && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}
        >
          <div className="bg-zinc-900 rounded-xl border border-zinc-700 p-6 max-w-sm w-full mx-4 text-white">
            <h3 className="text-base font-semibold text-red-400 mb-2 flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-red-400" />
              Delete session?
            </h3>
            <p className="text-sm text-white font-medium mb-1">{pendingDelete.name}</p>
            <p className="text-sm text-zinc-500 mb-5">
              All assets and project data will be permanently deleted. This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
