'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { PluginSnapshot, ViewClient } from '../../core/contracts.ts';
import { IconButton } from '../../ui/Icon.tsx';

export function PluginCenterPanel({ client }: { client: ViewClient }) {
  const [plugins, setPlugins] = useState<PluginSnapshot[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const version = useSyncExternalStore(client.subscribeState, () => client.getOwnStateVersion('pluginCenterUI'), () => 0);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    setPlugins(await client.ask<PluginSnapshot[]>('system.plugins'));
  }, [client]);

  useEffect(() => {
    let current = true;
    void client.ask<{ open: boolean }>('pluginCenter.state').then((state) => {
      if (current) setOpen(state.open);
    });
    return () => { current = false; };
  }, [client, version]);

  useEffect(() => {
    let current = true;
    void client.ask<PluginSnapshot[]>('system.plugins').then((result) => {
      if (current) setPlugins(result);
    });
    return () => {
      current = false;
    };
  }, [client]);

  const toggle = async (plugin: PluginSnapshot) => {
    setBusy(plugin.id);
    setError('');
    try {
      await client.dispatch(plugin.status === 'active' ? 'plugin.stop' : 'plugin.start', { id: plugin.id });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(undefined);
    }
  };

  if (!open) return null;

  const sections: Array<{ category: PluginSnapshot['category']; label: string; copy: string }> = [
    { category: 'core', label: '核心组件', copy: '维持画布、内容和交互基础，存在依赖时不可停用。' },
    { category: 'feature', label: '可选功能', copy: '可以按工作方式启用或停用。' },
    { category: 'provider', label: 'AI 与同步服务', copy: '连接外部能力或本地模型，停用不会删除内容。' },
    { category: 'diagnostic', label: '管理与诊断', copy: '用于配置、排查和开发状态检查。' },
  ];

  return (
    <section className="plugin-center" aria-label="插件中心">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">微内核</span>
          <h2>插件运行状态</h2>
        </div>
        <IconButton icon="close" label="关闭插件中心" onClick={() => void client.dispatch('pluginCenter.close')} />
      </div>
      <p className="panel-copy">这里只展示用户可理解的功能边界；内部资源和权限详情请到诊断中心查看。</p>
      {error && <p className="plugin-toggle-error">{error}</p>}
      {sections.map((section) => {
        const sectionPlugins = plugins.filter((plugin) => plugin.category === section.category);
        if (sectionPlugins.length === 0) return null;
        return (
          <section className="plugin-section" aria-labelledby={`plugin-section-${section.category}`} key={section.category}>
            <div className="plugin-section-heading">
              <h3 id={`plugin-section-${section.category}`}>{section.label}</h3>
              <p>{section.copy}</p>
            </div>
            <div className="plugin-list">
              {sectionPlugins.map((plugin) => {
                const active = plugin.status === 'active';
                const reason = plugin.blockers.length > 0
                  ? `正在被${plugin.blockers.join('、')}使用`
                  : plugin.id === 'plugin-center'
                    ? '当前管理界面不可停用自身'
                    : undefined;
                return (
                  <div className="plugin-row" key={plugin.id}>
                    <span className={`plugin-state ${active ? 'active' : ''}`} aria-hidden="true" />
                    <div>
                      <strong>{plugin.name}</strong>
                      <span>{reason ?? pluginStatusLabel(plugin.status)}</span>
                    </div>
                    <button
                      className={`switch ${active ? 'on' : ''}`}
                      type="button"
                      role="switch"
                      aria-checked={active}
                      aria-label={`${active ? '停用' : '启用'}${plugin.name}`}
                      title={reason ?? `${active ? '停用' : '启用'}${plugin.name}`}
                      disabled={!plugin.toggleable || busy === plugin.id}
                      onClick={() => void toggle(plugin)}
                    >
                      <i />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </section>
  );
}

function pluginStatusLabel(status: PluginSnapshot['status']): string {
  if (status === 'active') return '已启用';
  if (status === 'paused') return '已暂停';
  if (status === 'stopped' || status === 'removed') return '已停用，数据仍保留';
  if (status === 'faulted') return '运行异常，请前往诊断中心';
  return '状态切换中';
}
