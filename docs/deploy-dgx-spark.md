# Plan de ejecución — Project N.O.M.A.D. en NVIDIA DGX Spark con LLMs locales

> Objetivo: desplegar el Command Center de N.O.M.A.D. en un DGX Spark (GB10 Grace Blackwell,
> `aarch64`) y conectar el Asistente de IA a un servidor de inferencia **que ya está
> corriendo en la máquina**, en lugar de dejar que N.O.M.A.D. instale su propio Ollama.

---

## 0. Veredicto

**Es viable, pero no por la ruta de instalación oficial.** El `install_nomad.sh` y las
imágenes publicadas en GHCR asumen `x86_64`. El código de la aplicación, en cambio, sí
contempla arquitectura ARM y backends de inferencia externos. El trabajo real se concentra
en dos frentes:

1. **Construir localmente 3 imágenes para `linux/arm64`** (el `Dockerfile` ya está preparado).
2. **Apuntar el asistente a tu endpoint existente** vía el ajuste `ai.remoteOllamaUrl`,
   resolviendo el punto delicado: los *embeddings* del RAG.

Esfuerzo estimado: **medio día** para tener Command Center + chat funcionando; **1–2 días**
si se quiere el catálogo completo de apps validado en ARM y contenido offline descargado.

---

## 1. Arquitectura del proyecto (lo que hay que desplegar)

N.O.M.A.D. no es una aplicación monolítica: es un **orquestador de contenedores** con una UI
web ("Command Center") que habla con el daemon Docker del host a través de
`/var/run/docker.sock`.

**Stack de gestión** (`install/management_compose.yaml`) — siempre presente:

| Servicio | Imagen | Rol |
|---|---|---|
| `nomad_admin` | `ghcr.io/crosstalk-solutions/project-nomad` | AdonisJS 6 + Inertia/React. El cerebro. |
| `nomad_mysql` | `mysql:8.0` | Estado de la aplicación |
| `nomad_redis` | `redis:7-alpine` | Colas BullMQ (descargas, embeddings) |
| `nomad_dozzle` | `amir20/dozzle:v10.0` | Visor de logs (opcional) |
| `nomad_updater` | `...project-nomad-sidecar-updater` | Auto-actualización desde la UI |
| `nomad_disk_collector` | `...project-nomad-disk-collector` | Métricas de disco del host |

**Catálogo de apps instalables bajo demanda** (`admin/database/seeders/service_seeder.ts`):
Kiwix, Kolibri, Qdrant, Ollama, CyberChef, FlatNotes, Calibre-Web, Jellyfin, Vaultwarden,
Stirling-PDF, FileBrowser, Homebox, IT-Tools, Excalidraw, Meshtastic/MeshCore.

**Subsistema de IA** — las dos piezas que nos importan:

- `admin/app/services/ollama_service.ts` — cliente unificado. Usa el SDK de OpenAI contra
  `${baseUrl}/v1`, con ruta nativa de Ollama (`/api/tags`, `/api/embed`, `/api/pull`) y
  *fallback* OpenAI-compatible.
- `admin/app/services/rag_service.ts` — ingesta, *chunking*, embeddings y búsqueda
  semántica sobre Qdrant.

---

## 2. Hallazgos del análisis del código

Cada punto está verificado contra el árbol actual (`56cafe5`).

### 2.1 🔴 Las imágenes oficiales son solo amd64

`.github/workflows/build-primary-image.yml:44` usa `docker/build-push-action@v7` **sin la
clave `platforms:`**, por lo que se publica un manifiesto de arquitectura única
(`linux/amd64`). Lo mismo aplica a `build-sidecar-updater.yml` y `build-disk-collector.yml`.

**Consecuencia:** `docker compose up` en el Spark fallará (o arrancará bajo emulación QEMU,
si estuviera instalada, con un rendimiento inaceptable) en `nomad_admin`, `nomad_updater` y
`nomad_disk_collector`.

### 2.2 🟢 El Dockerfile sí está preparado para arm64

`Dockerfile:38-62` distingue `TARGETARCH` y ya incluye el SHA256 del binario `go-pmtiles`
para `arm64`. Las dependencias nativas conflictivas (`sharp` vía `libvips-dev`,
`graphicsmagick` para `pdf2pic`) se compilan desde `base` con `build-essential` presente.
**Construir para ARM debería funcionar sin parches.**

### 2.3 🟡 El instalador advierte, pero no aborta

