import type { ViewClient } from '../../core/contracts.ts';
import {
  PROJECT_RELATED_DIRECTORY_CAPABILITY,
  type FileDirectoryTarget,
} from '../../protocols/files.ts';
import { chooseNativeAIMemoryDirectory } from '../../services/native-save.ts';

/**
 * Prefer the file plugin's current-book-aware picker. The fallback keeps the
 * AI plugin usable in a reduced host where the optional file plugin is absent.
 */
export async function chooseAIMemoryDirectory(
  client: ViewClient,
): Promise<FileDirectoryTarget | undefined> {
  try {
    return await client.request<FileDirectoryTarget | undefined>(PROJECT_RELATED_DIRECTORY_CAPABILITY);
  } catch (error) {
    if (!isUnavailableCapability(error)) throw error;
    return chooseNativeAIMemoryDirectory();
  }
}

function isUnavailableCapability(error: unknown): boolean {
  return error instanceof Error && error.message ===
    `Capability unavailable: ${PROJECT_RELATED_DIRECTORY_CAPABILITY}`;
}
