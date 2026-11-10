# opencode-session-bridge

[![CI](https://github.com/MaxiGP0/opencode-session-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/MaxiGP0/opencode-session-bridge/actions/workflows/ci.yml)

[English](README.md) | [Español](README.es.md)

Plugin de [OpenCode](https://opencode.ai) v2 que permite al agente abrir,
enviar mensajes a, observar, leer, esperar, actualizar, archivar y eliminar de
forma segura otras sesiones de OpenCode.

En lugar de delegar en un subagente hijo que desaparece dentro del turno actual,
este plugin crea **sesiones reales e independientes** que aparecen en la lista
normal de sesiones y se pueden inspeccionar o retomar después.

## Funciones

- Crear o reutilizar una sesión y enviarle su primer mensaje.
- Enviar mensajes de seguimiento a cualquier sesión existente, con entrega
  `steer` o `queue`.
- Esperar el **turno exacto** admitido por `session.prompt`, anclado por el ID
  de mensaje que devuelve el servidor.
- Esperar un turno encolado o en segundo plano concreto con
  `wait({ messageID })`.
- Espera basada en eventos (`session.wait`, `session.idle` / `session.status` y
  eventos durables `session.execution.*` / `session.retry.scheduled`) con un
  fallback de polling acotado, una fase breve de estabilización cuando la
  transcripción va por detrás del evento terminal y rearme automático cuando la
  señal pertenece a un turno anterior.
- Estado de reintento del proveedor: `status` y `wait` informan `retrying` con
  el intento, el motivo y el **timestamp absoluto** del próximo reintento. El
  `content` muestra los segundos restantes y `output.retry` añade `retryAt` y
  `retryInMs`.
- Cola background por sesión: FIFO con `queuedCount`, `queuedMessageIDs`, TTL,
  límite de tamaño y limpieza en `interrupt`/`remove`.
  `interrupt({ resume: true })` conserva la cola local.
- Reintentos idempotentes con `messageID` opcional y `open({ sessionID })`; el
  plugin persiste un mapping `messageID -> sessionID` por directorio y serializa
  los `open` concurrentes con la misma clave. Cada llamador ejecuta su propio
  `permission.assert`; una firma distinta para la misma clave es un conflicto,
  no una reutilización silenciosa.
- `send` idempotente: repetir el mismo `messageID` y firma no reaplica switches
  de modelo/agente ni envía un segundo prompt.
- El `output` está acotado globalmente por `maxOutputTotalChars`, no solo campo
  a campo.
- Los metadatos no confiables (IDs, títulos, permisos, nombres de tools, rutas y
  errores en `content`) se reducen a una línea; ANSI y saltos de línea no pueden
  inyectar estados falsos.
- Compactar una sesión (`sessions.compact`, opt-in) e inspeccionar capacidades
  del plugin (`sessions.diagnostics`).
- Saber si una sesión está en ejecución, encolada, reintentando o inactiva
  usando timestamps, mensajes relevantes y el estado en vivo de la sesión.
- Leer la transcripción: mensajes del usuario, texto del asistente,
  herramientas, archivos, shell, sintéticos, compactación y razonamiento
  opcional.
- Leer de forma incremental con `afterMessageID` + `limit` y continuar con
  `nextAfterMessageID`.
- Consultar y responder solicitudes de permiso pendientes con defaults
  conservadores.
- Pasar las acciones peligrosas por las reglas `permission.assert` del host.
- Renombrar y archivar sesiones sin borrarlas.
- Borrar sesiones solo con opt-in explícito y `confirm: true`; las sesiones
  ajenas también requieren `allowRemoveForeignSessions: true`.
- Restringir `interrupt`/`update`/`remove` a sesiones creadas o adoptadas por el
  plugin salvo que se active el opt-in de sesiones ajenas correspondiente.
- Valores `output` estructurados para Code Mode, además de `content` legible que
  nunca traduce el contenido del asistente, del usuario ni de las herramientas.
- Presupuestos de salida que conservan sesión, estado, IDs de mensaje, permisos
  y errores, con flags `textTruncated`, `textLength`, `pendingTotal` y
  `pendingTruncated`.
- Límites de entrada para prompts, títulos, búsquedas, reglas de permiso y
  metadata.
- Registro LRU/TTL de sesiones propias y mappings por directorio.
- Listar sesiones con paginación por cursor y filtros.

## Requisitos

- OpenCode v2 (probado con `2.2.5`).
- Node.js 24+ para desarrollo y tests (el plugin se ejecuta dentro de
  OpenCode).
- Una cuenta de GitHub solo si quieres instalarlo desde GitHub.

## Instalación

### Desde GitHub

```sh
opencode plugin add github:MaxiGP0/opencode-session-bridge
```

### Manual

Copia este directorio a una de las ubicaciones de plugins:

| Ámbito | Directorio |
| --- | --- |
| Global | `~/.config/opencode/plugins/session-bridge/` |
| Proyecto | `.opencode/plugins/session-bridge/` |

El punto de entrada es `index.ts`; los helpers puros viven en `src/`. OpenCode
recarga automáticamente los plugins de los directorios de configuración
vigilados. Si las herramientas no aparecen, ejecuta `/reload` en la TUI.

## Herramientas

Todas las herramientas viven en el namespace `sessions`.

| Herramienta | Descripción |
| --- | --- |
| `sessions.open` | Crea o reutiliza una sesión, envía un mensaje y (por defecto) espera el turno exacto. |
| `sessions.send` | Envía un mensaje a una sesión existente. Admite `steer`, `queue`, cambio de modelo/agente y `messageID`. |
| `sessions.status` | Consulta inmediata: en ejecución/encolada/reintentando/inactiva/permiso, resultado, último texto, herramientas recientes, permisos pendientes e IDs de mensaje. |
| `sessions.permissions` | Lista las solicitudes de permiso pendientes de una sesión. |
| `sessions.reply` | Aprueba o rechaza una solicitud (`once`, `always` o `reject`), sujeto a opt-ins de seguridad. |
| `sessions.read` | Lee una transcripción acotada, incluyendo herramientas y opcionalmente salida/razonamiento. Admite paginación incremental. |
| `sessions.wait` | Espera el turno actual, el último iniciado o el `messageID` indicado. Devuelve `state: "permission"` en cuanto hay una solicitud pendiente. |
| `sessions.interrupt` | Interrumpe el turno en ejecución. `resume: true` conserva la cola local. |
| `sessions.compact` | Compacta el contexto de una sesión. Deshabilitado por defecto (`allowCompact`). |
| `sessions.diagnostics` | Capacidades, tamaños de registro/live/cola, opciones redactadas y último evento live. Solo lectura. |
| `sessions.list` | Lista sesiones con paginación por cursor, filtros y una foto por timestamps. |
| `sessions.update` | Renombra, archiva/desarchiva, cambia metadata o ajusta permisos sin borrar. |
| `sessions.remove` | Elimina una sesión. Es destructivo; requiere opt-in, `confirm: true` y ownership (o `allowRemoveForeignSessions`). |
| `sessions.language` | Consulta o cambia el idioma de salida (`en` por defecto, `es` disponible). |
| `sessions.worktrees` | `create`/`list`/`remove` worktrees del proyecto vía `ctx.worktree`. Opt-in (`allowWorktreeManagement`); el borrado exige `confirm: true` y solo toca worktrees creados por este plugin. |
| `sessions.waitAny` | Espera una o todas las sesiones (`mode: "any" \| "all"`). Devuelve resultados parciales ante timeout/abort, responde rápido ante un permiso pendiente y detecta trabajo en background con el hook `experimental.idle` cuando está disponible. |
| `sessions.waitAll` | Alias de `waitAny` con `mode: "all"`. |
| `sessions.race` | Ejecuta un prompt en 2–8 candidatos (worktrees por defecto), captura commits/parches, opcionalmente ejecuta setup/test/teardown en serie y devuelve diffs, tests y verificación acotados. Nunca aplica nada. |
| `sessions.bestOf` | Igual que `race` más un candidato `recommended` heurístico y `rankingReasons`. Primero tests pasados, luego menor diff, luego menor tiempo. |
| `sessions.applyCandidate` | Aplica un candidato con `apply` (parche) o `cherry-pick`. Dry-run por defecto; exige `allowApplyCandidates`, `confirm: true`, target limpio, rama de respaldo y verificación opcional en un worktree de integración. |
| `sessions.raceStatus` | Consulta una carrera o todas (candidatos, commits/parches, tests, worktrees, limpieza). Solo lectura. |
| `sessions.raceList` | Lista compacta de carreras registradas. Solo lectura. |
| `sessions.raceCleanup` | Elimina los worktrees creados por una carrera. Exige `allowWorktreeManagement`, `confirm: true` y `force: true` para worktrees dirty. Las ramas se conservan. |

`open`, `send` y `wait` devuelven un informe compacto con:

- el mensaje que se envió;
- el ID del mensaje admitido (`Message ID`);
- el estado final (`idle`, `running`, `queued`, `retrying`, `timeout`,
  `aborted`, `permission` o `error`);
- el resultado y el texto final del asistente;
- las herramientas ejecutadas, con un resumen de omitidas si se supera el
  presupuesto;
- cualquier error del proveedor o de la sesión y el ID del último mensaje;
- los IDs de permisos pendientes y una indicación para responderlos cuando el
  turno está bloqueado.

`delivery: "queue"` no devuelve hasta que termina **el turno del prompt
encolado**. Un idle anterior del turno actual no se acepta como resultado.

Todas las herramientas devuelven también un objeto `output`. En Code Mode la
llamada resuelve a ese objeto; en modo texto el modelo sigue recibiendo
`content`, cuyo formato no cambia. Las herramientas encadenables exponen al
menos:

| Herramienta | Campos útiles de `output` |
| --- | --- |
| `open`, `send`, `wait` | `sessionID`, `title`, `messageID`, `state`, `outcome`, `lastMessageID`, `text`, `textLength`, `textTruncated`, `elapsedMs`, `fetchCount`, `queued`, `retry` (`next`, `retryAt`, `retryInMs`), `pendingPermissions`, `pendingTotal`, `pendingTruncated`, `permissionCheckedAt`, `error`, `errorTruncated`, `reused`, `alreadySent` |
| `status` | `sessionID`, `state`, `running`, `queued`, `queuedCount`, `queuedMessageIDs`, `queuedTruncated`, `nextQueuedMessageID`, `lastOutcome`, `lastError`, `retry`, `promptMessageID`, `lastMessageID`, `text`, `textLength`, `textTruncated`, `tools`, `toolsTruncated`, `pendingPermissions`, `pendingTotal`, `pendingTruncated`, `contextError`, `permissionError`, `transcriptAvailable`, `permissionsAvailable`, `liveStale`, `statusAt` |
| `read` | `sessionID`, `lastMessageID`, `hasMore`, `nextAfterMessageID`, `truncated`, `count`, `partial`, `partialMessageID`, `state` |
| `list` | `sessions[]`, `nextCursor`, `count`, `sessionsTruncated`, `state` |
| `permissions` | `sessionID`, `pending[]`, `pendingTotal`, `pendingTruncated`, `hasMore`, `state` |

`output` está acotado de forma independiente de `content`: el texto por
`maxTextChars`, los títulos por `maxTitleChars`, los errores por
`maxErrorChars`, los permisos por `maxPermissions` (o el `limit` de la
herramienta) y las listas por `limit`. Además, `JSON.stringify(output)` está
acotado por `maxOutputTotalChars`; los arrays se recortan y activan
`toolsTruncated`, `queuedTruncated`, `sessionsTruncated` o `pendingTruncated`
según corresponda. Los campos críticos (`sessionID`, `state`, IDs de mensaje,
IDs de permisos, totales y error) se conservan siempre. Cualquier error de
validación o de API devuelve `{ state: "error", error, sessionID? }`; las
denegaciones de `permission.assert` siguen propagándose como error de
herramienta, no como salida exitosa. `read`, `list` y `permissions` devuelven
`state: "ok"` en éxito.

Usa `created.sessionID`, no `created.id`:

```ts
const created = await tools.sessions.open({ prompt: "Revisa el módulo de auth." })
if (created.state === "idle") {
  const status = await tools.sessions.status({ sessionID: created.sessionID })
  console.log(status.text)
}
```

## Orquestación: worktrees, carreras y apply seguro

O-0 a O-5 agregan una capa de orquestación opt-in. Nada se aplica, commitea ni
pushea automáticamente.

### Ownership y workers

- `open({ directory })` crea la sesión en un directorio existente del proyecto o
  en un worktree registrado. El directorio se valida con `realpath`, rechaza
  `..`, symlinks que escapan, rutas relativas y directorios fuera del proyecto
  (salvo worktrees git con opt-in), y compara sin distinguir mayúsculas en
  Windows.
- Después de `session.create`, el plugin vuelve a leer `session.get()` y aborta
  y elimina la sesión si el host la creó en otro directorio.
- El plugin delega en el host la carga de `.opencode`, agents, skills e
  instructions del worktree para `session.create({ location })`. No copia ni
  symlinkea la configuración por su cuenta. Si el host no la descubre para un
  worktree hermano, usá la estrategia de worktree del host o copiá/symlinkeá la
  configuración explícitamente.
- Las estrategias `copy`/`clone` las controla el host. El plugin registra la
  estrategia y usa patch/fetch para apply, pero no puede imponer las exclusiones
  de copia del host (`node_modules`, `dist`, secretos, etc.). Preferí `worktree`
  cuando esté disponible.
- El llamador que abre una sesión pasa a ser su owner (`ownerSessionID`). Un
  worker en un worktree se puede gestionar desde `main` con `status`, `read`,
  `wait`, `reply`, `interrupt` y `update`.
- Una sesión creada con `runID` o en otro directorio es worker. Los workers
  tienen denegadas todas las tools `sessions.*` de orquestación por defecto. El
  preset también deniega `session_bridge.*`, `git push`, `git worktree`,
  `git checkout`/`switch`, `--force` y `external_directory`. Habilita
  `allowWorkerOrchestration: true` solo para workers de confianza.
- `open({ messageID })` incluye el directorio target en el mapping y en la clave
  in-flight. El mismo `messageID` en otro directorio es un conflicto, no una
  reutilización silenciosa.

### Worktrees

```ts
const created = await tools.sessions.worktrees({
  action: "create",
  count: 3,
  base: "HEAD",
  runID: "run_auth",
})
const listed = await tools.sessions.worktrees({ action: "list" })
```

`create` usa `ctx.worktree.create` (nunca un fallback por shell) cuando
`allowWorktreeManagement: true` y hace rollback si falla a mitad de camino.
`list` informa directorio, rama, base, estrategia, estado dirty y sesiones
asociadas. `remove` solo toca worktrees registrados, rechaza el root del
proyecto, conserva worktrees dirty o activos salvo `force: true` +
`confirm: true`, y archiva las sesiones asociadas primero por defecto. Las ramas
nunca se borran.

### Race y bestOf

```ts
const run = await tools.sessions.bestOf({
  prompt: "Implementá y verificá el fix de auth.",
  count: 3,
  mode: "worktrees",        // requiere ctx.worktree
  base: "HEAD",
  testCommand: "npm test",  // requiere allowTestCommands
  keepWorktrees: true,
  timeoutMs: 600_000,
})
// run.candidates[]: sessionID, directory, commit/patch, diffStats, files,
// tests, verification, applyStrategy; run.recommended es heurístico.
```

- `race`/`bestOf` generan `messageID` únicos (`${raceID}:${i}`), capturan el
  worktree del candidato (commit local cuando es seguro; si no, un parche que
  incluye untracked) y nunca usan el diff truncado de display para aplicar.
- Se detectan binarios, renames, cambios de modo, submodules y LFS. Un candidato
  cuyo parche no puede representarlos se marca `unsupported` y no se aplica a
  ciegas.
- Los cambios en tests/CI y tests deshabilitados (`.skip`, `.only`, `xit`,
  `fit`, `--passWithNoTests`, …) marcan `testFilesChanged`, `ciFilesChanged`,
  `skippedTests` y `verification: "flagged"`. Con `allowTestChanges: false` ese
  candidato nunca se recomienda.
- Los comandos E2E usan `execFile` sin shell, entorno allowlist, salida
  redactada, timeout, buffer acotado y kill del árbol en Windows. Los tests se
  ejecutan en serie por candidato. Si un comando necesita secretos o servicios
  que no existen localmente: `tests: { skipped: true, reason }`; el plugin nunca
  afirma que el E2E pasó.
- `same-directory` sirve para comparar respuestas, no para apply seguro: los
  candidatos comparten un solo árbol, así que los snapshots se marcan
  incompletos y `applyStrategy` es `none`.
- `waitAny`/`waitAll` detectan shells/subagentes en background con el hook
  experimental `experimental.idle` cuando lo recibe la instancia del plugin que
  posee la sesión. Para un worker en otra location, el orquestador puede no ver
  ese hook (sí ve el idle del modelo), así que la señal es best-effort.
- `bestOf` es una recomendación heurística, no un ganador absoluto. Si ningún
  candidato tiene tests pasados y confiables, `recommended` es `null`. La salida
  de cada candidato también incluye `cost`/`tokens` acotados cuando el host los
  reporta.

### Apply

```ts
await tools.sessions.applyCandidate({
  raceID: run.raceID,
  candidateID: run.recommended!,
  strategy: "cherry-pick",  // o "apply" para un parche
  verifyCommand: "npm test",
  dryRun: false,            // dryRun es true por defecto
  commit: true,
  confirm: true,            // + allowApplyCandidates + permission.assert
})
```

`applyCandidate` exige una carrera registrada, `allowApplyCandidates` y
`confirm: true`. Rechaza un target dirty, un merge/rebase/cherry-pick en curso,
una base que no es ancestro, un parche incompleto o un cherry-pick sin commit.
Verifica primero en un worktree de integración cuando se usa `verifyCommand` o
`dryRun`, crea una rama de respaldo antes de tocar el target, es idempotente
(`alreadyApplied`) y hace rollback ante fallo. `commit` y `push` son opt-ins
separados. El push nunca usa force y requiere `allowPushCandidates`; un push
rechazado se reporta y queda para rebase/retest manual. El plugin no hace rebase
automático.

`raceStatus`, `raceList` y `raceCleanup` recuperan y limpian carreras huérfanas.
`diagnostics` informa la última carrera, worktrees, salud del stream,
disponibilidad de storage y la última limpieza.

**No-goals:** no hay selección automática con un LLM, ni apply/commit/push
automáticos, ni fallback por shell para worktrees, ni garantía de que existan
secretos/servicios locales, ni borrado de ramas con commits no integrados.

## Uso

Habla con el agente en lenguaje natural:

- “Abre una sesión nueva y dile hola.”
- “Envía esta tarea a la sesión `ses_...` con entrega queue, espera y dime qué
  hizo.”
- “¿Esa sesión sigue trabajando? Lee su transcripción.”
- “Renómbrala, archívala y no la borres.”
- “Interrúmpela.”

O llama a las herramientas directamente desde un plugin o agente:

```ts
const created = await tools.sessions.open({
  prompt: "Revisa el módulo de autenticación y reporta problemas.",
  title: "Revisión de auth",
  wait: false,
  messageID: "msg_auth_review_1", // clave de idempotencia opcional
})

const status = await tools.sessions.status({
  sessionID: created.sessionID,
  recent: 8,
  verbose: true,
})

const result = await tools.sessions.wait({
  sessionID: created.sessionID,
  messageID: created.messageID, // opcional: turno exacto
  timeoutMs: 120_000,
})

const transcript = await tools.sessions.read({
  sessionID: created.sessionID,
  limit: 30,
  includeTools: true,
  includeToolOutput: true,
  includeReasoning: false,
})
```

### Entrega en cola e idempotencia

```ts
const sent = await tools.sessions.send({
  sessionID: "ses_...",
  prompt: "Ejecuta las pruebas después de la tarea actual.",
  delivery: "queue",
  wait: false,
  messageID: "msg_test_suite_1",
})

// Más tarde, espera exactamente ese turno encolado.
const result = await tools.sessions.wait({
  sessionID: sent.sessionID,
  messageID: sent.messageID,
  timeoutMs: 120_000,
})
```

Reutilizar el mismo `messageID` no crea un segundo mensaje. El ancla de espera
es el ID que devuelve `session.prompt`, así que la llamada solo termina cuando
ese turno encolado concreto ha finalizado. Sin `messageID`, `wait` usa el primer
prompt encolado de esa sesión (FIFO) y, si no hay cola, el último mensaje del
usuario por compatibilidad.

La cola background es FIFO por sesión. `status` informa `queuedCount`,
`queuedMessageIDs` y `nextQueuedMessageID`; las entradas expiran según
`queueTtlMs`, están limitadas por `maxQueuedPrompts` y se limpian con
`interrupt({ resume: false })` y `remove`. `interrupt({ resume: true })` las
conserva porque el servidor reanuda los mensajes pendientes.

`open` es idempotente de dos formas:

- Pasa `sessionID` para crear ese ID concreto o reutilizar una sesión existente.
  Un `open({ sessionID })` correcto adopta la sesión, así que los posteriores
  `interrupt`/`update` se permiten sin opt-in de sesiones ajenas.
- Reutiliza el mismo `messageID`: el plugin persiste un mapping
  `messageID -> sessionID` por directorio durante 7 días (máximo 500 entradas)
  y reutiliza la sesión mapeada. Los `open` concurrentes con el mismo
  `messageID` o `sessionID` comparten una operación, así que solo se crea una
  sesión y un prompt.

Si el prompt falla después de crear la sesión, la salida de error incluye el
`sessionID` para que un reintento no deje una sesión huérfana.

`send` también es idempotente en sus efectos secundarios: reutilizar el mismo
`messageID` con la misma firma evita el prompt y los switches de modelo/agente,
y devuelve `alreadySent: true` / `reused: true`. Reutilizar la clave con otro
prompt, agente, modelo o delivery es un conflicto. Los switches solo se aplican
si el modelo/agente actual difiere del objetivo.

Los `open` concurrentes con la misma `messageID`/`sessionID` y firma comparten
la admisión, pero cada llamador ejecuta su propio `permission.assert`, usa su
propia señal de aborto y renderiza con su propio `wait`/`maxOutputChars`. Un
llamador que aborta no cancela a los demás; una firma distinta es un conflicto.

### Lecturas paginadas

Sin `afterMessageID`, `limit` selecciona los mensajes más recientes. Con
`afterMessageID`, selecciona los **primeros** `limit` mensajes posteriores al
ancla, lo que hace predecible el polling:

```ts
const page = await tools.sessions.read({
  sessionID: "ses_...",
  afterMessageID: "msg_last_seen",
  limit: 50,
})

if (page.hasMore && page.nextAfterMessageID) {
  const next = await tools.sessions.read({
    sessionID: "ses_...",
    afterMessageID: page.nextAfterMessageID,
    limit: 50,
  })
}
```

Si un mensaje grande no cabe en el presupuesto, `read` devuelve `partial: true`
y `partialMessageID`, y `nextAfterMessageID` **no** avanza más allá de él.
Vuelve a leer el mismo ancla con un `maxOutputChars` mayor; no se pierde ningún
mensaje.

### Renombrar, archivar y eliminar

```ts
await tools.sessions.update({
  sessionID: "ses_...",
  title: "Auditoría nocturna",
  archived: true,
})

// El borrado está deshabilitado por defecto.
await tools.sessions.remove({
  sessionID: "ses_...",
  confirm: true,
})
```

Prefiere `archived: true` para la limpieza normal. `remove` detiene la ejecución
y es destructivo. También exige que la sesión sea propia (creada o adoptada por
el plugin) salvo que `allowRemoveForeignSessions: true` esté activo.

### Gestionar permisos

Si una sesión en segundo plano pide un permiso interactivo, `sessions.wait`
devuelve `state: "permission"` con los IDs pendientes en lugar de esperar el
timeout completo. Puedes consultarlos y responderlos sin salir del agente:

```ts
const pending = await tools.sessions.permissions({ sessionID: created.sessionID })
// Cada entrada incluye el ID de la solicitud, la acción y los recursos.

await tools.sessions.reply({
  sessionID: created.sessionID,
  requestID: "per_...",
  decision: "once", // once | always | reject
})
```

`always` requiere `allowPersistentPermissions: true`. Responder a sesiones que
no creó este plugin requiere `allowReplyToForeignSessions: true`.

Las sesiones nuevas también pueden recibir sus propias reglas de permisos. Por
defecto solo se aceptan reglas `ask` y `deny`:

```ts
await tools.sessions.open({
  prompt: "Ejecuta las pruebas y reporta los fallos.",
  permissions: [{ action: "shell", resource: "*", effect: "ask" }],
})
```

Para permitir una regla, hay que optar explícitamente:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-session-bridge",
      "options": { "allowPermissionRules": true }
    }
  ]
}
```

### Reglas de permiso del host

Los opt-ins anteriores son los defaults del plugin. Las herramientas
peligrosas también llaman a `permission.assert` del host antes de actuar, así
que las reglas `deny`/`ask` de OpenCode se aplican por encima:

| Acción | Herramienta |
| --- | --- |
| `session_bridge.open` | `open` |
| `session_bridge.send` | `send` |
| `session_bridge.reply` | `reply` |
| `session_bridge.update` | `update` |
| `session_bridge.remove` | `remove` |
| `session_bridge.interrupt` | `interrupt` |
| `session_bridge.compact` | `compact` |
| `session_bridge.worktrees` | `worktrees` |
| `session_bridge.waitAny` | `waitAny`, `waitAll` |
| `session_bridge.race` | `race` |
| `session_bridge.bestOf` | `bestOf` |
| `session_bridge.apply` | `applyCandidate` |
| `session_bridge.push` | `applyCandidate({ push: true })` |
| `session_bridge.raceCleanup` | `raceCleanup` |

Las herramientas de solo lectura (`status`, `read`, `wait`, `list`,
`permissions`, `language`, `diagnostics`, `raceStatus`, `raceList`) no piden
permiso. Un rechazo del host se devuelve como error de herramienta y la acción
no se ejecuta. Ejemplo conservador:

```jsonc
{
  "permissions": [
    { "action": "session_bridge.reply", "resource": "*", "effect": "ask" },
    { "action": "session_bridge.remove", "resource": "*", "effect": "ask" }
  ]
}
```

### Idioma de salida

La salida de las herramientas está en inglés por defecto. Cambia a español (o
vuelve al inglés) en tiempo de ejecución:

```ts
await tools.sessions.language({ language: "es" })
await tools.sessions.language({ language: "en" })
```

La preferencia se guarda en el almacenamiento del plugin. El idioma solo afecta
a las etiquetas y frases fijas del plugin. El texto del asistente, los prompts
del usuario y el output de las herramientas se devuelven tal cual. Los metadatos
de una línea (títulos, IDs, campos de permisos, nombres de herramientas, rutas y
errores en `content`) se sanean para evitar inyección de líneas o ANSI;
`output.error` conserva el texto original.

## Configuración

Todas las opciones son opcionales. Un valor inválido produce un aviso y usa el
default.

| Opción | Default | Significado |
| --- | --- | --- |
| `language` | `"en"` | Idioma inicial de salida (`es` o `en`). |
| `defaultTimeoutMs` | `120000` | Timeout de espera por defecto. |
| `maxOutputChars` | `20000` | Techo duro para el `content` de cada herramienta. |
| `maxOutputTotalChars` | `maxOutputChars` (`20000`) | Techo duro para `JSON.stringify(output)`. Los arrays se recortan con flags de truncado. |
| `maxTools` | `40` | Herramientas mostradas en un resumen; el resto se resume. |
| `maxToolLine` | `500` | Caracteres máximos por línea de herramienta. |
| `maxTextChars` | `4000` | Caracteres máximos por bloque de texto y por `output.text`. |
| `maxErrorChars` | `1000` | Caracteres máximos para `output.error` y motivos de retry. |
| `maxTitleChars` | `500` | Longitud máxima de título en entrada y salida (se sanean los caracteres de control). |
| `maxPermissions` | `20` | Ítems máximos de permisos en `status`/turno. |
| `maxPromptChars` | `100000` | **Code points** máximos de `prompt` y `reply.message`. |
| `maxSearchChars` | `500` | Code points máximos de `list.search`. |
| `maxPermissionRules` | `100` | Reglas de permiso máximas en `open`/`update`. |
| `maxMetadataBytes` | `32768` | Bytes serializados máximos de `update.metadata`. |
| `maxIdChars` | `256` | Code points máximos para `sessionID`, `messageID`, `requestID`, `cursor`, `parentID` y `afterMessageID`. |
| `maxAgentChars` | `128` | Code points máximos para `agent`. |
| `maxModelChars` | `256` | Code points máximos para `model`. |
| `maxPathChars` | `4096` | Code points máximos para `directory` y `subpath`. |
| `maxPermissionFieldChars` | `512` | Code points máximos para `action`/`resource` de permisos. |
| `queueTtlMs` | `3600000` | TTL de las entradas de la cola background. |
| `livePendingTtlMs` | `600000` | TTL de las entradas live de inbox/prompt usadas como anclas de espera. |
| `maxQueuedPrompts` | `100` | Prompts encolados máximos por sesión. |
| `pollIntervalMs` | `500` | Intervalo inicial del fallback de polling. |
| `maxPollIntervalMs` | `2000` | Backoff máximo de polling. |
| `permissionPollMs` | `1500` | Intervalo de consulta de permisos sin eventos. |
| `requestTimeoutMs` | `10000` | Timeout por request HTTP. |
| `progressIntervalMs` | `5000` | Intervalo de progreso durante esperas. |
| `allowPermissionRules` | `false` | Permite reglas `effect: "allow"` en `open`/`update`. |
| `allowPersistentPermissions` | `false` | Permite `decision: "always"` en `reply`. |
| `allowReplyToForeignSessions` | `false` | Permite responder a sesiones ajenas. |
| `allowInterruptForeignSessions` | `false` | Permite interrumpir sesiones no creadas o adoptadas por el plugin. |
| `allowUpdateForeignSessions` | `false` | Permite renombrar/archivar/cambiar metadata de sesiones ajenas (también requerido por `compact` en sesiones ajenas). |
| `allowSessionRemoval` | `false` | Habilita `sessions.remove`. |
| `allowRemoveForeignSessions` | `false` | Permite `remove` en sesiones no creadas o adoptadas por el plugin. Peligroso. |
| `allowCompact` | `false` | Habilita `sessions.compact`. |
| `allowCrossDirectoryManagement` | `true` | Permite que un owner/run gestione sus workers entre directorios. `false` exige el mismo directorio. |
| `allowWorkerOrchestration` | `false` | Permite que los workers usen tools `sessions.*`. Peligroso; mantener apagado. |
| `allowWorktreeDirectories` | `false` | Acepta directorios externos al proyecto si son raíces de worktrees git. |
| `allowWorktreeManagement` | `false` | Habilita `worktrees create/remove` y `raceCleanup`. |
| `allowTestCommands` | `false` | Habilita la ejecución de `setupCommand`/`testCommand`/`teardownCommand` y `verifyCommand`. |
| `allowTestChanges` | `false` | Permite que un candidato que modifica tests o CI sea considerado confiable. |
| `allowApplyCandidates` | `false` | Habilita `applyCandidate`. |
| `allowPushCandidates` | `false` | Habilita el opt-in separado `push: true`. |
| `allowSnapshotCommits` | `true` | Permite que los snapshots de race creen commits locales en los worktrees candidatos si no hay rutas tipo secreto. |
| `maxWorktrees` | `8` | Máximo de worktrees por llamada de creación. |
| `maxRaceCandidates` | `8` | Máximo de candidatos en una carrera. |
| `maxWaitSessions` | `8` | Máximo de sesiones en `waitAny`/`waitAll`. |
| `maxConcurrentSessions` | `4` | Cap de concurrencia para esperas/creación de sesiones candidatas. |
| `maxDiffBytes` | `200000` | Máximo de bytes de diff mostrados por candidato. El apply usa el commit o el parche completo, no este límite de display. |
| `maxTestOutputChars` | `20000` | Máximo de caracteres stdout/stderr por comando de test. |
| `maxRaceWallClockMs` | `600000` | Timeout global por defecto de una carrera. |
| `raceRetentionMs` | `604800000` | Retención de registros de carrera. |
| `gitTimeoutMs` | `120000` | Timeout para comandos git/verificación. |
| `debug` | `false` | Reservado para diagnóstico. |

```jsonc
{
  "plugins": [
    {
      "package": "opencode-session-bridge",
      "options": {
        "language": "en",
        "defaultTimeoutMs": 120000,
        "maxOutputChars": 20000
      }
    }
  ]
}
```

### Orquestación opt-in

Los worktrees, las carreras, los comandos de test y el apply están
deshabilitados por defecto. Esta configuración habilita lo mínimo para crear
worktrees, ejecutar tests y aplicar un candidato, y mantiene apagados el push
de candidatos y la orquestación de workers:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-session-bridge",
      "options": {
        "allowWorktreeManagement": true,
        "allowTestCommands": true,
        "allowApplyCandidates": true,
        "allowPushCandidates": false,
        "allowTestChanges": false,
        "allowWorkerOrchestration": false
      }
    }
  ],
  "permissions": [
    { "action": "session_bridge.worktrees", "resource": "*", "effect": "ask" },
    { "action": "session_bridge.race", "resource": "*", "effect": "ask" },
    { "action": "session_bridge.bestOf", "resource": "*", "effect": "ask" },
    { "action": "session_bridge.apply", "resource": "*", "effect": "ask" }
  ]
}
```