`install/install_nomad.sh:89-101` — `check_is_x86_64()` imprime un aviso, duerme 10 s y
continúa (menciona el PR #419 de soporte ARM64 como "no listo"). No es un bloqueo duro,
pero el script descargaría el compose que apunta a las imágenes amd64. **Lo evitaremos.**

### 2.4 🟡 La detección de GPU por `lspci` no funcionará en GB10

`admin/app/services/docker_service.ts:1395-1399` usa `lspci | grep -i nvidia` como
*fallback*. En el Spark la GPU es parte del SoC y **no aparece en el bus PCI** (igual que en
Jetson). La ruta primaria (`docker.info()` → runtime `nvidia`, líneas 1357-1366) sí
funciona si el NVIDIA Container Toolkit está configurado — lo está por defecto en DGX OS.

Esto solo importa si se instalara el contenedor Ollama de N.O.M.A.D.; en nuestro diseño no
se usa. Existe además un marcador de respaldo: `storage/.nomad-gpu-type`
(`install_nomad.sh:560-570`), que podemos escribir a mano.

### 2.5 🟢 El punto de integración con LLMs externos existe y es limpio

`admin/app/services/ollama_service.ts:60-84`:

```ts
const customUrl = (await KVStore.getValue('ai.remoteOllamaUrl')) as string | null
if (customUrl && customUrl.trim()) {
  this.baseUrl = customUrl.trim().replace(/\/$/, '')
} else {
  // ...cae al contenedor Ollama gestionado por Docker
}
this.openai = new OpenAI({ apiKey: 'nomad', baseURL: `${this.baseUrl}/v1` })
```

Se configura desde **Settings → Models** (`admin/inertia/pages/settings/models.tsx:406`) o
durante el **Easy Setup**. Al guardarlo, `ollama_controller.ts:283-298` marca el servicio
como instalado, detiene el contenedor Ollama local si existiera y **dispara la instalación
de Qdrant automáticamente**.

### 2.6 ⚠️ La URL **no** debe incluir `/v1`

El código concatena `/v1` (línea 79) y la prueba de conectividad hace
`fetch(\`${remoteUrl}/v1/models\`)` (`ollama_controller.ts:266`).

- ✅ `http://host.docker.internal:11434`
- ❌ `http://host.docker.internal:11434/v1` → produciría `/v1/v1/models`

Este es el error número uno al configurar backends OpenAI-compatibles.

### 2.7 🟢 El validador SSRF permite LAN y loopback

`admin/app/validators/common.ts:56-80` — `assertNotCloudMetadataUrl()` **permite**
deliberadamente loopback, link-local y RFC1918, y solo bloquea el IP de metadatos de nube
(`169.254.169.254`, `fd00:ec2::254`) y esquemas no-HTTP. No hay que tocar nada.

### 2.8 🟢 La red hacia el host ya está resuelta

`install/management_compose.yaml:16-17` define
`extra_hosts: - "host.docker.internal:host-gateway"`. Si tu servidor de inferencia corre en
el propio Spark (en el host, no en un contenedor), `host.docker.internal` lo alcanza.

**Requisito:** Ollama debe escuchar en todas las interfaces (`OLLAMA_HOST=0.0.0.0`), no solo
en `127.0.0.1`, o el contenedor no llegará.

### 2.9 ⚠️ Un solo endpoint sirve chat **y** embeddings

`ai.remoteOllamaUrl` es un único `baseUrl` usado tanto por `chat()` como por `embed()`. No
hay forma de separarlos en la configuración actual.

Además el RAG es rígido en dos aspectos (`admin/app/services/rag_service.ts:48-49`,
`admin/constants/ollama.ts:67`):

```ts
public static CONTENT_COLLECTION_NAME = 'nomad_knowledge_base'
public static EMBEDDING_DIMENSION = 768   // hardcoded
export const EMBEDDING_MODEL_NAME = 'nomic-embed-text:v1.5'
```

La resolución del modelo (`rag_service.ts:293-312`) busca coincidencia exacta o, en su
defecto, cualquier modelo cuyo nombre contenga `nomic-embed-text`. Si no encuentra ninguno,
intenta descargarlo.

### 2.10 ⚠️ Sin Ollama nativo no hay descarga de modelos

`ollama_service.ts:151-159`: si `/api/tags` falla, `isOllamaNative` pasa a `false`
(línea 729) y `downloadModel()` devuelve error sin intentar el *pull*. Con vLLM, llama.cpp o
LM Studio **debes servir tú mismo el modelo de embeddings** — y con dimensión 768.

---

## 3. Decisión de arquitectura: cómo conectar tus LLMs

Esta es la bifurcación principal del plan. Depende de qué estés ejecutando hoy en el Spark.

### Opción A — Ollama nativo en el Spark *(recomendada)*

Ollama corre en el host con aceleración CUDA en GB10. Cubre chat y embeddings en el mismo
endpoint, y N.O.M.A.D. obtiene todas sus funciones: listado de modelos con tamaños,
descarga de modelos desde la UI, `num_ctx`, *thinking* nativo.

- URL a configurar: `http://host.docker.internal:11434`
- Fricción: mínima. Es el camino que el proyecto asume.

### Opción B — vLLM / llama.cpp / LM Studio (OpenAI-compatible)

Funciona para el chat, pero el RAG queda cojo: hay que exponer **también**
`/v1/embeddings` con un modelo de 768 dimensiones desde el *mismo* puerto. vLLM sirve un
modelo por proceso, así que normalmente no es posible sin un segundo componente.

- Fricción: alta si quieres RAG. Aceptable si solo quieres chat.

### Opción C — Router unificado (LiteLLM u otro proxy) *(la mejor si ya usas vLLM)*

Poner un proxy OpenAI-compatible delante que multiplexe: tu LLM grande de vLLM/TRT-LLM para
chat, y un modelo de embeddings aparte, ambos bajo un solo `baseURL`.

Para que el RAG lo acepte sin tocar código, el *deployment* de embeddings debe:
- llamarse `nomic-embed-text:v1.5` (o contener `nomic-embed-text` en el nombre), y
- devolver vectores de **768** dimensiones.

- Fricción: media. Añade un componente, pero conserva todo el stack de inferencia actual.

> **Recomendación:** si ya tienes Ollama, Opción A y listo. Si tu inferencia está en vLLM y
> te importa el RAG, Opción C. Si solo quieres el chat, Opción B es suficiente.

---

## 3-bis. Diseño concreto para vLLM + RAG *(configuración elegida)*

Stack objetivo: **vLLM como motor principal, RAG con documentos propios.** Esto fija la
Opción C. Arquitectura resultante:

```
nomad_admin  ──►  http://host.docker.internal:4000     (LiteLLM, router OpenAI-compatible)
                       ├── chat       ──►  vLLM  :8000   (modelo grande, 4-bit)
                       └── embeddings ──►  vLLM  :8001   (modelo de embeddings)
                                             · o bien Ollama :11434, si prefieres
```

### 3-bis.1 Por qué hace falta el router

vLLM sirve **un modelo por proceso**, y N.O.M.A.D. tiene un único `baseUrl` para chat y
embeddings (§2.9). El router los unifica bajo un solo puerto. Cualquier proxy
OpenAI-compatible sirve; LiteLLM es el más directo.

### 3-bis.2 Hallazgos específicos de vLLM

**a) `--max-model-len` es el límite real, no `num_ctx`.**
`admin/app/controllers/ollama_controller.ts:140-144`: cuando el contexto RAG engorda el
system prompt, N.O.M.A.D. pide `num_ctx` escalando por `[8192, 16384, 32768, 65536]`. Ese
parámetro es de Ollama; **vLLM lo ignora**. El techo efectivo es el `--max-model-len` con
el que arrancaste el servidor. Si lo dejas corto, las consultas RAG con mucho contexto
fallarán con *context length exceeded* en lugar de degradarse.

