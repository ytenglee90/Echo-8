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
  const sections = groupPlugins(plugins);

  return (
    <section className="plugin-center" aria-label="插件中心">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{plugins.length} 个内置组件</span>
          <h2>插件中心</h2>
        </div>
        <IconButton icon="close" label="关闭插件中心" onClick={() => void client.dispatch('pluginCenter.close')} />
      </div>
      <p className="panel-copy">按使用场景整理。停用可选组件不会删除已有内容。</p>
      {error && <p className="plugin-toggle-error">{error}</p>}
      {sections.map((section) => {
        return (
          <section className="plugin-section" aria-labelledby={`plugin-section-${section.id}`} key={section.id}>
            <div className="plugin-section-heading">
              <h3 id={`plugin-section-${section.id}`}>{section.label}<span>{section.plugins.length}</span></h3>
              <p>{section.copy}</p>
            </div>
            <div className="plugin-list">
              {section.plugins.map((plugin) => {
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

interface PluginSection {
  id: string;
  label: string;
  copy: string;
  pluginIds: readonly string[];
}

const PLUGIN_SECTIONS: readonly PluginSection[] = [
  {
    id: 'canvas-writing',
    label: '画布与写作',
    copy: '节点、编辑、选择、连线和历史。',
    pluginIds: ['canvas', 'text-node', 'selection', 'connections', 'editor', 'history-controls'],
  },
  {
    id: 'organize-find',
    label: '组织与查找',
    copy: '群组、注释、排列、检索和文本辅助。',
    pluginIds: [
      'groups', 'annotations', 'smart-layout', 'clipboard', 'search-replace', 'search-index',
      'statistics', 'text-assist',
    ],
  },
  {
    id: 'books-appearance',
    label: '书籍与外观',
    copy: '书库、保存恢复、云同步和颜色。',
    pluginIds: ['book-library', 'import-export', 'cloud-sync', 'palette'],
  },
  {
    id: 'ai',
    label: 'AI 与语义能力',
    copy: '助手、模型连接和本地或远程语义检索。',
    pluginIds: ['ai-assistant', 'ai-provider', 'local-semantic-provider', 'semantic-provider'],
  },
  {
    id: 'workflow',
    label: '效率工具',
    copy: '命令面板和快捷键管理。',
    pluginIds: ['command-palette', 'shortcut-center'],
  },
  {
    id: 'system',
    label: '系统与诊断',
    copy: '插件管理和运行状态检查。',
    pluginIds: ['plugin-center', 'diagnostic-center'],
  },
] as const;

export function groupPlugins(plugins: PluginSnapshot[]): Array<Omit<PluginSection, 'pluginIds'> & {
  plugins: PluginSnapshot[];
}> {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const claimed = new Set<string>();
  const sections = PLUGIN_SECTIONS.flatMap((section) => {
    const grouped = section.pluginIds.flatMap((id) => {
      const plugin = byId.get(id);
      if (!plugin) return [];
      claimed.add(id);
      return [plugin];
    });
    return grouped.length > 0 ? [{
      id: section.id,
      label: section.label,
      copy: section.copy,
      plugins: grouped,
    }] : [];
  });
  const unclaimed = plugins.filter((plugin) => !claimed.has(plugin.id));
  if (unclaimed.length > 0) {
    sections.push({
      id: 'other',
      label: '其他组件',
      copy: '尚未归入固定场景的新组件。',
      plugins: unclaimed,
    });
  }
  return sections;
}

function pluginStatusLabel(status: PluginSnapshot['status']): string {
  if (status === 'active') return '已启用';
  if (status === 'paused') return '已暂停';
  if (status === 'stopped' || status === 'removed') return '已停用，数据仍保留';
  if (status === 'faulted') return '运行异常，请前往诊断中心';
  return '状态切换中';
}
