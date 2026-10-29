import { createId, type TaskHandle, type TaskOptions } from './contracts.ts';
import { isAbortError } from '../services/abort.ts';

export type TaskState = 'queued' | 'running' | 'paused' | 'retrying';

export interface ScheduledTaskSnapshot {
  id: string;
  owner: string;
  category: string;
  label: string;
  priority: number;
  state: TaskState;
  progress: number;
  attempts: number;
  estimatedCost?: number;
  timeoutMs?: number;
  delayMs?: number;
  aborted: boolean;
  noticeVisible: boolean;
}

export interface TaskSchedulerSnapshot {
  active: number;
  activeCost: number;
  costBudget: number;
  queued: number;
  paused: number;
  tasks: ScheduledTaskSnapshot[];
}

interface QueuedTask<TResult = unknown> {
  id: string;
  owner: string;
  options: TaskOptions<TResult>;
  rootController: AbortController;
  attemptController?: AbortController;
  resolve: (value: TResult) => void;
  reject: (reason: unknown) => void;
  state: TaskState;
  running: boolean;
  paused: boolean;
  settled: boolean;
  attempts: number;
  progress: number;
  noticeVisible: boolean;
  delayTimer?: ReturnType<typeof setTimeout>;
  noticeTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  pauseWaiters: Set<() => void>;
}

const MAX_RETRIES = 5;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_SCHEDULE_DELAY_MS = 30 * 60_000;
const MAX_NOTICE_DELAY_MS = 60_000;
const DEFAULT_NOTICE_DELAY_MS = 1_200;