`allowPushCandidates` queda en `false` a propósito: `applyCandidate({ commit:
true })` puede crear un commit local, pero el push sigue siendo un opt-in
separado. Revisá el resultado y ejecutá `git push` manualmente si ese es tu
flujo. `allowTestChanges` queda en `false` para que los candidatos que modifican
tests o CI no se consideren confiables, y `allowWorkerOrchestration` queda en
`false` para que los workers no puedan usar las tools de orquestación.

## Cómo funciona

1. `session.create` crea una sesión real, o `session.get` reutiliza un
   `sessionID` explícito / el mapping persistido de `messageID`.
2. `session.prompt` admite el mensaje y devuelve su ID. Ese ID es el ancla del
   turno.
3. El plugin espera con `session.wait` y eventos de sesión
   (`session.idle`, `session.status`, `session.execution.started/succeeded/failed/interrupted`,
   `session.retry.scheduled`, `permission.asked`).
4. Tras una señal terminal, una fase acotada de estabilización reintenta la
   transcripción unas pocas veces (delays cortos, como máximo cuatro reintentos)
   para que un evento que llega antes de persistir el mensaje `idle` no provoque
   un timeout falso. Si la señal terminal pertenece a un turno anterior, se
   rearman `session.wait`/los eventos un número acotado de veces en vez de caer
   en polling completo.
