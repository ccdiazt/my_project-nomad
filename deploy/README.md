# Deployment artifacts — DGX Spark (aarch64) + vLLM

Companion files to [`docs/deploy-dgx-spark.md`](../docs/deploy-dgx-spark.md), which has the
analysis and the reasoning. This is the runbook.

| File | Purpose |
|---|---|
| `docker-compose.dgx-spark.yml` | Command Center stack, ARM64, no auto-update |
| `.env.dgx-spark.example` | Secrets and tuning — copy to `deploy/.env` |
| `litellm_config.yaml` | Router unifying chat + embeddings behind one endpoint |

Target topology:

```
nomad_admin ──► http://host.docker.internal:4000   (LiteLLM)
                     ├── nomad-chat            ──► vLLM :8000
                     └── nomic-embed-text:v1.5 ──► vLLM :8001
```

---

## 1. Build the images

The published GHCR images are amd64-only, so all three are built locally. From the repo root:

```bash
docker build --platform linux/arm64 \
  --build-arg VERSION=1.33.0-arm64 \
  -t project-nomad:local-arm64 .

docker build --platform linux/arm64 \
  -t project-nomad-disk-collector:local-arm64 install/sidecar-disk-collector
```

The main image is the slow one — it compiles `sharp` against libvips and builds the
`@openzim/libzim` native binding. Both support arm64; libzim pulls a prebuilt
`linux-aarch64-manylinux` tarball from `download.openzim.org`, so **the build host needs
outbound access to that domain**. It is the most likely failure point of the build.

Verify before moving on:

```bash
docker image inspect project-nomad:local-arm64 --format '{{.Architecture}}'   # arm64
```

> The `updater` sidecar is deliberately not built or deployed — see the compose header.

---

## 2. Start the inference backends

**Chat.** `--max-model-len` is the real context ceiling: the Command Center requests
`num_ctx` up to 65536 when RAG context inflates the system prompt, but that is an Ollama
parameter and vLLM ignores it. Set it too low and long RAG queries fail outright.

```bash
vllm serve <your-4bit-model> \
  --port 8000 \
  --served-model-name nomad-chat \
  --max-model-len 32768 \
  --kv-cache-dtype fp8 \
  --gpu-memory-utilization 0.75
```

**Do not pass `--reasoning-parser`.** The stream normalizer reads `delta.thinking` and
inline `<think>` tags, never `delta.reasoning_content` — enabling the parser silently
discards the model's reasoning instead of showing it.

**Embeddings.** `--served-model-name` is load-bearing: `RagService` looks the model up by
name. The alias below satisfies that lookup whatever you actually serve.

```bash
vllm serve intfloat/multilingual-e5-base \
  --port 8001 \
  --task embed \
  --served-model-name nomic-embed-text:v1.5
```

Set `RAG_EMBEDDING_PRESET` to the family you actually run (`e5` here), so the task prefixes
and chunk sizing follow. Serving an E5 model under the Nomic alias without setting the
preset gives you Nomic's `search_document: ` prefixes and 1500-token chunks against a
512-token context — it will not error, it will just retrieve badly.

**Router:**

```bash
litellm --config deploy/litellm_config.yaml --port 4000
```

Confirm the extra fields the client sends are tolerated:

```bash
curl -s http://localhost:4000/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed-text:v1.5","input":["prueba"],
       "encoding_format":"float","truncate":true,"options":{"num_ctx":8192}}' \
  | head -c 200
```

A validation error here means `drop_params: true` is not taking effect.

---

## 3. Start the Command Center

```bash
cp deploy/.env.dgx-spark.example deploy/.env
$EDITOR deploy/.env          # APP_KEY, NOMAD_URL, DB_PASSWORD, MYSQL_ROOT_PASSWORD

sudo mkdir -p /opt/project-nomad/{storage,mysql,redis}

docker compose --env-file deploy/.env \
  -f deploy/docker-compose.dgx-spark.yml up -d
```

The GB10's GPU is on the SoC and does not appear on the PCI bus, so the installer's
`lspci` fallback finds nothing. Write the marker the admin container reads:

```bash
echo 'nvidia' | sudo tee /opt/project-nomad/storage/.nomad-gpu-type
```

Check it came up:

```bash
curl -f http://localhost:8080/api/health
docker compose -f deploy/docker-compose.dgx-spark.yml logs -f admin
```

---

## 4. Connect the assistant

**Settings → Models → Remote Ollama URL** → `http://host.docker.internal:4000`

No `/v1` suffix — the client appends it, and `.../v1` would produce `/v1/v1/models`.

Saving it installs Qdrant automatically. Then:

1. The chat model picker should list `nomad-chat`.
2. Send a test message and confirm it streams.
3. Upload a document and confirm ingestion:

```bash
docker logs nomad_admin 2>&1 | grep '\[RAG\]'
curl http://localhost:6333/collections/nomad_knowledge_base
```

The collection's `size` must match your preset — 768 for `nomic`/`e5`, 1024 for `bge-m3`.

If the container cannot reach the router:

```bash
docker exec nomad_admin curl -sv http://host.docker.internal:4000/v1/models
```

---

## 5. Changing the embedding model later

Vectors are not comparable across embedding models, so a switch means re-embedding
everything. Change `RAG_EMBEDDING_PRESET` in `deploy/.env`, then:

```bash
docker compose -f deploy/docker-compose.dgx-spark.yml stop admin
curl -X DELETE http://localhost:6333/collections/nomad_knowledge_base
docker compose --env-file deploy/.env -f deploy/docker-compose.dgx-spark.yml up -d admin
```

The collection is recreated at the new dimension on the next ingest. Re-upload documents
and re-run any ZIM ingestion.

---

## 6. Updating

Auto-update is off by design: the updater sidecar is not deployed, and `pull_policy` is
removed so `up -d` cannot replace the ARM build with the amd64 manifest. Also leave
**Settings → Advanced → auto-update** disabled, so the admin does not try to update itself.

To update:

```bash
git pull
docker build --platform linux/arm64 --build-arg VERSION=<new-version>-arm64 \
  -t project-nomad:local-arm64 .
docker compose --env-file deploy/.env -f deploy/docker-compose.dgx-spark.yml up -d admin
```

Re-check `admin/app/services/rag_service.ts` after pulling: the embedding profile patch
lives there, and upstream changes to those constants may conflict.
