import type { AIOperation } from '../../protocols/ai.ts';

export type AIOperationCategory = '通用' | '内容处理' | '信息处理' | '分析规划' | '创意生成';

export interface AIOperationDefinition {
  operation: AIOperation;
  label: string;
  category: AIOperationCategory;
  description: string;
  instruction: string;
  temperature: number;
  naturalPatterns?: readonly RegExp[];
}

/**
 * One declarative catalog drives parsing, suggestions, labels and model
 * instructions. Adding a task must not create a second switch in the panel.
 */
export const AI_OPERATION_DEFINITIONS: readonly AIOperationDefinition[] = [
  {
    operation: 'general', label: '通用', category: '通用', temperature: 0.45,
    description: '不套用预设类型，直接按照要求处理',
    instruction: '不要预设内容领域，直接按照用户说明、限制和交付形式完成任务',
  },
  {
    operation: 'canvas-control', label: '画布操作', category: '通用', temperature: 0.25,
    description: '通过画布控制插件生成可审查的对象操作计划',
    instruction: '按用户本次要求规划画布对象操作，只使用控制插件本轮提供的范围和操作类型',
  },
  {
    operation: 'polish', label: '润色', category: '内容处理', temperature: 0.45,
    naturalPatterns: [/^(?:润色|顺一下|改善表达)/u, /^(?:把|将).*(?:润色|顺一下|读起来.{0,4}(?:顺|自然))/u],
    description: '改善表达、结构和清晰度', instruction: '改善表达、结构和清晰度，不改变事实、数据、结论与约束',
  },
  {
    operation: 'expand', label: '扩写', category: '内容处理', temperature: 0.72,
    naturalPatterns: [/^(?:扩写|展开|续写|接着写|继续写)/u, /^(?:把|将).*(?:扩写|展开|扩到|写得更详细)/u],
    description: '在已有资料和限制内扩展', instruction: '在已有证据和限制内扩展；缺少关键事实时标明缺口，不得虚构补齐',
  },
  {
    operation: 'shorten', label: '缩写', category: '内容处理', temperature: 0.35,
    naturalPatterns: [/^(?:缩写|缩短|精简|压缩|再短一点|再精简一点)/u, /^(?:把|将).*(?:缩短|精简|压到|压缩到)/u],
    description: '压缩篇幅并保留关键信息', instruction: '压缩篇幅，保留关键事实、决定、条件、数字和风险',
  },
  {
    operation: 'rewrite', label: '改写', category: '内容处理', temperature: 0.5,
    naturalPatterns: [/^(?:改写|重写|再含蓄一点|再改写一下)/u, /^(?:把|将).*(?:改写|重写|改得|写得|改成第一人称|改成第三人称)/u],
    description: '按目标重新组织和表达', instruction: '按照用户指定的对象、用途、语气和结构重新表达',
  },
  {
    operation: 'translate', label: '翻译', category: '内容处理', temperature: 0.25,
    naturalPatterns: [/^(?:翻译|译成|翻成)/u, /^(?:把|将).*(?:翻译|翻成|译成)/u],
    description: '翻译并保持含义与术语一致', instruction: '翻译为用户指定语言；保持含义、数字、专名、术语和格式关系一致',
  },
  {
    operation: 'summarize', label: '总结', category: '信息处理', temperature: 0.35,
    naturalPatterns: [/^(?:总结|概括|归纳|提炼重点)/u, /^(?:把|将).*(?:总结|概括|归纳|提炼重点)/u],
    description: '提炼重点、结论和限定条件', instruction: '提炼重点、结论、决定、限定条件和未解决问题',
  },
  {
    operation: 'extract', label: '提取', category: '信息处理', temperature: 0.25,
    naturalPatterns: [/^(?:提取|列出|抽取)/u, /^(?:把|将).*(?:列出来|提取出来)/u],
    description: '提取指定字段或事实', instruction: '只提取用户要求的信息，保留来源关系；没有找到时明确说明',
  },
  {
    operation: 'classify', label: '分类', category: '信息处理', temperature: 0.3,
    naturalPatterns: [/^(?:分类|归类)/u, /^(?:把|将).*(?:归类|分类)/u],
    description: '建立规则并分类', instruction: '先说明分类规则，再完成分类；模糊项和多重归属单独标明',
  },
  {
    operation: 'compare', label: '对比', category: '信息处理', temperature: 0.3,
    naturalPatterns: [/^(?:对比|比较|对照)/u, /^(?:把|将).*(?:对比|对照)/u],
    description: '比较共同点、差异和适用条件', instruction: '按一致维度比较共同点、差异、证据、适用条件和未知项',
  },
  {
    operation: 'verify', label: '查错', category: '信息处理', temperature: 0.2,
    naturalPatterns: [/^(?:查错|检查|核对|找出矛盾)/u],
    description: '检查矛盾、遗漏和可疑内容', instruction: '检查矛盾、遗漏、计算、引用和事实依据；区分确定错误与待核实项',
  },
  {
    operation: 'analyze', label: '分析', category: '分析规划', temperature: 0.35,
    naturalPatterns: [/^(?:分析|剖析)/u],
    description: '分析原因、关系、影响和风险', instruction: '根据可用证据分析原因、关系、影响、风险和未知条件',
  },
  {
    operation: 'plan', label: '规划', category: '分析规划', temperature: 0.4,
    naturalPatterns: [/^(?:规划|制定计划|安排)/u, /^给.+(?:制定|安排).*(?:计划|步骤)/u],
    description: '制定目标、步骤和检查点', instruction: '形成目标、约束、步骤、负责人或资源、检查点和风险预案',
  },
  {
    operation: 'decompose', label: '拆解', category: '分析规划', temperature: 0.35,
    naturalPatterns: [/^(?:拆解|拆分任务)/u, /^(?:把|将).*(?:拆成|拆解成|拆分为).*(?:任务|步骤|件事)/u],
    description: '拆成可执行的任务和依赖', instruction: '把目标拆成可执行任务，标出依赖、输入、输出、顺序和完成标准',
  },
  {
    operation: 'evaluate', label: '评估', category: '分析规划', temperature: 0.3,
    naturalPatterns: [/^(?:评估|评价)/u],
    description: '按明确标准评估方案', instruction: '先声明评估标准，再比较收益、成本、风险、证据强度和适用边界',
  },
  {
    operation: 'simulate', label: '推演', category: '分析规划', temperature: 0.5,
    naturalPatterns: [/^(?:推演|模拟)/u, /^(?:如果|假如|要是).*(?:会怎样|会怎么|会发生)/u],
    description: '推演条件变化与可能结果', instruction: '区分已知条件与假设，推演关键路径、可能结果、风险和触发条件',
  },
  {
    operation: 'decide', label: '决策', category: '分析规划', temperature: 0.3,
    naturalPatterns: [/^(?:决策|帮我选择|帮我选|选哪个)/u, /^哪个.+(?:更合适|更适合)/u],
    description: '整理选项并给出可审查建议', instruction: '整理选项、目标、约束、权衡和证据，再给出可审查建议；不要替用户隐瞒取舍',
  },
  {
    operation: 'brainstorm', label: '发散', category: '创意生成', temperature: 0.82,
    naturalPatterns: [/^(?:发散|头脑风暴)/u, /^给我.+(?:走向|方向|思路|创意)/u],
    description: '从多个方向产生方案', instruction: '从不同方向产生互不重复的候选方案，并标明各自特点和适用条件',
  },
  {
    operation: 'name', label: '取名', category: '创意生成', temperature: 0.82,
    naturalPatterns: [/^(?:取名|起名)/u, /^给.+(?:起|取).*(?:名|名字)/u],
    description: '生成多个命名方案', instruction: '根据对象、受众、语境和限制给出多个命名，并简述差异和风险',
  },
  {
    operation: 'outline', label: '大纲', category: '创意生成', temperature: 0.55,
    naturalPatterns: [/^(?:列|写|生成|拟|给我).*(?:大纲)/u],
    description: '生成适合当前任务的层级结构', instruction: '根据当前任务生成清晰的层级结构，不默认它属于某种内容类型',
  },
  {
    operation: 'detailed-outline', label: '细纲', category: '创意生成', temperature: 0.55,
    naturalPatterns: [/^(?:列|写|生成|拟|给我).*细纲/u, /^细化到(?:每|各)/u],
    description: '生成可直接执行的详细结构', instruction: '根据当前任务生成包含目标、内容、顺序和检查点的详细结构',
  },
  {
    operation: 'script', label: '脚本', category: '创意生成', temperature: 0.7,
    naturalPatterns: [/^(?:写|生成|改成|写成).*(?:脚本|剧本)/u],
    description: '生成指定用途和媒介的脚本', instruction: '先遵循用户指定的用途、媒介、受众和格式，再生成相应脚本',
  },
  {
    operation: 'copywriting', label: '文案', category: '创意生成', temperature: 0.75,
    naturalPatterns: [/^(?:写|生成|给我|帮我写).*(?:文案|作品简介|宣传语)/u],
    description: '生成面向指定对象的文案', instruction: '按照目标、受众、渠道、语气、长度和合规限制生成文案',
  },
];

