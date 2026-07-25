/**
 * Embedding-backend presets for the RAG pipeline — pure data and pure functions.
 *
 * Kept free of `#start/env` so it can be unit-tested without booting the app, and so the
 * env-reading wrapper (constants/rag_embedding.ts) stays trivial.
 *
 * The pipeline was built around nomic-embed-text:v1.5, and four of its parameters are
 * coupled to that specific model: the vector dimension, the two task-specific prefixes,
 * and the chunk sizing that must stay under the model's context window. Swapping in
 * another embedding model means changing all four together — changing only one (the
 * dimension, say) degrades retrieval silently rather than failing loudly. Grouping them
 * into presets makes that coupling explicit and hard to get half-right.
 */

export const RAG_EMBEDDING_PRESETS = ['nomic', 'e5', 'bge-m3'] as const
export type RagEmbeddingPreset = (typeof RAG_EMBEDDING_PRESETS)[number]

export type RagEmbeddingProfile = {
  /** Preset key in use, for logging. */
  preset: RagEmbeddingPreset
  /** Model name requested from the inference backend, and matched against its model list. */
  modelName: string
  /** Substring used to find a compatible model when the exact name isn't listed. */
  modelMatch: string
  /** Vector size of the Qdrant collection. Must match what the model emits. */
  dimension: number
  /** Prefix prepended to passages at index time. */
  documentPrefix: string
  /** Prefix prepended to the query at search time. */
  queryPrefix: string
  /** Hard ceiling per embed input, in estimated tokens. */
  maxSafeTokens: number
  /** Chunk size the splitter aims for, in estimated tokens. */
  targetTokensPerChunk: number
}

export type RagEmbeddingPresetDefinition = Omit<
  RagEmbeddingProfile,
  'preset' | 'modelName' | 'modelMatch'
>

/**
 * Token budgets are measured with RagService.estimateTokenCount(), a conservative chars/2
 * estimate rather than a real tokenizer — hence the margin between each model's true
 * context window and the numbers below.
 */
export const RAG_EMBEDDING_PRESET_DEFINITIONS: Record<
  RagEmbeddingPreset,
  RagEmbeddingPresetDefinition
> = {
  /**
   * nomic-embed-text:v1.5 — 768 dims, 8192-token context (RoPE-extrapolated; some Ollama
   * modelfiles still default to 2048, which is why these budgets stay conservative).
   * These are the values the pipeline shipped with. Changing them silently invalidates
   * every vector already in Qdrant, so treat them as frozen.
   */
  'nomic': {
    dimension: 768,
    documentPrefix: 'search_document: ',
    queryPrefix: 'search_query: ',
    maxSafeTokens: 1600,
    targetTokensPerChunk: 1500,
  },

  /**
   * intfloat/multilingual-e5-{small,base} — 768 dims, but an XLM-R backbone capped at
   * **512 tokens**. The budgets shrink to match: nomic-sized 1500-token chunks would be
   * truncated to roughly a third at embed time, losing most of every passage without any
   * error. Expect ~3x more chunks (and vectors) for the same corpus.
   */
  'e5': {
    dimension: 768,
    documentPrefix: 'passage: ',
    queryPrefix: 'query: ',
    maxSafeTokens: 480,
    targetTokensPerChunk: 400,
  },

  /**
   * BAAI/bge-m3 — 1024 dims, 8192-token context, strong multilingual retrieval, and no
   * task prefixes (it is trained without them, so any prefix is pure noise).
   * Requires the Qdrant collection rebuilt at 1024.
   */
  'bge-m3': {
    dimension: 1024,
    documentPrefix: '',
    queryPrefix: '',
    maxSafeTokens: 1600,
    targetTokensPerChunk: 1500,
  },
}

export function isRagEmbeddingPreset(value: unknown): value is RagEmbeddingPreset {
  return typeof value === 'string' && (RAG_EMBEDDING_PRESETS as readonly string[]).includes(value)
}

/**
 * Derives the substring used to locate a compatible model in the backend's model list when
 * the exact name isn't present: strips the tag and any registry namespace, e.g.
 * `nomic-embed-text:v1.5` -> `nomic-embed-text`,
 * `intfloat/multilingual-e5-base` -> `multilingual-e5-base`.
 */
export function deriveModelMatch(modelName: string): string {
  const withoutTag = modelName.split(':')[0]
  const segments = withoutTag.split('/')
  return (segments[segments.length - 1] || withoutTag).toLowerCase()
}

/**
 * Builds the effective profile. `dimensionOverride` is an escape hatch for checkpoints
 * whose vector size differs from their family default (e.g. a Matryoshka model truncated
 * to a non-default size); it is ignored when falsy.
 */
export function buildRagEmbeddingProfile(
  preset: RagEmbeddingPreset,
  modelName: string,
  dimensionOverride?: number
): RagEmbeddingProfile {
  const definition = RAG_EMBEDDING_PRESET_DEFINITIONS[preset]

  return {
    preset,
    modelName,
    modelMatch: deriveModelMatch(modelName),
    dimension: dimensionOverride || definition.dimension,
    documentPrefix: definition.documentPrefix,
    queryPrefix: definition.queryPrefix,
    maxSafeTokens: definition.maxSafeTokens,
    targetTokensPerChunk: definition.targetTokensPerChunk,
  }
}
