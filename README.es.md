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

- Crear una sesión nueva y enviarle su primer mensaje.
- Enviar mensajes de seguimiento a cualquier sesión existente, con entrega
  `steer` o `queue`.
- Esperar el **turno exacto** admitido por `session.prompt`, anclado por el ID
  de mensaje que devuelve el servidor.
- Espera basada en eventos (`session.wait` + eventos `session.idle`) con un
  fallback de polling acotado.
- Reintentos idempotentes con `messageID` opcional.
- Saber si una sesión está en ejecución o inactiva usando timestamps y mensajes
  relevantes de la transcripción; los mensajes de control se ignoran.
- Leer la transcripción: mensajes del usuario, texto del asistente,
  herramientas, archivos, shell, sintéticos, compactación y razonamiento
  opcional.
- Consultar y responder solicitudes de permiso pendientes con defaults
  conservadores.
- Renombrar y archivar sesiones sin borrarlas.
- Borrar sesiones solo con opt-in explícito y `confirm: true`.
- Salida estructurada en español/inglés que nunca traduce el contenido del
  asistente, del usuario ni de las herramientas.
- Presupuestos de salida y validación de entradas configurables.
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
| `sessions.open` | Crea una sesión nueva, envía un mensaje y (por defecto) espera el turno exacto. |
| `sessions.send` | Envía un mensaje a una sesión existente. Admite `steer`, `queue`, cambio de modelo/agente y `messageID`. |
| `sessions.status` | Consulta inmediata: en ejecución/inactiva/permiso, resultado, último texto, herramientas recientes, permisos pendientes y último mensaje. |
| `sessions.permissions` | Lista las solicitudes de permiso pendientes de una sesión. |
| `sessions.reply` | Aprueba o rechaza una solicitud (`once`, `always` o `reject`), sujeto a opt-ins de seguridad. |
| `sessions.read` | Lee una transcripción acotada, incluyendo herramientas y opcionalmente salida/razonamiento. |
| `sessions.wait` | Espera el turno actual o el último iniciado. Devuelve `state: "permission"` en cuanto hay una solicitud pendiente. |
| `sessions.interrupt` | Interrumpe el turno en ejecución. |
| `sessions.list` | Lista sesiones con paginación por cursor, filtros y una foto por timestamps. |
| `sessions.update` | Renombra, archiva/desarchiva, cambia metadata o ajusta permisos sin borrar. |
| `sessions.remove` | Elimina una sesión. Es destructivo; requiere opt-in y `confirm: true`. |
| `sessions.language` | Consulta o cambia el idioma de salida (`en` por defecto, `es` disponible). |

`open`, `send` y `wait` devuelven un informe compacto con:

- el mensaje que se envió;
- el ID del mensaje admitido (`Message ID`);
- el estado final (`idle`, `timeout`, `aborted`, `permission` o `error`);
- el resultado y el texto final del asistente;
- las herramientas ejecutadas, con un resumen de omitidas si se supera el
  presupuesto;
- cualquier error del proveedor o de la sesión y el ID del último mensaje;
- los IDs de permisos pendientes y una indicación para responderlos cuando el
  turno está bloqueado.

`delivery: "queue"` no devuelve hasta que termina **el turno del prompt
encolado**. Un idle anterior del turno actual no se acepta como resultado.

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
  sessionID: created.id,
  recent: 8,
  verbose: true,
})

const result = await tools.sessions.wait({
  sessionID: created.id,
  timeoutMs: 120_000,
})

const transcript = await tools.sessions.read({
  sessionID: created.id,
  limit: 30,
  includeTools: true,
  includeToolOutput: true,
  includeReasoning: false,
})
```

### Entrega en cola e idempotencia

```ts
await tools.sessions.send({
  sessionID: "ses_...",
  prompt: "Ejecuta las pruebas después de la tarea actual.",
  delivery: "queue",
  messageID: "msg_test_suite_1",
  timeoutMs: 120_000,
})
```

Reutilizar el mismo `messageID` no crea un segundo mensaje. El ancla de espera
es el ID que devuelve `session.prompt`, así que la llamada solo termina cuando
ese turno encolado concreto ha finalizado.

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
y es destructivo.

### Gestionar permisos

Si una sesión en segundo plano pide un permiso interactivo, `sessions.wait`
devuelve `state: "permission"` con los IDs pendientes en lugar de esperar el
timeout completo. Puedes consultarlos y responderlos sin salir del agente:

```ts
const pending = await tools.sessions.permissions({ sessionID: created.id })
// Cada entrada incluye el ID de la solicitud, la acción y los recursos.

