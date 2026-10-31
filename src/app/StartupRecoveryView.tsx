export type StartupDiscardState = 'idle' | 'confirm' | 'working';

export function StartupFailureView({
  error,
  canDiscard,
  discardState,
  onRetry,
  onSafeStart,
  onRequestDiscard,
  onDiscard,
  onCancelDiscard,
}: {
  error: string;
  canDiscard: boolean;
  discardState: StartupDiscardState;
  onRetry: () => void;
  onSafeStart: () => void;
  onRequestDiscard: () => void;
  onDiscard: () => void;
  onCancelDiscard: () => void;
}) {
  return (
    <main className="fatal-screen">
      <span>启动保护</span>
      <h1>内核没有进入不完整状态</h1>
      <p>{error}</p>
      <div className="fatal-screen-actions">
        <button type="button" onClick={onRetry}>重新尝试</button>
        <button type="button" onClick={onSafeStart}>保留恢复数据，安全进入</button>
        {canDiscard && discardState === 'idle' && (
          <button type="button" className="danger" onClick={onRequestDiscard}>
            清除损坏的本机恢复数据
          </button>
        )}
        {canDiscard && discardState === 'confirm' && (
          <div className="fatal-screen-confirm" role="alert">
            <span>这会删除本机检查点、恢复点和事务日志，但保留个人设置；已保存的 .echo8 文件不受影响。</span>
            <button type="button" className="danger" onClick={onDiscard}>
              确认清除并进入空白画布
            </button>
            <button type="button" onClick={onCancelDiscard}>取消</button>
          </div>
        )}
        {discardState === 'working' && <span role="status">正在清理本机恢复数据…</span>}
      </div>
    </main>
  );
}

export function StartupSafeModeBanner({ onRetryRecovery }: { onRetryRecovery: () => void }) {
  return (
    <section className="startup-safe-mode" role="status">
      <span>
        <strong>恢复安全模式</strong>
        本次没有读取或覆盖浏览器恢复数据。请打开已保存的 .echo8 文件，并尽快另存一份。
      </span>
      <button type="button" onClick={onRetryRecovery}>退出安全模式并重试恢复</button>
    </section>
  );
}
