import { TextAssistAssociationNotice } from './TextAssistAssociationNotice.tsx';
import { createTextAssistPlugin } from './plugin.ts';

export const textAssistPlugin = createTextAssistPlugin(TextAssistAssociationNotice);