→ Arranca vLLM con `--max-model-len 32768` como mínimo.

**b) NO habilites `--reasoning-parser` en vLLM.**
El normalizador de streaming (`ollama_service.ts:384-429`) extrae el razonamiento de dos
sitios: `delta.thinking` (nativo de Ollama) y etiquetas `<think>…</think>` incrustadas en
`delta.content`, con un parser que aguanta etiquetas partidas entre *chunks*. **No lee
`delta.reasoning_content`**, que es justamente donde vLLM coloca el razonamiento cuando
activas su *reasoning parser*.

→ Con el parser activado, el razonamiento del modelo se pierde en silencio. Déjalo
desactivado y que las etiquetas `<think>` fluyan inline: N.O.M.A.D. las separa solo.

Nota relacionada: `checkModelHasThinking()` (`ollama_service.ts:435-450`) consulta
`/api/show`, que no existe fuera de Ollama, y devuelve `false`. Es decir, el parámetro
`think` **nunca** se envía a vLLM. Sin efectos secundarios.

**c) Parámetros extra en el cuerpo de la petición.**
El código envía campos que no son del estándar OpenAI:

- a `/v1/chat/completions`: `num_ctx` (`ollama_service.ts:332-334, 363-365`)
- a `/v1/embeddings`: `truncate: true` y `options: { num_ctx: 8192 }`
  (`ollama_service.ts:596-602`)