await tools.sessions.reply({
  sessionID: created.id,
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

### Idioma de salida

La salida de las herramientas está en inglés por defecto. Cambia a español (o
vuelve al inglés) en tiempo de ejecución:

```ts
await tools.sessions.language({ language: "es" })
await tools.sessions.language({ language: "en" })
```

La preferencia se guarda en el almacenamiento del plugin. El idioma solo afecta
a las etiquetas y frases fijas del plugin. El texto del asistente, los prompts
del usuario, los nombres de herramientas, su entrada/salida y los errores se
devuelven siempre tal cual.

## Configuración

Todas las opciones son opcionales. Un valor inválido produce un aviso y usa el
default.

| Opción | Default | Significado |
| --- | --- | --- |
| `language` | `"en"` | Idioma inicial de salida (`es` o `en`). |
| `defaultTimeoutMs` | `120000` | Timeout de espera por defecto. |
| `maxOutputChars` | `20000` | Techo duro para toda salida de herramienta. |
| `maxTools` | `40` | Herramientas mostradas en un resumen; el resto se resume. |
| `maxToolLine` | `500` | Caracteres máximos por línea de herramienta. |
| `maxTextChars` | `4000` | Caracteres máximos por bloque de texto. |
| `maxPermissions` | `20` | Líneas máximas de permisos en un informe. |
| `pollIntervalMs` | `500` | Intervalo inicial del fallback de polling. |
| `maxPollIntervalMs` | `2000` | Backoff máximo de polling. |
| `permissionPollMs` | `1500` | Intervalo de consulta de permisos sin eventos. |
| `requestTimeoutMs` | `10000` | Timeout por request HTTP. |
| `progressIntervalMs` | `5000` | Intervalo de progreso durante esperas. |
| `allowPermissionRules` | `false` | Permite reglas `effect: "allow"` en `open`/`update`. |
| `allowPersistentPermissions` | `false` | Permite `decision: "always"` en `reply`. |
| `allowReplyToForeignSessions` | `false` | Permite responder a sesiones ajenas. |
| `allowSessionRemoval` | `false` | Habilita `sessions.remove`. |
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

## Cómo funciona

1. `session.create` crea una sesión real.
2. `session.prompt` admite el mensaje y devuelve su ID. Ese ID es el ancla del
   turno.
3. El plugin espera con `session.wait` y eventos de sesión
   (`session.idle`, `session.execution.failed`,
   `session.execution.interrupted`, `permission.asked`). Solo acepta la
   finalización cuando el ancla aparece como mensaje de usuario y le sigue un
   mensaje `idle`.
4. Si ambas fuentes de eventos no están disponibles o fallan, usa polling con
   backoff (500 ms → 1 s → 2 s). El fallback está acotado por el timeout y por
   cinco errores consecutivos.
5. Un turno normal hace como máximo dos lecturas de `session.context`: lo normal
   es una al final. La transcripción completa se lee porque 2.2.5 no expone
   lectura paginada de mensajes desde el contexto del plugin.
6. Las salidas se construyen con presupuesto y se truncan de forma segura, sin
   partir pares sustitutos Unicode.

Las sesiones nuevas heredan el **modelo de la sesión que las crea** por defecto y
usan el agente `build`. Ambos se pueden cambiar con las opciones `model` y
`agent`.

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
- `sessions.remove` está deshabilitado por defecto y requiere `confirm: true`.
  Detiene la ejecución y no se puede deshacer. Usa `sessions.update` con
  `archived: true` para la limpieza normal.
- El plugin nunca aprueba permisos automáticamente.

## Límites y diagnóstico

- OpenCode 2.2.5 no expone `session.diff`, `session.inbox`,
  `session.message.list`, `session.active` ni `session.fork` desde el contexto
  del plugin. Este plugin no los usa.
- `read` siempre lee el contexto completo una vez; `limit` selecciona la cola a
  renderizar. La lectura paginada de mensajes no está disponible en 2.2.5.
- El estado de `list` es una foto por timestamps y puede cambiar justo después
  de la respuesta.
- Un timeout no detiene la sesión. Vuelve a consultar con `sessions.status` o
  `sessions.wait`.
- Si un permiso bloquea un turno, responde y vuelve a llamar a `sessions.wait`.
- `model` usa `provider/model`; el ID del modelo puede contener `/`.
- Si la salida se trunca, sube `maxOutputChars` o baja `recent`/`limit`.
- El plugin no elimina sesiones salvo que `allowSessionRemoval` esté activo.

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
- La CI ejecuta typecheck, tests y `npm pack --dry-run`.

## Licencia

[MIT](LICENSE)