const BY_OPERATION = new Map(AI_OPERATION_DEFINITIONS.map((definition) => [definition.operation, definition]));
const WRITEBACK_OPERATIONS = new Set<AIOperation>([
  'polish',
  'expand',
  'shorten',
  'rewrite',
  'translate',
]);

export function isAIOperation(value: unknown): value is AIOperation {
  return typeof value === 'string' && BY_OPERATION.has(value as AIOperation);
}

export function operationDefinition(operation: AIOperation): AIOperationDefinition {
  return BY_OPERATION.get(operation) ?? BY_OPERATION.get('general')!;
}

export function naturalAIOperation(prompt: string): AIOperation | undefined {
  const text = prompt.trim().replace(/^(?:请|帮我)\s*/u, '')
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"\r\n]*"|@\[[^\]]*\]/gu, '引用');
  if (/^(?:先别|不要|别|暂不|不用)/u.test(text)) return undefined;
  // Detailed outlines and scripts take precedence over generic listing/extraction.
  const matches = AI_OPERATION_DEFINITIONS.filter(definition => definition.naturalPatterns?.some(pattern => pattern.test(text)));
  const specific = matches.find(definition => ['detailed-outline', 'outline', 'script', 'copywriting', 'name', 'brainstorm'].includes(definition.operation));
  return (specific ?? matches[0])?.operation;
}

export function operationLabel(operation: AIOperation): string {
  return operationDefinition(operation).label;
}

export function operationInstruction(operation: AIOperation): string {
  return operationDefinition(operation).instruction;
}

export function operationTemperature(operation: AIOperation): number {
  return operationDefinition(operation).temperature;
}

/** These operations may create a revision-checked canvas write-back proposal. */
export function operationCreatesWriteback(operation: AIOperation): boolean {
  return WRITEBACK_OPERATIONS.has(operation);
}
