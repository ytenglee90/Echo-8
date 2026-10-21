import type {
  PluginDataMigration,
  PluginDefinition,
  PluginDocumentData,
} from './contracts.ts';
import type { ProjectOpenPayload, ProjectPluginDescriptor } from '../protocols/files.ts';

export interface ProjectMigrationResult {
  payload: ProjectOpenPayload;
  migratedPlugins: string[];
}

/**
 * Migrates only staged copies of plugin-owned document namespaces. The caller's
 * payload and the currently open document remain untouched if any step fails.
 */
export async function migrateProjectPluginData(
  payload: ProjectOpenPayload,
  definitions: ReadonlyMap<string, PluginDefinition>,
): Promise<ProjectMigrationResult> {
  const descriptors = payload.manifest.plugins.map((descriptor) => structuredClone(descriptor));
  const descriptorIds = new Set<string>();
  const namespaceOwners = currentDocumentNamespaceOwners(definitions);
  let namespaces = { ...payload.document.namespaces };
  const migratedPlugins: string[] = [];

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptorIds.has(descriptor.id)) throw new Error(`书籍包含重复插件描述：${descriptor.id}`);
    descriptorIds.add(descriptor.id);
    const definition = definitions.get(descriptor.id);
    if (!definition) continue;
    const targetVersion = definition.manifest.dataVersion;
    const sourceVersion = descriptor.dataVersion ?? 1;
    if (sourceVersion > targetVersion) {
      throw new Error(
        `书籍中的 ${descriptor.id} 数据版本 ${sourceVersion} 高于当前支持的 ${targetVersion}`,
      );
    }
    const currentNamespaces = definition.manifest.namespaces.filter(
      (namespace) => (definition.manifest.namespaceDomains[namespace] ?? 'document') === 'document',
    );
    const allowedNamespaces = new Set([...descriptor.namespaces, ...currentNamespaces]);
    for (const namespace of descriptor.namespaces) {
      const owner = namespaceOwners.get(namespace);
      if (owner && owner !== descriptor.id) {
        throw new Error(`插件 ${descriptor.id} 的旧数据与 ${owner} 的命名空间 ${namespace} 冲突`);
      }
    }

    if (sourceVersion < targetVersion) {
      const migrations = await migrationsFor(definition);
      validateMigrationChain(definition.manifest.id, targetVersion, migrations);
      let staged: PluginDocumentData = {};
      for (const namespace of allowedNamespaces) {
        staged[namespace] = structuredClone(namespaces[namespace] ?? {});
      }
      let version = sourceVersion;
      while (version < targetVersion) {
        const migration = migrations.find((candidate) => candidate.from === version);
        if (!migration || migration.to !== version + 1) {
          throw new Error(`插件 ${descriptor.id} 缺少数据迁移 ${version} → ${version + 1}`);
        }
        try {
          staged = await migration.migrate(staged);
        } catch (error) {
          throw new Error(`插件 ${descriptor.id} 数据迁移 ${migration.from} → ${migration.to} 失败`, {
            cause: error,
          });
        }
        validateMigratedData(descriptor.id, staged, allowedNamespaces);
        version = migration.to;
      }
      const nextNamespaces = { ...namespaces };
      for (const namespace of allowedNamespaces) delete nextNamespaces[namespace];
      for (const [namespace, records] of Object.entries(staged)) {
        nextNamespaces[namespace] = records;
      }
      namespaces = nextNamespaces;
      migratedPlugins.push(descriptor.id);
    }

    descriptors[index] = currentDescriptor(definition, currentNamespaces);
  }

  if (migratedPlugins.length === 0) {
    return {
      payload: {
        ...payload,
        manifest: { ...payload.manifest, plugins: descriptors },
      },
      migratedPlugins,
    };
  }
  const revision = payload.document.revision + 1;
  return {
    payload: {
      ...payload,
      manifest: {
        ...payload.manifest,
        documentRevision: revision,
        plugins: descriptors,
      },
      document: { revision, namespaces },
      // Version-one history patches describe the pre-migration schema and must
      // not be allowed to resurrect it after the book has been upgraded.
      history: { undo: [], redo: [] },
    },
    migratedPlugins,
  };
}

export function validateStaticPluginMigrations(definition: PluginDefinition): void {
  if (definition.loadMigrations) return;
  validateMigrationChain(
    definition.manifest.id,
    definition.manifest.dataVersion,
    definition.migrations ?? [],
  );
}

async function migrationsFor(definition: PluginDefinition): Promise<PluginDataMigration[]> {
  return definition.migrations ?? await definition.loadMigrations?.() ?? [];
}

function validateMigrationChain(
  pluginId: string,
  targetVersion: number,
  migrations: PluginDataMigration[],
): void {
  const bySource = new Map<number, PluginDataMigration>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.from) || !Number.isInteger(migration.to) ||
      migration.from < 1 || migration.to !== migration.from + 1 || migration.to > targetVersion) {
      throw new Error(`插件 ${pluginId} 包含无效数据迁移 ${migration.from} → ${migration.to}`);
    }
    if (bySource.has(migration.from)) throw new Error(`插件 ${pluginId} 重复声明数据迁移 ${migration.from}`);
    bySource.set(migration.from, migration);
  }
  for (let version = 1; version < targetVersion; version += 1) {
    if (!bySource.has(version)) throw new Error(`插件 ${pluginId} 缺少数据迁移 ${version} → ${version + 1}`);
  }
}

function validateMigratedData(
  pluginId: string,
  data: PluginDocumentData,
  allowedNamespaces: ReadonlySet<string>,
): void {
  if (!isRecord(data)) throw new Error(`插件 ${pluginId} 的迁移结果不是命名空间对象`);
  for (const [namespace, records] of Object.entries(data)) {
    if (!allowedNamespaces.has(namespace)) {
      throw new Error(`插件 ${pluginId} 的迁移越权写入命名空间 ${namespace}`);
    }
    if (!isRecord(records)) throw new Error(`插件 ${pluginId} 的命名空间 ${namespace} 不是记录对象`);
  }
}

function currentDocumentNamespaceOwners(
  definitions: ReadonlyMap<string, PluginDefinition>,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [id, definition] of definitions) {
    for (const namespace of definition.manifest.namespaces) {
      if ((definition.manifest.namespaceDomains[namespace] ?? 'document') !== 'document') continue;
      owners.set(namespace, id);
    }
  }
  return owners;
}

function currentDescriptor(
  definition: PluginDefinition,
  namespaces: string[],
): ProjectPluginDescriptor {
  return {
    id: definition.manifest.id,
    version: definition.manifest.version,
    dataVersion: definition.manifest.dataVersion,
    namespaces,
    available: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