Según la versión de vLLM esto se ignora con un warning o se rechaza. **Verificar antes de
dar por buena la instalación:**

```bash
curl -s http://localhost:8001/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed-text:v1.5","input":["hola"],
       "encoding_format":"float","truncate":true,"options":{"num_ctx":8192}}' | head -c 300
```

Si devuelve error de validación, la solución limpia es `drop_params: true` en LiteLLM, que
descarta los parámetros no soportados por el proveedor destino.

### 3-bis.3 Elección del modelo de embeddings — el punto crítico

El RAG impone **tres** restricciones simultáneas, no solo la dimensión:

| Restricción | Valor | Origen |
|---|---|---|
| Dimensión del vector | **768** | `rag_service.ts:49` (`EMBEDDING_DIMENSION`) |
| Nombre del modelo | debe contener `nomic-embed-text` | `rag_service.ts:293-296` |
| Prefijos de indexación | `search_document: ` / `search_query: ` | `rag_service.ts:62-63` |

La tercera es la que se suele pasar por alto: esos prefijos son la convención de **Nomic**.
Si sirves un modelo de otra familia, los prefijos se convierten en ruido asimétrico —
el sistema funciona, pero la calidad del *recall* baja.

**Opción E1 — `nomic-embed-text-v1.5` (fricción cero).**
768 dims nativas, contexto 8192 (coincide con el `num_ctx` que pide el código), prefijos
correctos por construcción. Ningún parche. Contrapartida: está entrenado con foco en
inglés; con corpus en español el *recall* es notablemente peor.
Si vLLM no soporta su arquitectura (`NomicBertModel`, requiere `trust_remote_code`),
sírvelo desde Ollama — pesa ~275 MB y no compite por memoria.

**Opción E2 — `intfloat/multilingual-e5-base` (recomendada para corpus en español).**
768 dims **nativas** (sin truncar), multilingüe de verdad, y arquitectura `XLMRobertaModel`
que vLLM sirve sin `trust_remote_code`. Requiere dos ajustes:

1. En LiteLLM, exponerlo con el alias `nomic-embed-text:v1.5` para satisfacer la búsqueda
   por nombre. Sin cambios en el código de N.O.M.A.D.
2. Parche local de 2 líneas para alinear los prefijos con la convención de E5:

   ```ts
   // admin/app/services/rag_service.ts:62-63
   public static SEARCH_DOCUMENT_PREFIX = 'passage: '
   public static SEARCH_QUERY_PREFIX = 'query: '
   ```

**Opción E3 — `BAAI/bge-m3` (máxima calidad multilingüe).**
Superior a E2 en recuperación multilingüe y con contexto de 8192, pero **1024 dims**: exige
además cambiar `EMBEDDING_DIMENSION` a `1024` y borrar la colección de Qdrant. bge-m3 no
usa prefijos, así que los dos constantes de arriba pasan a cadena vacía. Tres parches en
total.

> **Recomendación:** E2. Un alias en el router y dos líneas de parche, a cambio de
> retrieval decente en español. E1 si tu corpus es mayoritariamente inglés y quieres cero
> modificaciones. E3 solo si el retrieval es el cuello de botella medido.

⚠️ Cambiar de modelo o de dimensión **después** de haber ingerido documentos obliga a
borrar y regenerar la colección — los vectores no son comparables entre modelos:

```bash
curl -X DELETE http://localhost:6333/collections/nomad_knowledge_base
```

### 3-bis.4 Elección del modelo de chat

En el DGX Spark el factor limitante de la generación **no es el cómputo, es el ancho de
banda de memoria**. Los ~128 GB son LPDDR5X unificada a unos ~273 GB/s: cada token
generado requiere recorrer los pesos del modelo una vez, así que el techo teórico de
velocidad es aproximadamente `ancho_de_banda / tamaño_del_modelo_en_memoria`.

