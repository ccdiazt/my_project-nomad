import env from '#start/env'
import { EMBEDDING_MODEL_NAME } from './ollama.js'
import {
  buildRagEmbeddingProfile,
  isRagEmbeddingPreset,
  type RagEmbeddingProfile,
} from './rag_embedding_presets.js'

/**
 * Env-bound resolution of the RAG embedding profile.
 *
 * Lets a deployment run a different embedding backend — a vLLM instance behind an
 * OpenAI-compatible router, say — without patching RagService. The `nomic` default
 * reproduces the previously hard-coded values exactly, so behaviour is unchanged unless
 * RAG_EMBEDDING_PRESET is set. See constants/rag_embedding_presets.ts for the presets and
 * why the values move as a set.
 *
 * NOTE: server-only. It reads `#start/env`, so it must not be imported from `inertia/`
 * (constants/ollama.ts is shared with the client build and deliberately stays env-free).
 */

export type { RagEmbeddingProfile, RagEmbeddingPreset } from './rag_embedding_presets.js'

function buildProfile(): RagEmbeddingProfile {
  const configured = env.get('RAG_EMBEDDING_PRESET')
  const preset = isRagEmbeddingPreset(configured) ? configured : 'nomic'
  const modelName = env.get('RAG_EMBEDDING_MODEL') || EMBEDDING_MODEL_NAME

  return buildRagEmbeddingProfile(preset, modelName, env.get('RAG_EMBEDDING_DIMENSION'))
}

/**
 * Resolved once at module load: env is fixed for the process lifetime, and the RagService
 * statics that read this are initialised at class-definition time.
 */
export const RAG_EMBEDDING_PROFILE: RagEmbeddingProfile = buildProfile()
