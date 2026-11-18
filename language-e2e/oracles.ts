import { isRecord } from '../src/core/contracts.ts';
import { body, records, type Observation } from './harness.ts';
import type { LanguageCase } from './corpus.ts';
import type { Fixture } from './fixture.ts';

const containsValue = (value: unknown, key: string, expected: unknown): boolean => isRecord(value)
  ? value[key] === expected || Object.values(value).some(item => containsValue(item, key, expected))
  : Array.isArray(value) && value.some(item => containsValue(item, key, expected));

/** All positive decisions require observed UI, stored document, file bytes or grounded answer evidence. */
export function judge(item: LanguageCase, result: Observation, fixture: Fixture): Observation {
  const finish = (verdict: string, reason: string) => Object.assign(result, { verdict, reason });
  if (!result.before || !result.after) return finish('precondition-unavailable', result.harnessError ?? '助手输入界面的前置未建立');
  if (result.blockedRequests.length) return finish('blocked-external-request', '观察到被测试隔离层阻止的外部或API请求；未计为执行完成');
  if (result.pageErrors.length) return finish('application-error', result.pageErrors.join('; '));
  if (result.timedOut) return finish('timeout', '已发送原句，8秒内未取得终态；不把等待当成功');
  const before = result.before; const after = result.after;
  const reply = after.reply + '\n' + after.status;
  const unavailable = /请先.{0,30}(?:连接|配置|设置)|未配置.{0,15}(?:模型|连接)|(?:模型|连接).{0,12}(?:尚未配置|未配置)|没有可用.{0,15}模型|先连接模型|还不能可靠|无法确定|无法可靠|不能可靠|请说明要改/u.test(reply);
  if (item.limitation === 'local-generation' && unavailable) return finish('blocked-local-generative-model', '没有本地生成式模型，无法完成此任务；原始回复已保存');
  if (unavailable) return finish('unrecognized-or-misrouted', '机械操作进入未连接模型或无法理解的分支');
  const check = (ok: boolean, reason: string) => finish(ok ? 'verified' : 'failed', reason);
  const hasRegion = (text: string) => after.regions.some(label => label.includes(text));
  const nodes = records(result.document, 'textNode').filter(node => node.placement !== 'system');
  const hero = nodes.find(node => node.id === fixture.ids['主角']);
  const chapter = nodes.find(node => node.id === fixture.ids['第一章']);
  const original = fixture.source.document.namespaces.textNode?.[fixture.ids['第一章']!];
  const unchangedChapter = () => body(result.document, chapter) === body(fixture.source.document.namespaces, isRecord(original) ? original : undefined);
  const all = Object.values(result.document ?? {}).flatMap(value => Object.values(value).filter(isRecord));
  const groups = all.filter(value => Array.isArray(value.memberIds));
  const edges = all.filter(value => isRecord(value.from) && isRecord(value.to));
  const annotations = all.filter(value => isRecord(value.target) && typeof value.body === 'string');
  const group = (title: string) => groups.find(value => value.title === title);
  const edgeTo = (title: string) => edges.find(value => isRecord(value.from) && value.from.nodeId === fixture.ids['主角'] && isRecord(value.to) && value.to.nodeId === fixture.ids[title]);
  const doc = ['rename', 'create', 'move', 'edit', 'group-create', 'group-remove', 'edge-create', 'edge-label', 'annotation-add', 'paste', 'undo', 'redo',
    'resize', 'reset-size', 'text-box', 'group-add', 'group-kick', 'delete', 'cut', 'annotation-update', 'annotation-delete', 'import-text', 'horizontal', 'vertical', 'grid', 'duplicate-graph'];
  if (doc.includes(item.oracle) && !result.document) return finish('readback-unavailable', result.harnessError ?? '未读到实际保存文档');
  switch (item.oracle) {
    case 'duplicate-graph': {
      const originals = fixture.source.document.namespaces.textNode!;
      const added = nodes.filter(node => !Object.hasOwn(originals, String(node.id)));
      const sources = ['主角', '反派'].map(name => originals[fixture.ids[name]!] as Record<string, unknown>);
      const offset = Math.max(...sources.map(node => Number(node.x) + Number(node.width))) - Math.min(...sources.map(node => Number(node.x))) + 80;
      const clones = sources.map(source => added.find(node => String(node.title).startsWith(String(source.title)) &&
        body(result.document, node) === body(fixture.source.document.namespaces, source)));
      const unchanged = Object.entries(originals).every(([id, source]) => JSON.stringify(result.document?.textNode?.[id]) === JSON.stringify(source));
      const originalEdges = fixture.source.document.namespaces.connections ?? {};
      const addedEdges = edges.filter(edge => !Object.hasOwn(originalEdges, String(edge.id)));
      return check(unchanged && added.length === 2 && clones.every((node, index) => node &&
        Number(node.x) === Number(sources[index]!.x) + offset && node.y === sources[index]!.y) &&
        addedEdges.length === 1 && isRecord(addedEdges[0]!.from) && isRecord(addedEdges[0]!.to) &&
        addedEdges[0]!.from.nodeId === clones[0]?.id && addedEdges[0]!.to.nodeId === clones[1]?.id &&
        Object.entries(originalEdges).every(([id, edge]) => JSON.stringify(result.document?.connections?.[id]) === JSON.stringify(edge)),
      '实际书籍中两张卡及内部连线一并复制到右侧，间距80，原节点及原连线逐条保持');
    }
    case 'zoom60': return check(after.zoom === 0.6, '工具栏实际倍率必须为60%');
    case 'zoom40': return check(after.zoom === 0.4, '从100%缩小60%必须得到40%');
    case 'group-focus': {
      const id = group('人物组')?.id;
      const gap = typeof id === 'string' ? after.groupCenterError?.[id] : undefined;
      return check(after.zoom === 0.6 && typeof gap === 'number' && gap < 2 &&
        Object.values(fixture.ids).every(nodeId => {
          const original = fixture.source.document.namespaces.textNode?.[nodeId];
          const observed = nodes.find(node => node.id === nodeId);
          return isRecord(original) && observed?.x === original.x && observed?.y === original.y;
        }), '群组边框居中，实际缩放为60%，所有卡片的存盘坐标保持原值');
    }
    case 'hand': return check(after.hand && !before.hand, '实际手抓工具的aria-pressed从关闭变为开启');
    case 'map-open': return check(after.map && !before.map, '小地图实际显示，且初始关闭');
    case 'map-closed': return check(!after.map && before.map, '初始已打开的小地图实际关闭');
    case 'selected-hero': return check(after.selected.length === 1 && after.selected[0] === '主角' && /选|定位|主角/u.test(reply), '实际选区为主角，并取得执行答复');
    case 'selected-none': return check(before.selected.length > 0 && after.selected.length === 0, '选中对象从非空变为空');
    case 'selected-all': return check(after.selected.length >= 9 && before.selected.length < 9, '夹具9张公开卡均被选中');
    case 'box': return check(new Set(after.selected).size === 9 && Object.keys(fixture.ids).every(title => after.selected.includes(title)), '按夹具的实际几何，指定矩形与9张公开卡均相交');
    case 'editor-chapter': return check(after.editors.includes('第一章') && !before.editors.includes('第一章'), '右侧真实打开第一章');
    case 'editor-no-chapter': return check(before.editors.includes('第一章') && after.editors.length === 2 &&
      after.editors.includes('主角') && after.editors.includes('反派'), '真实编辑区中第一章已关闭，其他两个窗格仍打开');
    case 'editor-none': return check(before.editors.length > 0 && after.editors.length === 0, '真实编辑区中的既有窗格全部关闭');
    case 'editor-hero': case 'editor-next': case 'editor-previous': {
      const correct = item.oracle === 'editor-next' ? '第一章' : '主角';
      return check(before.activeEditor !== correct && after.activeEditor === correct && after.editors.length === before.editors.length,
        '真实编辑区的活动窗格切换到指定卡片，窗格数量保持');
    }
    case 'editor-range': return check(after.selectionText === '第一段：', '实际编辑器的DOM选区恰为前四个UTF-16字符');
    case 'editor-width': return check(Math.abs(after.editorWidth - 600) < 2 && Math.abs(before.editorWidth - 600) >= 2, '编辑区真实宽度为600px');
    case 'immersive-on': return check(after.immersive && !before.immersive, '真正进入沉浸写作视图');
    case 'immersive-off': return check(!after.immersive && before.immersive, '真正退出既有沉浸写作视图');
    case 'search-open': return check(hasRegion('查找') && !before.regions.some(label => label.includes('查找')), '查找窗口实际显示');
    case 'search-closed': return check(before.regions.some(label => label.includes('查找')) && !hasRegion('查找'), '已打开的查找窗口实际关闭');
    case 'palette-open': return check(hasRegion('全局颜色') || hasRegion('外观'), '实际显示外观所属面板');
    case 'palette-closed': return check(before.regions.some(label => /全局颜色|外观/u.test(label)) && !after.regions.some(label => /全局颜色|外观/u.test(label)), '既有外观面板关闭');
    case 'settings-open': return check(hasRegion('设置中心'), '设置中心实际可见');
    case 'keys-open': return check(hasRegion('快捷键'), '快捷键所属面板实际可见');
    case 'diagnostics-open': case 'operations-open': return check(hasRegion('诊断'), '诊断所属面板实际可见');
    case 'actions-open': return check(hasRegion('工作区动作'), '工作区动作目录实际可见');
    case 'provider-open': return check(hasRegion('模型') || hasRegion('连接'), '模型连接界面实际打开');
    case 'control-open': return check(hasRegion('画布控制'), '画布控制面板实际可见');
    case 'file-panel': return check(hasRegion('文件') || hasRegion('书籍'), '实际打开书籍与恢复面板');
    case 'library-open': return check(hasRegion('Echo-8 书库'), '书库首页真实出现');
    case 'library-closed': return check(before.regions.includes('Echo-8 书库') && !hasRegion('Echo-8 书库'), '从已打开书库回到当前画布');
    case 'assistant-more': return check(after.assistantCount > before.assistantCount, '助手窗口数真实增加');
    case 'assistant-closed': return check(before.assistantCount > 0 && after.assistantCount === 0, '所有助手窗口确实关闭');
    case 'rename': return check(hero?.title === '林舟', '存盘后的原主角ID对应标题必须为林舟');
    case 'create': return check(nodes.some(node => node.title === '旧案' && !body(result.document, node)), '实际新建唯一标题为旧案的空节点');
    case 'move': return check(hero?.x === 800 && hero?.y === 500, '实际文档坐标必须为800、500');
    case 'edit': return check(body(result.document, chapter).startsWith('追查从这里开始。') && body(result.document, chapter).includes('第二段：配角'), '实际仅替换首段并保留后文');
    case 'resize': return check(hero?.width === 400 && hero?.height === 240, '实际文档尺寸必须为400×240');
    case 'reset-size': {
      const old = fixture.source.document.namespaces.textNode?.[fixture.ids['主角']!];
      return check(isRecord(old) && hero?.width === old.width && hero?.height === old.height, '已人为放大的卡恢复夹具的默认宽高');
    }
    case 'text-box': return check(hero?.presentation === 'text-box', '真实节点形态为text-box');
    case 'delete': case 'cut': return check(!hero && nodes.some(node => node.title === '配角'), '目标主角被删除且配角仍存在');
    case 'group-create': return check(Boolean(group('待核对')) && (group('待核对')!.memberIds as string[]).length === 2 &&
      ['空白1', '空白2'].every(title => (group('待核对')!.memberIds as string[]).includes(fixture.ids[title]!)), '真实待核对组的成员恰为所选两张空卡');
    case 'group-any': return check(groups.some(value => (value.memberIds as string[]).includes(fixture.ids['空白1']!) && (value.memberIds as string[]).includes(fixture.ids['空白2']!)), '真实群组包含两张所选空卡');
    case 'group-remove': return check(!group('人物组') && Boolean(hero), '真实解组并保留成员');
    case 'group-add': return check(Boolean(group('人物组')) && (group('人物组')!.memberIds as string[]).includes(fixture.ids['空白1']!), '空白1真实加入既有的人物组');
    case 'group-kick': return check(Boolean(group('人物组')) && !(group('人物组')!.memberIds as string[]).includes(fixture.ids['主角']!) && Boolean(hero), '主角退出人物组且仍存在');
    case 'edge-create': return check(Boolean(edgeTo('线索')) && JSON.stringify(edgeTo('线索')).includes('title'), '存盘中存在从主角到线索的标题虚线');
    case 'edge-label': return check(edgeTo('反派')?.label === '宿敌', '正确的原连线标签确为宿敌');
    case 'edge-selected': case 'edge-selected-dashed': return check(edges.some(value => isRecord(value.from) && isRecord(value.to) &&
      new Set([value.from.nodeId, value.to.nodeId]).has(fixture.ids['空白1']) && new Set([value.from.nodeId, value.to.nodeId]).has(fixture.ids['空白2']) &&
      (item.oracle === 'edge-selected' || JSON.stringify(value).includes('title'))), '实际关系线连接所选两张空卡，线型按请求检查');
    case 'junction-add': return check(all.some(value => typeof value.id === 'string' && value.id.startsWith('junction:')), '实际生成连接中转点');
    case 'junction-remove': return check(!all.some(value => value.id === fixture.junctionId), '夹具里原有中转点真实删除');
    case 'annotation-add': return check(annotations.some(value => value.body === '需要核对动机' && isRecord(value.target) && value.target.targetId === fixture.ids['第一章']), '实际新增正确对象和正文的批注');
    case 'annotation-update': return check(annotations.some(value => value.id === fixture.annotationId && value.body === '动机已核实'), '原批注ID被更新，未另建副本');
    case 'annotation-delete': return check(!annotations.some(value => value.id === fixture.annotationId) && unchangedChapter(), '原批注被删除且章节正文保持');
    case 'annotation-any': return check(annotations.some(value => value.id !== fixture.annotationId && isRecord(value.target) && value.target.targetId === fixture.ids['主角']), '实际在主角上新增注释记录');
    case 'annotation-open': return check(hasRegion('注释') || hasRegion('标注'), '批注所属窗口真实显示');
    case 'annotation-closed': return check(before.regions.some(label => /注释|标注/u.test(label)) && !after.regions.some(label => /注释|标注/u.test(label)), '既有批注窗口实际关闭');
    case 'clipboard-copy': return check(isRecord(result.queries?.clipboard) && result.queries.clipboard.count === 1 &&
      typeof result.queries.clipboard.plainTextPreview === 'string' && result.queries.clipboard.plainTextPreview.includes('林舟'),
      '公开剪贴板读回一个对象且正文来自夹具的主角卡');
    case 'paste': return check(nodes.some(node => node.id !== fixture.ids['主角'] && body(result.document, node).startsWith('姓名：林舟。')), '实际生成具有新ID的主角正文副本');
    case 'undo': return check(!nodes.some(node => node.title === '临时卡'), '撤销后临时卡真实消失');
    case 'redo': return check(nodes.some(node => node.title === '临时卡'), '重做后临时卡真实恢复');
    case 'dark': return check(containsValue(result.queries?.appearance, 'themeId', 'dark'), '通过所属公开能力读回深色主题');
    case 'editor-color': return check(JSON.stringify(result.queries?.appearance).includes('#ffeecc'), '读回实际编辑器背景颜色');
    case 'eye-care': return check(JSON.stringify(result.queries?.appearance).includes('#e8f3e5') || containsValue(result.queries?.appearance, 'presetId', 'eye-care'), '读回真实护眼配色');
    case 'font18': return check(containsValue(result.queries?.format, 'fontSize', 18) && unchangedChapter(), '字号18实际生效，文字原文不变');
    case 'bold4': return check(containsValue(result.queries?.format, 'fontWeight', 700) && !containsValue(result.queries?.outside, 'fontWeight', 700) && unchangedChapter(), '前四字加粗、选区外未加粗且原文不变');
    case 'correction-off': return check(containsValue(result.queries?.correction, 'correctionEnabled', false), '从本地校对所属能力读回关闭状态');
    case 'completion-off': return check(containsValue(result.queries?.correction, 'completionEnabled', false), '从本地补全所属能力读回关闭状态');
    case 'autosave30': return check(containsValue(result.queries?.preferences, 'autosaveIntervalMs', 30000) || containsValue(result.queries?.preferences, 'intervalMs', 30000), '公开持久化偏好回读为30000ms');
    case 'checkpoint': return check(JSON.stringify(result.queries?.checkpoints).includes('验收点'), '真实恢复点目录出现验收点');
    case 'file-text': return check(result.downloads.some(file => file.name === '第一章.txt' && file.text?.includes('主角决定追查旧案')), '实际TXT文件名与章节原文正确');
    case 'file-word': return check(result.downloads.some(file => file.name.endsWith('.docx') && file.header.startsWith('504b')), '实际交付DOCX压缩容器');
    case 'file-copy': return check(result.downloads.some(file => file.name.endsWith('.e8') && file.bytes > 0), '自然语言操作实际交付项目副本，检查快照文件不计入');
    case 'import-text': return check(nodes.some(node => node.title === '验收资料' && body(result.document, node) === '本地导入内容'), '实际导入卡片标题和正文都匹配');
    case 'horizontal': case 'vertical': case 'grid': {
      const targets = ['空白1', '空白2', '线索'].map(title => nodes.find(node => node.title === title));
      if (targets.some(node => !node)) return check(false, '排列目标缺失');
      const aligned = item.oracle === 'horizontal' ? targets.every(node => node!.y === targets[0]!.y)
        : item.oracle === 'vertical' ? targets.every(node => node!.x === targets[0]!.x)
        : new Set(targets.map(node => node!.y)).size <= 2;
      return check(aligned && targets.some(node => {
        const old = fixture.source.document.namespaces.textNode?.[String(node!.id)];
        return isRecord(old) && (old.x !== node!.x || old.y !== node!.y);
      }), '实际目标布局满足方向或网格，且确实发生位置变化');
    }
    case 'preview-batch': case 'group-preview': case 'color-preview': case 'draft-preview': case 'extract-preview': case 'layout-preview': {
      const marker = item.oracle === 'color-preview' ? /ffcc00/iu : item.oracle === 'draft-preview' ? /追查从这里开始/u
        : item.oracle === 'extract-preview' ? /摘录/u : item.oracle === 'group-preview' ? /待核对/u : /新建|排列|位置|修改/u;
      return check(Boolean(after.preview) && marker.test(after.preview) && unchangedChapter(), '所属预览包含所要求的内容，实际原章正文尚未改写');
    }
    case 'remote-blocked': return finish('requires-local-authorization-simulation', '本轮禁止真实远端；只能验证授权等待，不能称已另存云端');
    case 'combo-model': case 'generation-cancel': return finish('blocked-local-generative-model', '本地生成式模型缺失，完整内容任务无法完成；未伪造稿件');
  }
  if (item.oracle.startsWith('reply:')) {
    const required = item.oracle.slice(6).split(',');
    return check(!/找不到|未找到|没有找到|无法|未能|不能/u.test(after.reply) && required.every(token => after.reply.includes(token)) && after.reply.length > required.join('').length + 4,
      '独立助手答复必须包含夹具中的实际事实：' + required.join('、'));
  }
  if (item.oracle === 'reply-number') return /\d+(?:\.\d+)?\s*(?:字|个|项|%|像素|px|秒|次|步)|(?:版本|修订|字号|宽度|高度).{0,8}\d/u.test(after.reply)
    ? finish('answer-needs-fact-verification', '观察到带数值答复，尚无独立同口径逐字段核验，未计通过')
    : check(false, '未返回所请求的可校验数值');
  if (!after.reply && !after.preview) return check(false, '没有取得动作完成结果或可操作预览');
  return finish('unverified', '已执行自然语言输入，但此场景还缺少独立结果断言；不计通过：' + item.oracle);
}