Envelope práctico para chat interactivo (una sola sesión):

| Tamaño y cuantización | Pesos en memoria | Techo teórico | Esperable en la práctica |
|---|---|---|---|
| ~30B en 4-bit | ~16 GB | ~17 tok/s | ~10–13 tok/s |
| ~30B en 8-bit | ~31 GB | ~9 tok/s | ~5–6 tok/s |
| ~70B en 4-bit | ~38 GB | ~7 tok/s | ~4–5 tok/s |

Conclusión operativa: **modelos de ~26–32B en 4 bits son el punto dulce** para un
asistente conversacional en este equipo. Los 128 GB permiten cargar mucho más, pero la
generación se vuelve incómodamente lenta para un chat.

Dos matices favorables al caso de uso RAG:

- El *prefill* (procesar el contexto recuperado) sí es intensivo en cómputo, y ahí el GB10
  rinde bien. La latencia hasta el primer token con contextos largos será razonable.
- GB10 es Blackwell y tiene **FP4 nativo**. Si existe un checkpoint NVFP4 de tu modelo,
  vLLM lo aprovecha con hardware dedicado en lugar de emular la descuantización. Merece la
  prueba frente a un GPTQ/AWQ int4 equivalente.

Presupuesto de memoria a repartir entre: pesos del modelo de chat + caché KV + modelo de
embeddings + el resto del stack N.O.M.A.D. La caché KV a 32k de contexto en un modelo de
30B ronda los 5–7 GB en FP16; `--kv-cache-dtype fp8` la reduce a la mitad y deja holgura
para subir `--max-model-len`.

### 3-bis.5 Configuración de referencia

Servidor de chat:

```bash
vllm serve <tu-modelo-4bit> \
  --port 8000 \
  --served-model-name nomad-chat \
  --max-model-len 32768 \
  --kv-cache-dtype fp8 \
  --gpu-memory-utilization 0.75
  # sin --reasoning-parser  (ver §3-bis.2b)
```

Servidor de embeddings:

```bash
vllm serve intfloat/multilingual-e5-base \
  --port 8001 \
  --task embed \
  --served-model-name nomic-embed-text:v1.5   # alias exigido por rag_service.ts:293-296
```

Router (`litellm_config.yaml`):

```yaml
model_list:
  - model_name: nomad-chat
    litellm_params:
      model: hosted_vllm/nomad-chat
      api_base: http://localhost:8000/v1
  - model_name: nomic-embed-text:v1.5
    litellm_params:
      model: hosted_vllm/nomic-embed-text:v1.5
      api_base: http://localhost:8001/v1

litellm_settings:
  drop_params: true    # descarta num_ctx / truncate  (ver §3-bis.2c)
```

```bash
litellm --config litellm_config.yaml --port 4000
```

URL a introducir en N.O.M.A.D. → **`http://host.docker.internal:4000`** (sin `/v1`).

### 3-bis.6 Qué se pierde con esta arquitectura

Al no ser un backend Ollama nativo, `isOllamaNative` queda en `false`
(`ollama_service.ts:729`) y se desactivan funciones que dependen de la API propietaria:

| Función | Estado | Impacto |
|---|---|---|
| Descarga de modelos desde la UI | ❌ | Gestionas los modelos en vLLM/HF a mano |
| Tamaños de modelo en el listado | ❌ | Aparecen como `0` |
| Borrado de modelos desde la UI | ❌ | `/api/delete` no existe |
| Detección de *thinking* | ❌ → inline | Funciona igual vía etiquetas `<think>` |
| Pacing de embeddings por VRAM (`/api/ps`) | ❌ | Irrelevante: en GPU no hace falta |
| Chat + streaming + razonamiento | ✅ | Sin pérdida |
| RAG completo | ✅ | Con la config de arriba |

Ninguna es bloqueante para el objetivo planteado.

---

## 4. Fases de ejecución

### Fase 0 — Inventario y preparación

```bash
uname -m                                    # esperado: aarch64
cat /etc/os-release                         # DGX OS / Ubuntu → base Debian ✓
docker version && docker compose version
docker info | grep -i runtime               # debe listar 'nvidia'
nvidia-smi
df -h /opt                                  # ≥ 250 GB si habrá contenido offline
curl -s http://localhost:11434/api/tags     # o el puerto de tu backend actual
```

**Criterio de aceptación:** Docker con runtime `nvidia` disponible y el endpoint de
inferencia respondiendo localmente.