5. Un turno exitoso requiere el ancla como mensaje de usuario, un `idle`
   posterior y un mensaje de assistant/compaction después del ancla. Los idles
   del turno anterior se ignoran, incluso tras prompts encolados o `steer`. Un
   idle failed/interrupted puede completar un turno sin texto del asistente.
6. Un retry del proveedor (`session.status` con `type: "retry"` o
   `session.retry.scheduled`) se informa como `retrying` con intento, motivo y
   próximo reintento. `next`/`at` son epoch ms absolutos; el `content` muestra
   los segundos restantes (mínimo 0) y `output.retry` añade `retryAt` (ISO) y
   `retryInMs`. No es un error y no corta la espera.
7. Si ambas fuentes de eventos no están disponibles o fallan, usa
   `session.get` (barato) más polling con backoff (500 ms → 1 s → 2 s), y lee la
   transcripción solo cuando la sesión pasa a idle o cada cinco segundos como
   red de seguridad. El fallback está acotado por el timeout y por cinco errores
   consecutivos. Una última lectura corta en el deadline puede devolver `idle`
   si el turno terminó justo a tiempo.
8. Las acciones peligrosas consultan las reglas de permiso del host antes de
   tocar la sesión.
9. Un turno normal hace unas pocas lecturas de `session.context`, normalmente
   una al final más los reintentos de estabilización. La transcripción completa
   se lee porque 2.2.5 no expone lectura paginada de mensajes desde el contexto
   del plugin.
