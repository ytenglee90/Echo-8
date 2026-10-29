'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PersistenceService } from '../core/persistence.ts';
import type { ViewClient } from '../core/contracts.ts';
import type { ScheduledTaskSnapshot, TaskScheduler } from '../core/task-scheduler.ts';
import { ProcessingIndicator } from '../ui/ProcessingIndicator.tsx';

const MAX_VISIBLE_NOTICES = 3;

interface AutosaveNotice {
  state: 'saving' | 'error';
  title: string;
  detail: string;
}

interface ActionFailureNotice {
  id: number;
  message: string;
}

export function TaskNoticeCenter({
  scheduler,
  persistence,
  client,
}: {
  scheduler: TaskScheduler;
  persistence: PersistenceService;
  client: ViewClient;
}) {
  const subscribe = useMemo(() => scheduler.subscribe.bind(scheduler), [scheduler]);
  useSyncExternalStore(subscribe, scheduler.getVersion, () => 0);
  const autosave = useAutosaveNotice(persistence);
  const actionFailure = useActionFailureNotice(client);
  const visible = scheduler.snapshot().tasks
    .filter((task) => task.noticeVisible)
    .sort((left, right) => taskRank(left) - taskRank(right) || right.priority - left.priority);

  if (visible.length === 0 && !autosave && !actionFailure) return null;
  const taskLimit = Math.max(0, MAX_VISIBLE_NOTICES - (autosave ? 1 : 0) - (actionFailure ? 1 : 0));
  const hidden = Math.max(0, visible.length - taskLimit);

  return (
    <section className="task-notice-center" aria-label="后台处理与会话恢复状态" aria-live="polite">
      {actionFailure && (
        <article className="task-notice autosave-notice autosave-notice-error action-error-notice" role="alert">
          <span className="autosave-notice-indicator" aria-hidden="true" />
          <span className="task-notice-copy">
            <strong>操作没有完成</strong>
            <small>{actionFailure.message}</small>
          </span>
          <span className="task-notice-progress-label">失败</span>
          <progress className="task-notice-progress" max={1} value={1} aria-label="操作失败" />
        </article>
      )}
      {autosave && (
        <article className={`task-notice autosave-notice autosave-notice-${autosave.state}`} role="status">
          {autosave.state === 'saving'
            ? <ProcessingIndicator size={13} />
            : <span className="autosave-notice-indicator" aria-hidden="true" />}
          <span className="task-notice-copy">
            <strong>{autosave.title}</strong>
            <small>{autosave.detail}</small>
          </span>
          <span className="task-notice-progress-label">
            {autosave.state === 'saving' ? '写入中' : '异常'}
          </span>
          <progress
            className="task-notice-progress"
            max={1}
            value={autosave.state === 'saving' ? undefined : 1}
            aria-label="会话恢复状态"
          />
        </article>
      )}
      {visible.slice(0, taskLimit).map((task) => (
        <article className={`task-notice task-notice-${task.state}`} role="status" key={task.id}>
          <ProcessingIndicator size={13} paused={task.state === 'paused'} />
          <span className="task-notice-copy">
            <strong>{task.label}</strong>
            <small>{taskStateLabel(task)} · 数据量较大时可能需要一些时间</small>
          </span>
          <span className="task-notice-progress-label">{progressLabel(task)}</span>
          <progress
            className="task-notice-progress"
            max={1}
            value={task.progress > 0 ? task.progress : undefined}
            aria-label={`${task.label}进度`}
          />
        </article>
      ))}
      {hidden > 0 && (
        <div className="task-notice-more" role="status">
          <ProcessingIndicator size={9} />另有 {hidden} 项后台任务正在处理
        </div>
      )}
    </section>
  );
}

function useActionFailureNotice(client: ViewClient): ActionFailureNotice | undefined {
  const [notice, setNotice] = useState<ActionFailureNotice>();
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => client.subscribeSignal<{ message?: string }>('system.ui.action.failed', (event) => {
    if (dismissTimer.current !== undefined) clearTimeout(dismissTimer.current);
    setNotice({ id: Date.now(), message: event.payload.message?.trim() || '请稍后重试，详情已写入诊断中心。' });
    dismissTimer.current = setTimeout(() => {
      dismissTimer.current = undefined;
      setNotice(undefined);
    }, 6_000);
    return undefined;
  }), [client]);
  useEffect(() => () => {
    if (dismissTimer.current !== undefined) clearTimeout(dismissTimer.current);
  }, []);
  return notice;
}

function useAutosaveNotice(persistence: PersistenceService): AutosaveNotice | undefined {
  const [notice, setNotice] = useState<AutosaveNotice>();
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const clearDismissTimer = () => {
      if (dismissTimer.current === undefined) return;
      clearTimeout(dismissTimer.current);
      dismissTimer.current = undefined;
    };
    const dismissAfter = (delay: number) => {
      clearDismissTimer();
      dismissTimer.current = setTimeout(() => {
        dismissTimer.current = undefined;
        setNotice(undefined);
      }, delay);
    };
    const unsubscribe = persistence.subscribe(() => {
      const status = persistence.snapshot();
      if (status.state === 'error') {
        setNotice({
          state: 'error',
          title: '会话恢复更新失败',
          detail: status.error ? `请检查存储空间：${status.error}` : '请检查浏览器存储空间',
        });
        dismissAfter(8_000);
      }
    });
    return () => {
      unsubscribe();
      clearDismissTimer();
    };
  }, [persistence]);

  return notice;
}

function taskStateLabel(task: ScheduledTaskSnapshot): string {
  if (task.state === 'queued') return '正在等待后台资源';
  if (task.state === 'paused') return '处理已暂停';
  if (task.state === 'retrying') return `正在重试（第 ${task.attempts + 1} 次）`;
  return '正在后台处理，你可以继续其他操作';
}

function progressLabel(task: ScheduledTaskSnapshot): string {
  if (task.state === 'paused') return '暂停';
  if (task.progress <= 0) return '处理中';
  return `${Math.round(task.progress * 100)}%`;
}

function taskRank(task: ScheduledTaskSnapshot): number {
  if (task.state === 'running') return 0;
  if (task.state === 'retrying') return 1;
  if (task.state === 'queued') return 2;
  return 3;
}
