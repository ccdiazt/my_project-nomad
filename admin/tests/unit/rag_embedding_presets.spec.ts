import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  RAG_EMBEDDING_PRESETS,
  RAG_EMBEDDING_PRESET_DEFINITIONS,
  buildRagEmbeddingProfile,
  deriveModelMatch,
  isRagEmbeddingPreset,
} from '../../constants/rag_embedding_presets.js'

/**
 * The `nomic` preset must keep reproducing the values RagService had hard-coded before the
 * profile indirection existed. If one of these drifts, every vector already in Qdrant was
 * embedded under different assumptions and retrieval degrades without any error surfacing.
 */
test('nomic preset reproduces the original hard-coded RagService values', () => {
  const nomic = RAG_EMBEDDING_PRESET_DEFINITIONS.nomic

  assert.equal(nomic.dimension, 768)
  assert.equal(nomic.documentPrefix, 'search_document: ')
  assert.equal(nomic.queryPrefix, 'search_query: ')
  assert.equal(nomic.maxSafeTokens, 1600)
  assert.equal(nomic.targetTokensPerChunk, 1500)
})

test('an unset preset falls back to nomic', () => {
  assert.equal(isRagEmbeddingPreset(undefined), false)
  assert.equal(isRagEmbeddingPreset(''), false)
  assert.equal(isRagEmbeddingPreset('nomic-embed-text'), false)
  assert.equal(isRagEmbeddingPreset('nomic'), true)
  assert.equal(isRagEmbeddingPreset('bge-m3'), true)
})

/**
 * Chunk budgets are counted with RagService.estimateTokenCount(), a chars/2 estimate, so
 * they are not directly comparable to a real tokenizer's count. What must hold is that a
 * chunk plus its prefix stays under maxSafeTokens — RagService truncates past that point.
 */
test('every preset leaves prefix headroom within its own token ceiling', () => {
  for (const preset of RAG_EMBEDDING_PRESETS) {
    const definition = RAG_EMBEDDING_PRESET_DEFINITIONS[preset]
    assert.ok(
      definition.targetTokensPerChunk < definition.maxSafeTokens,
      `${preset}: chunk target must leave room for the prefix and tokenization variance`
    )
    assert.ok(definition.dimension > 0, `${preset}: dimension must be positive`)
  }
})

/**
 * e5's XLM-R backbone caps at 512 real tokens. The chars/2 estimate over-counts relative to
 * a real tokenizer, so a 480-token estimated ceiling is comfortably inside 512 — but a
 * nomic-sized 1600 would not be, and would truncate most of every passage silently.
 */
test('e5 budgets stay inside its 512-token context', () => {
  assert.ok(RAG_EMBEDDING_PRESET_DEFINITIONS.e5.maxSafeTokens <= 512)
})

test('bge-m3 uses no task prefixes', () => {
  assert.equal(RAG_EMBEDDING_PRESET_DEFINITIONS['bge-m3'].documentPrefix, '')
  assert.equal(RAG_EMBEDDING_PRESET_DEFINITIONS['bge-m3'].queryPrefix, '')
})

test('deriveModelMatch strips tags and registry namespaces', () => {
  assert.equal(deriveModelMatch('nomic-embed-text:v1.5'), 'nomic-embed-text')
  assert.equal(deriveModelMatch('intfloat/multilingual-e5-base'), 'multilingual-e5-base')
  assert.equal(deriveModelMatch('BAAI/bge-m3'), 'bge-m3')
  assert.equal(deriveModelMatch('nomic-embed-text'), 'nomic-embed-text')
})

test('profile carries the preset values through and derives the match', () => {
  const profile = buildRagEmbeddingProfile('e5', 'nomic-embed-text:v1.5')

  // The router aliases an E5 model under the Nomic name so RagService's lookup resolves;
  // the preset is what supplies the E5-correct prefixes and budgets.
  assert.equal(profile.modelName, 'nomic-embed-text:v1.5')
  assert.equal(profile.modelMatch, 'nomic-embed-text')
  assert.equal(profile.queryPrefix, 'query: ')
  assert.equal(profile.dimension, 768)
  assert.equal(profile.targetTokensPerChunk, 400)
})

test('dimension override applies only when truthy', () => {
  assert.equal(buildRagEmbeddingProfile('nomic', 'm', 1024).dimension, 1024)
  assert.equal(buildRagEmbeddingProfile('nomic', 'm', undefined).dimension, 768)
  // Env vars left empty in a compose file arrive as undefined, but guard 0 explicitly:
  // a zero-size Qdrant collection would be rejected at creation time.
  assert.equal(buildRagEmbeddingProfile('nomic', 'm', 0).dimension, 768)
})