10. Las salidas se construyen con un presupuesto que reserva sesión, estado, IDs
    de mensaje, permisos pendientes y errores antes del texto/herramientas
    opcionales. El truncado es seguro para pares sustitutos Unicode y está
    acotado por los límites solicitados. Una segunda pasada global aplica
    `maxOutputTotalChars` sobre el `output` serializado, recortando arrays de
    atrás hacia adelante y conservando los campos críticos.
11. Una cache en vivo observa hooks de prompt, eventos `session.inbox.*` y
    eventos durables de ejecución/retry (solo IDs y delivery, nunca el texto del
    prompt) para informar trabajo encolado y fallos de ejecución. La suscripción
    se reconecta con backoff acotado (1 s → 30 s), y `status` solo confía en un
    estado live fresco respecto a los timestamps de la sesión. Los pending
    expiran con `livePendingTtlMs`.
12. Las sesiones propias y los mappings se guardan por directorio con TTL de 30
    días / 7 días, evicción LRU y limpieza en `remove`. Las escrituras se
    coalescen con un debounce corto; `remove` y el cleanup del plugin hacen
    flush del estado final. `open` ya no espera dos escrituras completas antes
    de admitir el prompt.
13. `wait` trata `timeoutMs` como end-to-end: calcula el deadline antes del
    preflight, acota cada llamada por el tiempo restante, reutiliza la lista de
    permisos del preflight y da a la lectura final una única ventana de ~300 ms
    en lugar de timeouts secuenciales.