> Si Ollama solo escucha en loopback:
> `sudo systemctl edit ollama` → `[Service]` / `Environment="OLLAMA_HOST=0.0.0.0"`,
> luego `sudo systemctl daemon-reload && sudo systemctl restart ollama`.
> Ten en cuenta que esto lo expone a tu LAN; combínalo con reglas de firewall.

---

### Fase 1 — Construir las imágenes para arm64

**No ejecutar `install_nomad.sh`.** Clonamos y construimos.

```bash
sudo mkdir -p /opt/project-nomad && cd /opt/project-nomad
git clone https://github.com/ccdiazt/my_project-nomad.git src && cd src

# 1) Imagen principal (la más pesada: compila sharp desde fuente)
docker build --platform linux/arm64 \
  --build-arg VERSION=1.33.0-arm64 \
  -t project-nomad:local-arm64 .

# 2) Sidecars (Dockerfiles incluidos en el repo)
docker build --platform linux/arm64 \
  -t project-nomad-sidecar-updater:local-arm64 install/sidecar-updater
docker build --platform linux/arm64 \
  -t project-nomad-disk-collector:local-arm64 install/sidecar-disk-collector
```

**Criterio de aceptación:** las 3 imágenes construyen sin error y
`docker image inspect project-nomad:local-arm64 --format '{{.Architecture}}'` → `arm64`.

**Riesgo:** si `sharp` o `pdf2pic` fallan en ARM, la mitigación es fijar `sharp` a una
versión con binarios `linux-arm64` precompilados en `admin/package.json`. No se anticipa
problema: `libvips-dev` y `build-essential` ya están en la etapa `base`.

---

### Fase 2 — Desplegar el Command Center

Partir de `install/management_compose.yaml` con **cuatro cambios obligatorios**:

1. `image:` → las tres etiquetas locales `:local-arm64`.
2. **Eliminar `pull_policy: always`** de `admin`, `updater` y `disk-collector`. Si se deja,
   Docker intentará traer el manifiesto amd64 de GHCR y pisará tu build local.
3. Sustituir los `replaceme`: `APP_KEY` (≥16 caracteres, p. ej. `openssl rand -hex 24`),
   `URL` (`http://<IP-del-Spark>:8080`), `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` y el
   `DB_PASSWORD` correspondiente.
4. Verificar que `mysql:8.0` y `redis:7-alpine` resuelven a arm64 (ver Fase 5).

```bash
cd /opt/project-nomad
docker compose -f docker-compose.yml up -d
docker compose logs -f admin
```

Escribir el marcador de GPU, ya que `lspci` no detectará la GB10 (§2.4):

```bash
echo 'nvidia' | sudo tee /opt/project-nomad/storage/.nomad-gpu-type
```

**Criterio de aceptación:** `http://<IP-del-Spark>:8080` carga el Command Center y
`curl http://localhost:8080/api/health` responde OK.

---

### Fase 3 — Conectar tus LLMs

En la UI: **Settings → Models → Remote Ollama URL** (o durante el asistente Easy Setup).

| Backend en el Spark | URL a introducir |
|---|---|
| Ollama en el host | `http://host.docker.internal:11434` |
| Ollama en contenedor (misma red) | `http://<nombre-contenedor>:11434` |
| vLLM / llama.cpp / LM Studio | `http://host.docker.internal:<puerto>` |
| LiteLLM u otro router | `http://host.docker.internal:4000` |

Recordatorio: **sin `/v1` al final** (§2.6).

Al guardar, el controlador prueba `GET {url}/v1/models`, marca el asistente como instalado,
detiene cualquier Ollama local e **instala Qdrant automáticamente**.

**Criterio de aceptación:** el desplegable de modelos del chat lista los modelos de tu Spark
y una conversación de prueba responde en streaming.

**Diagnóstico si falla:**
```bash
docker exec nomad_admin curl -sv http://host.docker.internal:11434/v1/models
```
Un *connection refused* casi siempre significa que el backend escucha en `127.0.0.1`.

---

### Fase 4 — Habilitar el RAG (base de conocimiento)

1. Confirmar que Qdrant arrancó (se instala solo en la Fase 3).
2. Garantizar el modelo de embeddings en **el mismo endpoint**:
   - **Opción A:** `ollama pull nomic-embed-text:v1.5` — y ya está.
   - **Opciones B/C:** servir un modelo de 768 dimensiones bajo un nombre que contenga
     `nomic-embed-text`.
