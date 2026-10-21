import {
  validateChunkExternalizedApplication,
  type ChunkExternalizedApplication,
} from './checkpoint-preparation.ts';

export const PERSISTENCE_PREPARE_CHECKPOINT_JOB = 'core.persistence.prepareCheckpoint';

export function prepareCheckpointWorkerRequest(value: unknown): ChunkExternalizedApplication {
  validateChunkExternalizedApplication(value);
  return value;
}