Las sesiones nuevas heredan el **modelo de la sesión que las crea** por defecto y
usan el agente `build`. Ambos se pueden cambiar con las opciones `model` y
`agent`. Un `model` explícito evita las consultas a la sesión llamadora y al
modelo por defecto. Las variantes usan `provider/model#variant`.

## Permisos y seguridad

- Cada sesión usa sus propios permisos de herramientas. Un permiso pendiente
  puede bloquear una sesión en segundo plano; `sessions.wait` devuelve
  `state: "permission"` rápidamente.
- Las reglas `effect: "allow"` se rechazan salvo que
  `allowPermissionRules: true` esté activo. Permitir acciones arbitrarias deja
  que una sesión en segundo plano ejecute shell/edición sin revisión humana. Es
  una superficie real de prompt injection: revisa cada regla y prefiere
  `ask`/`deny`.
- `decision: "always"` guarda un permiso y requiere
  `allowPersistentPermissions: true`. `once` también es una aprobación; no es
  una acción inocua.
- Por defecto `sessions.reply` solo acepta sesiones creadas por este plugin.
  Activar `allowReplyToForeignSessions` permite al agente aprobar solicitudes de
  cualquier sesión, incluidas las que no creó. Úsalo solo en entornos de
  confianza.
- `sessions.interrupt` y `sessions.update` también rechazan sesiones ajenas por
  defecto. Usa `open({ sessionID })` para adoptar una sesión, o activa
  `allowInterruptForeignSessions` / `allowUpdateForeignSessions` de forma
  explícita. `send` no adopta la sesión.
