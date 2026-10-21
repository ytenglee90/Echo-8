import type { AIOperation } from '../../protocols/ai.ts';

export type AIOperationCategory = '通用' | '内容处理' | '信息处理' | '分析规划' | '创意生成';

export interface AIOperationDefinition {
  operation: AIOperation;
  label: string;
  category: AIOperationCategory;
  description: string;
  instruction: string;
  temperature: number;
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
    operation: 'polish', label: '润色', category: '内容处理', temperature: 0.45,
    description: '改善表达、结构和清晰度', instruction: '改善表达、结构和清晰度，不改变事实、数据、结论与约束',
  },
  {
    operation: 'expand', label: '扩写', category: '内容处理', temperature: 0.72,
    description: '在已有资料和限制内扩展', instruction: '在已有证据和限制内扩展；缺少关键事实时标明缺口，不得虚构补齐',
  },
  {
    operation: 'shorten', label: '缩写', category: '内容处理', temperature: 0.35,
    description: '压缩篇幅并保留关键信息', instruction: '压缩篇幅，保留关键事实、决定、条件、数字和风险',
  },
  {
    operation: 'rewrite', label: '改写', category: '内容处理', temperature: 0.5,
    description: '按目标重新组织和表达', instruction: '按照用户指定的对象、用途、语气和结构重新表达',
  },
  {
    operation: 'translate', label: '翻译', category: '内容处理', temperature: 0.25,
    description: '翻译并保持含义与术语一致', instruction: '翻译为用户指定语言；保持含义、数字、专名、术语和格式关系一致',
  },
  {
    operation: 'summarize', label: '总结', category: '信息处理', temperature: 0.35,
    description: '提炼重点、结论和限定条件', instruction: '提炼重点、结论、决定、限定条件和未解决问题',
  },
  {
    operation: 'extract', label: '提取', category: '信息处理', temperature: 0.25,
    description: '提取指定字段或事实', instruction: '只提取用户要求的信息，保留来源关系；没有找到时明确说明',
  },
  {
    operation: 'classify', label: '分类', category: '信息处理', temperature: 0.3,
    description: '建立规则并分类', instruction: '先说明分类规则，再完成分类；模糊项和多重归属单独标明',
  },
  {
    operation: 'compare', label: '对比', category: '信息处理', temperature: 0.3,
    description: '比较共同点、差异和适用条件', instruction: '按一致维度比较共同点、差异、证据、适用条件和未知项',
  },
  {
    operation: 'verify', label: '查错', category: '信息处理', temperature: 0.2,
    description: '检查矛盾、遗漏和可疑内容', instruction: '检查矛盾、遗漏、计算、引用和事实依据；区分确定错误与待核实项',
  },
  {
    operation: 'analyze', label: '分析', category: '分析规划', temperature: 0.35,
    description: '分析原因、关系、影响和风险', instruction: '根据可用证据分析原因、关系、影响、风险和未知条件',
  },
  {
    operation: 'plan', label: '规划', category: '分析规划', temperature: 0.4,
    description: '制定目标、步骤和检查点', instruction: '形成目标、约束、步骤、负责人或资源、检查点和风险预案',
  },
  {
    operation: 'decompose', label: '拆解', category: '分析规划', temperature: 0.35,
    description: '拆成可执行的任务和依赖', instruction: '把目标拆成可执行任务，标出依赖、输入、输出、顺序和完成标准',
  },
  {
    operation: 'evaluate', label: '评估', category: '分析规划', temperature: 0.3,
    description: '按明确标准评估方案', instruction: '先声明评估标准，再比较收益、成本、风险、证据强度和适用边界',
  },
  {
    operation: 'simulate', label: '推演', category: '分析规划', temperature: 0.5,
    description: '推演条件变化与可能结果', instruction: '区分已知条件与假设，推演关键路径、可能结果、风险和触发条件',
  },
  {
    operation: 'decide', label: '决策', category: '分析规划', temperature: 0.3,
    description: '整理选项并给出可审查建议', instruction: '整理选项、目标、约束、权衡和证据，再给出可审查建议；不要替用户隐瞒取舍',
  },
  {
    operation: 'brainstorm', label: '发散', category: '创意生成', temperature: 0.82,
    description: '从多个方向产生方案', instruction: '从不同方向产生互不重复的候选方案，并标明各自特点和适用条件',
  },
  {
    operation: 'name', label: '取名', category: '创意生成', temperature: 0.82,
    description: '生成多个命名方案', instruction: '根据对象、受众、语境和限制给出多个命名，并简述差异和风险',
  },
  {
    operation: 'outline', label: '大纲', category: '创意生成', temperature: 0.55,
    description: '生成适合当前任务的层级结构', instruction: '根据当前任务生成清晰的层级结构，不默认它属于某种内容类型',
  },
  {
    operation: 'detailed-outline', label: '细纲', category: '创意生成', temperature: 0.55,
    description: '生成可直接执行的详细结构', instruction: '根据当前任务生成包含目标、内容、顺序和检查点的详细结构',
  },
  {
    operation: 'script', label: '脚本', category: '创意生成', temperature: 0.7,
    description: '生成指定用途和媒介的脚本', instruction: '先遵循用户指定的用途、媒介、受众和格式，再生成相应脚本',
  },
  {
    operation: 'copywriting', label: '文案', category: '创意生成', temperature: 0.75,
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
