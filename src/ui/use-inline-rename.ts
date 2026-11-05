'use client';

import { useRef, useState } from 'react';

interface NamedItem { id: string; name: string }

/** Shared inline-edit lifecycle; the caller retains ownership of its public rename command. */
export function useInlineRename(
  rename: (id: string, name: string) => Promise<boolean>,
  onError: (message: string) => void,
) {
  const [editingProjectId, setEditingProjectId] = useState<string>();
  const [editingProjectName, setEditingProjectName] = useState('');
  const cancelled = useRef(false);
  const startRename = (item: NamedItem) => {
    cancelled.current = false;
    onError('');
    setEditingProjectId(item.id);
    setEditingProjectName(item.name);
  };
  const cancelRename = () => { cancelled.current = true; setEditingProjectId(undefined); };
  const finishRename = async (item: NamedItem) => {
    if (cancelled.current) { cancelled.current = false; return; }
    const name = editingProjectName.trim();
    if (!name) { onError('书籍名称不能为空'); return; }
    if (name === item.name || await rename(item.id, name)) setEditingProjectId(undefined);
  };
  return { editingProjectId, editingProjectName, setEditingProjectName, startRename, finishRename, cancelRename };
}