- `sessions.remove` está deshabilitado por defecto y requiere `confirm: true`.
  También exige ownership (creada o adoptada por el plugin) salvo
  `allowRemoveForeignSessions: true`. Detiene la ejecución y no se puede
  deshacer. Usa `sessions.update` con `archived: true` para la limpieza normal.
- `sessions.compact` está deshabilitado por defecto (`allowCompact`). Para
  sesiones ajenas también requiere `allowUpdateForeignSessions`.
- Las acciones peligrosas llaman a `permission.assert` con acciones
  `session_bridge.*` separadas. Un `deny` del host o un `ask` rechazado aborta
  la acción y se muestra como error de herramienta; nunca se convierte en un
  informe exitoso.
- El plugin nunca aprueba permisos automáticamente.

## Límites y diagnóstico

- OpenCode 2.2.5 no expone `session.diff`, `session.inbox`,
  `session.message.list`, `session.active` ni `session.fork` desde el contexto
  del plugin. Este plugin no los usa.
- `read` siempre lee el contexto completo una vez; la API no expone lectura
  paginada de mensajes en 2.2.5. Sin `afterMessageID`, `limit` selecciona la
  cola reciente. Con `afterMessageID`, devuelve los primeros `limit` mensajes
  posteriores al ancla e informa `hasMore` / `nextAfterMessageID`.
