import {
  LEGACY_PROJECT_MEDIA_TYPE,
  PROJECT_FILE_EXTENSION,
  PROJECT_MEDIA_TYPE,
  safeLocalFilename,
  type FileDirectoryTarget,
  type FileReadWriteTarget,
  type FileSaveTarget,
} from '../protocols/files.ts';
import { PRODUCT_NAME, PRODUCT_SLUG } from '../product.ts';

export interface NativeTextExportChoice {
  destination?: FileSaveTarget;
  format: 'txt' | 'docx';
}

export async function chooseNativeProjectSave(
  suggestedName = `${PRODUCT_NAME}${PROJECT_FILE_EXTENSION}`,
): Promise<FileSaveTarget | undefined> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showSaveFilePicker;
  if (!picker) return undefined;
  return picker({
    suggestedName,
    excludeAcceptAllOption: true,
    types: [{
      description: `${PRODUCT_NAME} 书籍`,
      accept: { [PROJECT_MEDIA_TYPE]: [PROJECT_FILE_EXTENSION] },
    }],
  });
}

/**
 * Opening through File System Access retains a read/write handle. This is what
 * lets automatic saving overwrite the same book without asking the user to
 * select a save location again.
 */
export async function chooseNativeProjectOpen(): Promise<FileReadWriteTarget | undefined> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showOpenFilePicker;
  if (!picker) return undefined;
  const handles = await picker({
    id: `${PRODUCT_SLUG}-project`,
    multiple: false,
    types: [{
      description: `${PRODUCT_NAME} 书籍`,
      accept: {
        [PROJECT_MEDIA_TYPE]: [PROJECT_FILE_EXTENSION, '.eco8'],
        [LEGACY_PROJECT_MEDIA_TYPE]: [PROJECT_FILE_EXTENSION, '.eco8'],
      },
    }],
  });
  return handles[0];
}

interface NativeSaveWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    excludeAcceptAllOption?: boolean;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSaveTarget>;
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: FileSaveTarget | FileDirectoryTarget | 'desktop' | 'documents' | 'downloads';
  }) => Promise<FileDirectoryTarget>;
  showOpenFilePicker?: (options: {
    id?: string;
    multiple?: boolean;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileReadWriteTarget[]>;
}

export async function chooseNativePersonalAIBackup(): Promise<FileReadWriteTarget | undefined> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showSaveFilePicker;
  if (!picker) return undefined;
  return picker({
    suggestedName: `${PRODUCT_NAME}-AI-个人配置.txt`,
    excludeAcceptAllOption: true,
    types: [{ description: `${PRODUCT_NAME} AI 个人配置`, accept: { 'text/plain': ['.txt'] } }],
  }) as Promise<FileReadWriteTarget>;
}

export async function chooseNativePersonalAIBackupOpen(): Promise<FileReadWriteTarget | undefined> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showOpenFilePicker;
  if (!picker) return undefined;
  const handles = await picker({
    id: `${PRODUCT_SLUG}-ai-personal-config`,
    multiple: false,
    types: [{ description: `${PRODUCT_NAME} AI 个人配置`, accept: { 'text/plain': ['.txt'] } }],
  });
  return handles[0];
}

export async function chooseNativePromptTemplateSave(name: string): Promise<FileReadWriteTarget | undefined> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showSaveFilePicker;
  if (!picker) return undefined;
  return picker({
    suggestedName: `${safeLocalFilename(name || 'Prompt-模板')}.txt`,
    excludeAcceptAllOption: true,
    types: [{
      description: `${PRODUCT_NAME} Prompt 模板`,
      accept: { 'text/plain': ['.txt'] },
    }],
  }) as Promise<FileReadWriteTarget>;
}

export async function chooseNativePromptTemplateOpen(): Promise<FileReadWriteTarget | undefined> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showOpenFilePicker;
  if (!picker) return undefined;
  const handles = await picker({
    id: `${PRODUCT_SLUG}-prompt-template`,
    multiple: false,
    types: [{
      description: `${PRODUCT_NAME} Prompt 模板`,
      accept: { 'text/plain': ['.txt'] },
    }],
  });
  return handles[0];
}

export async function chooseNativeTextExportDirectory(): Promise<FileDirectoryTarget | undefined> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showDirectoryPicker;
  if (!picker) return undefined;
  return picker({ id: `${PRODUCT_SLUG}-text-export`, mode: 'readwrite', startIn: 'documents' });
}

/**
 * Browsers do not expose a file handle's parent directory. They do allow that
 * handle to seed a user-initiated directory picker, which keeps the permission
 * grant explicit while opening at the current book's location.
 */
export async function chooseNativeDirectoryNearProject(
  projectDestination?: FileSaveTarget,
): Promise<FileDirectoryTarget | undefined> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showDirectoryPicker;
  if (!picker) return undefined;
  return picker({
    ...(!projectDestination ? { id: `${PRODUCT_SLUG}-project-related-directory` } : {}),
    mode: 'readwrite',
    startIn: projectDestination ?? 'documents',
  });
}

export async function chooseNativeAIMemoryDirectory(): Promise<FileDirectoryTarget | undefined> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showDirectoryPicker;
  if (!picker) return undefined;
  return picker({ id: `${PRODUCT_SLUG}-ai-memory`, mode: 'readwrite', startIn: 'documents' });
}

export async function chooseNativeAIMemoryFiles(): Promise<FileReadWriteTarget[]> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showOpenFilePicker;
  if (!picker) return [];
  return picker({
    id: `${PRODUCT_SLUG}-ai-memory-import`,
    multiple: true,
    types: [{ description: `${PRODUCT_NAME} AI 记忆 TXT`, accept: { 'text/plain': ['.txt'] } }],
  });
}

export async function chooseNativeTextExport(title: string): Promise<NativeTextExportChoice> {
  const picker = (globalThis.window as NativeSaveWindow | undefined)?.showSaveFilePicker;
  if (!picker) return { format: 'txt' };
  const destination = await picker({
    suggestedName: `${safeLocalFilename(title)}.txt`,
    excludeAcceptAllOption: true,
    types: [
      { description: '纯文本 TXT', accept: { 'text/plain': ['.txt'] } },
      {
        description: 'Word DOCX',
        accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] },
      },
    ],
  });
  return {
    destination,
    format: destination.name.toLocaleLowerCase().endsWith('.docx') ? 'docx' : 'txt',
  };
}