3. Subir un documento de prueba desde la UI del chat y verificar la ingesta.

```bash
docker logs nomad_admin 2>&1 | grep '\[RAG\]'
curl http://localhost:6333/collections/nomad_knowledge_base
```

**Criterio de aceptación:** la colección existe con `"size": 768` y una pregunta sobre el
documento subido devuelve respuesta con citas.

**Riesgo:** un modelo de embeddings de dimensión distinta (768 está *hardcoded* en
`rag_service.ts:49`) provocará que Qdrant rechace los *upserts*. Si necesitas otra
dimensión, es un cambio de una línea más el borrado de la colección — anotarlo como parche
local a re-aplicar tras cada actualización.

---

### Fase 5 — Validar el catálogo de apps en arm64

Antes de instalar apps desde el Supply Depot, comprobar el soporte de arquitectura:

```bash
for img in \
  ghcr.io/kiwix/kiwix-serve:3.8.1 learningequality/kolibri:0.19.4 qdrant/qdrant:v1.16 \
  ollama/ollama:0.24.0 ghcr.io/gchq/cyberchef:10.24.0 dullage/flatnotes:v5.5.4 \
  linuxserver/calibre-web:0.6.26-ls386 vaultwarden/server:1.36.0 jellyfin/jellyfin:10.11.11 \
  filebrowser/filebrowser:v2 ghcr.io/stirling-tools/s-pdf:2.13.1 \
  ghcr.io/sysadminsmedia/homebox:0.26.2 ghcr.io/corentinth/it-tools:2024.10.22-7ca5933 \
  excalidraw/excalidraw:sha-4bfc5bb ghcr.io/meshtastic/web:2.7.1 \
  ghcr.io/axistem-dev/meshcore-web:v1.45.0 \
  mysql:8.0 redis:7-alpine amir20/dozzle:v10.0 ; do
  printf '%-55s %s\n' "$img" \
    "$(docker manifest inspect "$img" 2>/dev/null \
       | grep -o '"architecture": *"[^"]*"' | sort -u | tr '\n' ' ')"
done
```

**Criterio de aceptación:** una tabla que diga qué apps son instalables y cuáles hay que
descartar o sustituir. Las que no tengan `arm64` simplemente no se instalan; no rompen el
Command Center.

---

### Fase 6 — Contenido offline

Independiente de la arquitectura, pero es lo que consume el disco:

- **Kiwix / ZIMs:** selector de Wikipedia integrado (`collections/wikipedia.json`) — desde
  el mini de ~100 MB hasta Wikipedia completa (~100 GB).
- **Mapas:** extractos regionales ProtoMaps vía el binario `pmtiles` de la imagen.
- **Kolibri:** cursos de Khan Academy.

Dimensionar contra el NVMe disponible antes de lanzar descargas masivas.

---

### Fase 7 — Operación y mantenimiento

⚠️ **Desactivar la auto-actualización.** Es el riesgo operativo principal: el sidecar
`updater` reescribe la etiqueta de imagen en el compose y tira de GHCR — es decir,
**reemplazaría tu build arm64 por el manifiesto amd64** y dejaría el Command Center caído.

- En **Settings → Advanced**, dejar `autoUpdate.enabled` y `appAutoUpdate.enabled` en `false`.
- Alternativa más contundente: eliminar el servicio `updater` del compose.
- Actualizar a mano: `git pull` en `src/`, reconstruir (Fase 1), `docker compose up -d`.

Otros puntos:

- **Sin autenticación por diseño.** El Command Center, Dozzle (9999) y las apps quedan
  abiertos a quien alcance el puerto. Restringir por firewall si el Spark está en una red
  compartida.
- **Backup:** `/opt/project-nomad/mysql` (estado), `/opt/project-nomad/storage`
  (contenido y modelos), y el `docker-compose.yml` personalizado.
- **Conectividad:** N.O.M.A.D. prueba salida contra `https://1.1.1.1/cdn-cgi/trace`.
  Ajustable en Settings → Advanced o con `INTERNET_STATUS_TEST_URL`.

---