- `status` con `includeText: false` e `includeTools: false` evita leer la
  transcripción y devuelve solo estado/timestamps. `queued` se infiere de la cola
  FIFO local, la cache en vivo de inbox/prompts y heurísticas de la transcripción.
- El estado de `list` es una foto por timestamps y puede cambiar justo después
  de la respuesta. `cost`/`tokens` solo se incluyen con `verbose: true`.
- Un timeout no detiene la sesión. Vuelve a consultar con `sessions.status` o
  `sessions.wait`, usando el `messageID` devuelto cuando el turno estaba
  encolado.
- Si un permiso bloquea un turno, responde y vuelve a llamar a `sessions.wait`.
- `model` usa `provider/model`; el ID del modelo puede contener `/`. La variante
  se añade como `#variant`.
- `output.text`, `output.error`, títulos, permisos pendientes y resultados de
  `list` están acotados; revisa `textTruncated`, `textLength`, `pendingTotal`,
  `pendingTruncated`, `errorTruncated`, `toolsTruncated`, `queuedTruncated` y
  `sessionsTruncated`. El output serializado también está acotado por
  `maxOutputTotalChars`. Sube el límite correspondiente o baja `recent`/`limit`.
- Los límites de entrada son configurables (`maxPromptChars`, `maxTitleChars`,
  `maxSearchChars`, `maxPermissionRules`, `maxMetadataBytes`, `maxIdChars`,
  `maxAgentChars`, `maxModelChars`, `maxPathChars`,
  `maxPermissionFieldChars`) y se aplican tanto en JSON Schema como en la
  validación runtime. Las longitudes cuentan code points Unicode.