export class TaskScheduler {
  private readonly concurrency: number;
  private readonly costBudget: number;
  private active = 0;
  private activeCost = 0;
  private readonly queue: QueuedTask[] = [];
  private readonly tasks = new Map<string, QueuedTask>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(concurrency = 2, costBudget = 16) {
    this.concurrency = Math.max(1, concurrency);
    this.costBudget = Math.max(1, costBudget);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion = (): number => this.version;

  schedule<TResult>(owner: string, options: TaskOptions<TResult>): TaskHandle<TResult> {
    validateOptions(options);
    const id = options.id ?? createId('task');
    if (this.tasks.has(id)) throw new Error(`Duplicate task id: ${id}`);
    const rootController = new AbortController();
    let resolve!: (value: TResult) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<TResult>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const task: QueuedTask<TResult> = {
      id,
      owner,
      options,
      rootController,
      resolve,
      reject,
      state: 'queued',
      running: false,
      paused: false,
      settled: false,
      attempts: 0,
      progress: 0,
      noticeVisible: options.noticeAfterMs === 0,
      pauseWaiters: new Set(),
    };
    this.tasks.set(id, task as QueuedTask);
    if ((options.delayMs ?? 0) > 0) {
      task.noticeVisible = false;
      task.delayTimer = setTimeout(() => {
        task.delayTimer = undefined;
        if (task.settled || task.rootController.signal.aborted) return;
        this.enqueue(task as QueuedTask);
      }, options.delayMs);
      (task.delayTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    } else this.enqueue(task as QueuedTask);
    this.notify();
    this.pump();
    return {
      id,
      result,
      cancel: () => this.cancelTask(task as QueuedTask),
      pause: () => this.pauseTask(task as QueuedTask),
      resume: () => this.resumeTask(task as QueuedTask),
    };
  }

  cancelOwner(owner: string): void {
    for (const task of [...this.tasks.values()]) {
      if (task.owner === owner) this.cancelTask(task);
    }
  }

  snapshot(): TaskSchedulerSnapshot {
    return {
      active: this.active,
      activeCost: this.activeCost,
      costBudget: this.costBudget,
      queued: this.queue.filter((task) => !task.paused).length,
      paused: [...this.tasks.values()].filter((task) => task.paused).length,
      tasks: [...this.tasks.values()].map((task) => ({
        id: task.id,
        owner: task.owner,
        category: task.options.category,
        label: task.options.label?.trim() || task.options.category,
        priority: task.options.priority,
        state: task.state,
        progress: task.progress,
        attempts: task.attempts,
        estimatedCost: task.options.estimatedCost,
        timeoutMs: task.options.timeoutMs,
        delayMs: task.options.delayMs,
        aborted: task.rootController.signal.aborted,
        noticeVisible: task.noticeVisible,
      })),
    };
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const index = this.queue.findIndex((task) =>
        !task.paused && !task.settled &&
        (this.active === 0 || this.activeCost + taskCost(task) <= this.costBudget));
      if (index < 0) return;
      const [task] = this.queue.splice(index, 1);
      void this.runAttempt(task);
    }
  }

  private async runAttempt(task: QueuedTask): Promise<void> {
    if (task.settled || task.rootController.signal.aborted) {
      this.finishRejected(task, abortReason(task.rootController.signal));
      return;
    }
    this.active += 1;
    this.activeCost += taskCost(task);
    task.running = true;
    task.state = task.paused ? 'paused' : 'running';
    task.attempts += 1;
    task.progress = 0;
    const attemptController = new AbortController();
    task.attemptController = attemptController;
    const relayAbort = () => attemptController.abort(abortReason(task.rootController.signal));
    task.rootController.signal.addEventListener('abort', relayAbort, { once: true });
    const report = (progress: number) => {
      task.progress = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
      this.notify();
    };
    const control = { waitIfPaused: () => this.waitIfPaused(task, attemptController.signal) };

    try {
      await control.waitIfPaused();
      const value = await runWithGuards(
        task.options.run(attemptController.signal, report, control),
        attemptController,
        task.options.timeoutMs,
      );
      if (!task.settled) {
        task.progress = 1;
        task.settled = true;
        this.clearNoticeTimer(task);
        task.resolve(value);
        this.tasks.delete(task.id);
      }
    } catch (error) {
      if (this.shouldRetry(task, error)) this.scheduleRetry(task);
      else this.finishRejected(task, error);
    } finally {
      task.rootController.signal.removeEventListener('abort', relayAbort);
      task.attemptController = undefined;
      task.running = false;
      this.active -= 1;
      this.activeCost -= taskCost(task);
      this.notify();
      this.pump();
    }
  }

  private shouldRetry(task: QueuedTask, error: unknown): boolean {
    if (task.rootController.signal.aborted || isAbortError(error)) return false;
    return task.attempts <= (task.options.maxRetries ?? 0);
  }

  private scheduleRetry(task: QueuedTask): void {
    const baseDelay = task.options.retryDelayMs ?? 250;
    const delay = Math.min(30_000, baseDelay * 2 ** Math.max(0, task.attempts - 1));
    task.state = task.paused ? 'paused' : 'retrying';
    task.retryTimer = setTimeout(() => {
      task.retryTimer = undefined;
      if (task.settled || task.rootController.signal.aborted) {
        this.finishRejected(task, abortReason(task.rootController.signal));
        return;
      }
      task.state = task.paused ? 'paused' : 'queued';
      this.queue.push(task);
      this.sortQueue();
      this.notify();
      this.pump();
    }, delay);
  }

  private cancelTask(task: QueuedTask): void {
    if (task.settled) return;
    if (task.delayTimer) clearTimeout(task.delayTimer);
    task.delayTimer = undefined;
    this.clearNoticeTimer(task);
    task.rootController.abort(new DOMException('Task cancelled', 'AbortError'));
    task.attemptController?.abort(new DOMException('Task cancelled', 'AbortError'));
    if (task.retryTimer) clearTimeout(task.retryTimer);
    task.retryTimer = undefined;
    this.releasePauseWaiters(task);
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    if (!task.running) this.finishRejected(task, abortReason(task.rootController.signal));
    this.notify();
    this.pump();
  }

  private pauseTask(task: QueuedTask): void {
    if (task.settled || task.paused) return;
    task.paused = true;
    task.state = 'paused';
    this.notify();
  }

  private resumeTask(task: QueuedTask): void {
    if (task.settled || !task.paused) return;
    task.paused = false;
    task.state = task.running ? 'running' : task.retryTimer ? 'retrying' : 'queued';
    this.releasePauseWaiters(task);
    this.notify();
    this.pump();
  }

  private async waitIfPaused(task: QueuedTask, signal: AbortSignal): Promise<void> {
    while (task.paused) {
      if (signal.aborted) throw abortReason(signal);
      await new Promise<void>((resolve) => task.pauseWaiters.add(resolve));
    }
    if (signal.aborted) throw abortReason(signal);
  }

  private releasePauseWaiters(task: QueuedTask): void {
    for (const resolve of task.pauseWaiters) resolve();
    task.pauseWaiters.clear();
  }

  private finishRejected(task: QueuedTask, error: unknown): void {
    if (task.settled) return;
    task.settled = true;
    this.clearNoticeTimer(task);
    task.reject(error);
    this.tasks.delete(task.id);
  }

  private clearNoticeTimer(task: QueuedTask): void {
    if (task.noticeTimer === undefined) return;
    clearTimeout(task.noticeTimer);
    task.noticeTimer = undefined;
  }

  private sortQueue(): void {
    this.queue.sort((left, right) =>
      right.options.priority - left.options.priority || left.id.localeCompare(right.id));
  }

  private enqueue(task: QueuedTask): void {
    if (task.settled || task.rootController.signal.aborted || this.queue.includes(task)) return;
    task.state = task.paused ? 'paused' : 'queued';
    this.queue.push(task);
    this.sortQueue();
    if (!task.noticeVisible && task.noticeTimer === undefined) {
      const delay = task.options.noticeAfterMs ?? DEFAULT_NOTICE_DELAY_MS;
      if (delay === 0) task.noticeVisible = true;
      else {
        task.noticeTimer = setTimeout(() => {
          task.noticeTimer = undefined;
          if (task.settled) return;
          task.noticeVisible = true;
          this.notify();
        }, delay);
      }
    }
    this.notify();
    this.pump();
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

function validateOptions<TResult>(options: TaskOptions<TResult>): void {
  if (!options.category.trim()) throw new Error('Task category is required');
  if (!Number.isFinite(options.priority)) throw new Error('Task priority must be finite');
  if (options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new Error(`Task timeout must be between 1 and ${MAX_TIMEOUT_MS}ms`);
  }
  if (options.maxRetries !== undefined &&
    (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > MAX_RETRIES)) {
    throw new Error(`Task maxRetries must be between 0 and ${MAX_RETRIES}`);
  }
  if (options.retryDelayMs !== undefined &&
    (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0 || options.retryDelayMs > 60_000)) {
    throw new Error('Task retryDelayMs must be between 0 and 60000ms');
  }
  if (options.estimatedCost !== undefined &&
    (!Number.isFinite(options.estimatedCost) || options.estimatedCost < 0)) {
    throw new Error('Task estimatedCost must be a non-negative finite number');
  }
  if (options.label !== undefined && (typeof options.label !== 'string' || !options.label.trim())) {
    throw new Error('Task label must not be empty');
  }
  if (options.delayMs !== undefined &&
    (!Number.isFinite(options.delayMs) || options.delayMs < 0 || options.delayMs > MAX_SCHEDULE_DELAY_MS)) {
    throw new Error(`Task delayMs must be between 0 and ${MAX_SCHEDULE_DELAY_MS}ms`);
  }
  if (options.noticeAfterMs !== undefined &&
    (!Number.isFinite(options.noticeAfterMs) || options.noticeAfterMs < 0 ||
      options.noticeAfterMs > MAX_NOTICE_DELAY_MS)) {
    throw new Error(`Task noticeAfterMs must be between 0 and ${MAX_NOTICE_DELAY_MS}ms`);
  }
}

function taskCost(task: QueuedTask): number {
  return Math.max(1, task.options.estimatedCost ?? 1);
}

async function runWithGuards<TResult>(
  operation: Promise<TResult>,
  controller: AbortController,
  timeoutMs?: number,
): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(abortReason(controller.signal));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      controller.abort(new DOMException(`Task timed out after ${timeoutMs}ms`, 'TimeoutError'));
    }, timeoutMs);
  }
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Task cancelled', 'AbortError');
}