## 5. Riesgos y mitigaciones

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| 1 | Imágenes oficiales amd64-only | **Certeza** | Alto | Build local arm64 (Fase 1) |
| 2 | Auto-update pisa el build local con amd64 | Alta | Alto | Desactivar auto-update / quitar `updater` (Fase 7) |
| 3 | `pull_policy: always` sobrescribe la imagen local | Alta | Alto | Eliminar la clave del compose (Fase 2) |
| 4 | URL del backend con `/v1` → doble prefijo | Alta | Medio | Documentado en §2.6 |
| 5 | Backend en `127.0.0.1`, inalcanzable desde el contenedor | Media | Medio | `OLLAMA_HOST=0.0.0.0` + `host.docker.internal` |
| 6 | Embeddings ausentes o de dimensión ≠ 768 | Media | Medio | Ollama nativo, o router con nombre/dimensión correctos (Fase 4) |
| 6a | `--max-model-len` corto → fallos con contexto RAG largo | Alta | Medio | Arrancar vLLM con ≥ 32768 (§3-bis.2a) |
| 6b | `--reasoning-parser` activo → razonamiento perdido | Media | Bajo | No habilitarlo (§3-bis.2b) |
| 6c | vLLM rechaza `num_ctx` / `truncate` | Media | Medio | `drop_params: true` en LiteLLM (§3-bis.2c) |
| 6d | Cambio de modelo de embeddings tras ingerir | Media | Medio | Borrar y regenerar la colección (§3-bis.3) |
| 7 | Apps del catálogo sin arm64 | Media | Bajo | Auditar antes de instalar (Fase 5) |
| 8 | `sharp`/`pdf2pic` fallan al compilar en ARM | Baja | Medio | Fijar versión de `sharp` con binarios arm64 |
| 9 | GPU no detectada (`lspci` sin GB10) | Baja | Bajo | Solo afecta al Ollama embebido; marcador manual |
| 10 | Divergencia del fork respecto a upstream | Baja | Bajo | Mantener los parches locales en commits identificables |

---

## 6. Checklist de ejecución

**Preparación**
- [ ] `uname -m` → `aarch64`; Docker + runtime `nvidia` verificados
- [ ] Decidir Opción A / B / C (§3)
- [ ] Endpoint de inferencia escuchando en `0.0.0.0`

**Construcción**
- [ ] `project-nomad:local-arm64`
- [ ] `project-nomad-sidecar-updater:local-arm64`
- [ ] `project-nomad-disk-collector:local-arm64`

**Despliegue**
- [ ] Compose adaptado: imágenes locales, sin `pull_policy`, secretos generados
- [ ] Marcador `.nomad-gpu-type`
- [ ] Command Center accesible en `:8080`

**Integración IA**
- [ ] `ai.remoteOllamaUrl` configurada (sin `/v1`)
- [ ] Modelos listados en el chat
- [ ] Chat de prueba respondiendo

**RAG**
- [ ] Qdrant arriba
- [ ] Modelo de embeddings 768d disponible en el mismo endpoint
- [ ] Colección `nomad_knowledge_base` creada e ingesta verificada

**Operación**
- [ ] Auto-update desactivado
- [ ] Catálogo de apps auditado para arm64
- [ ] Firewall y backups definidos

---

## Apéndice — Referencias al código

| Tema | Ubicación |
|---|---|
| Build sin `platforms:` | `.github/workflows/build-primary-image.yml:44` |
| Soporte arm64 en el Dockerfile | `Dockerfile:38-62` |
| Aviso de arquitectura del instalador | `install/install_nomad.sh:89-101` |
| Flujo principal del instalador | `install/install_nomad.sh:615-630` |
| Resolución del `baseUrl` del LLM | `admin/app/services/ollama_service.ts:60-84` |
| Bloqueo de *pull* en backends no-Ollama | `admin/app/services/ollama_service.ts:151-159` |
| Detección nativo vs OpenAI-compat | `admin/app/services/ollama_service.ts:723-741` |
| Validación y guardado de la URL remota | `admin/app/controllers/ollama_controller.ts:230-305` |
| Guardia SSRF (permite LAN) | `admin/app/validators/common.ts:56-100` |
| Dimensión de embeddings y colección | `admin/app/services/rag_service.ts:48-49` |
| Resolución del modelo de embeddings | `admin/app/services/rag_service.ts:293-312` |
| Nombre del modelo de embeddings | `admin/constants/ollama.ts:67` |
| Detección de GPU | `admin/app/services/docker_service.ts:1357-1399` |
| `host.docker.internal` | `install/management_compose.yaml:16-17` |
| Catálogo de imágenes | `admin/database/seeders/service_seeder.ts` |