- Una lectura parcial devuelve `partial: true`; vuelve a leer el mismo
  `afterMessageID` con un `maxOutputChars` mayor en vez de avanzar.
- La orquestación de worktrees es opt-in y está deshabilitada por defecto:
  `allowWorktreeManagement`, `allowTestCommands`, `allowApplyCandidates` y
  `allowPushCandidates` son `false`. No hay selección automática de candidatos
  con un LLM, ni apply, commit o push automáticos.
- `localize` es un helper legacy deprecado. El código nuevo debe usar `t()`; el
  helper copia literalmente el contenido multilínea del asistente y las líneas
  de herramientas que no son permisos. Su eliminación está prevista para una
  futura versión major.
- El mapping de `open` expira a los 7 días y guarda como máximo 500 entradas por
  directorio. Las sesiones propias expiran a los 30 días. Usa un `sessionID`
  explícito si la ventana de reintento es mayor.
- El plugin no elimina sesiones salvo que `allowSessionRemoval` esté activo y
  la sesión sea propia (o `allowRemoveForeignSessions` esté activo).

## Desarrollo

```sh
npm install
npm run typecheck
npm test
npm run pack:check
```

- `index.ts` registra el plugin y las herramientas.
- `src/i18n.ts` contiene los diccionarios estructurados y el wrapper de
  compatibilidad `localize`.
- `src/format.ts` contiene formato de mensajes, detección de estado,
  presupuestos y renderizado de transcripciones.
- `src/validation.ts`, `src/options.ts`, `src/wait.ts`, `src/registry.ts` y
  `src/types.ts` contienen los helpers puros/de runtime.
- `tests/` cubre i18n, formato, validación, espera event-driven, anclaje de
  cola, permisos, presupuestos y la superficie de tools con un contexto falso.
- La CI ejecuta typecheck, tests y `npm pack --dry-run` en Ubuntu y Windows.

## Licencia

[MIT](LICENSE)
