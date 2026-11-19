import type { PalettePresetId } from '../protocols/appearance.ts';
import { workspaceRequestText } from './workspace-request-intent.ts';

const names = '明调|暗调|护眼|明亮|浅色|亮色|深色|暗色|夜间|日间|白天|暗黑';
const subject = '(?:(?:全局|应用|界面)?(?:主题(?:颜色|色)?|配色(?:方案)?|颜色方案|模式)|界面|外观)';
const target = `[「『“"]?(${names})[」』”"]?(?:的)?(?:${subject})?`;
const verb = '(?:切(?:换)?(?:到|为|成)?|更换为|换(?:成|为|一?个)|改(?:成|为)|设(?:置)?(?:成|为)|调成|应用|使用|启用|开启|打开|恢复(?:为|到)?|还原(?:为|到)?|用|来(?:一)?个)';
const command = new RegExp(`^(?:(?:把|将)?${subject})?${verb}${target}$`, 'u');
const verbFirst = new RegExp(`^(?:切换|更换|修改|调整|设置|恢复|还原|改|换|设)${subject}(?:到|为|成)?${target}$`, 'u');
const objectFirst = new RegExp(`^(?:把|将)?${target}(?:打开|启用|应用|用上)$`, 'u');

/** Only a complete theme-change request is executable; titles and discussions stay data. */
export function palettePresetIntent(input: string): PalettePresetId | undefined {
  const requested = new RegExp('^(?:我想(?:要)?|我要|我希望|我需要)\\s*(?=' + names + ')', 'u').test(input.trim());
  const text = (requested ? '用' : '') + workspaceRequestText(input).normalize('NFKC').trim()
    .replace(/^(?:(?:请你?|麻烦你?|帮我|给我)\s*[，,]?\s*)+/u, '')
    .replace(/^(?:我想(?:要)?|我要)\s*(?=明调|暗调|护眼)/u, '用')
    .replace(/^(?:我想(?:要)?|我要)\s*/u, '')
    .replace(/(?:吧|就好|就行|一下)?[。！!]*$/u, '').replace(/\s+/gu, '');
  if (/不要|别|先不|暂不|如果|假如|假设|怎么|如何|怎样|是否|为什么|区别|[？?]|[，,；;。]/u.test(text)) return undefined;
  const match = command.exec(text) ?? verbFirst.exec(text) ?? objectFirst.exec(text);
  if (!match) return undefined;
  const name = match[1]!;
  return name === '护眼' ? 'eye-care' : /暗|深|夜/u.test(name) ? 'dark' : 'bright';
}
