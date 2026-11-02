# opencode-session-bridge

[![CI](https://github.com/MaxiGP0/opencode-session-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/MaxiGP0/opencode-session-bridge/actions/workflows/ci.yml)

[English](README.md) | [Español](README.es.md)

Plugin de [OpenCode](https://opencode.ai) v2 que permite al agente abrir,
enviar mensajes a, observar, leer, esperar e interrumpir otras sesiones de
OpenCode.

En lugar de delegar en un subagente hijo que desaparece dentro del turno actual,
este plugin crea **sesiones reales e independientes** que aparecen en la lista
normal de sesiones y se pueden inspeccionar o retomar después.

## Funciones

- Crear una sesión nueva y enviarle su primer mensaje.
- Enviar mensajes de seguimiento a cualquier sesión existente.
- Saber si una sesión está en ejecución o inactiva, y su resultado final.
- Leer la transcripción: mensajes del usuario, texto del asistente, herramientas
  ejecutadas y su salida.
- Esperar a que termine un turno, con un límite de tiempo configurable.
- Interrumpir una sesión en ejecución.
- Consultar y responder solicitudes de permiso pendientes.
- Cambiar la salida de las herramientas entre inglés y español.
- Listar las sesiones de un directorio con su estado y resultado.

## Requisitos

- OpenCode v2 (probado con `2.2.5`).
- Node.js 24+ para desarrollo y tests (el plugin se ejecuta dentro de OpenCode).
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

El plugin es un único archivo `index.ts` más `package.json`. OpenCode recarga
automáticamente los plugins de los directorios de configuración vigilados. Si
las herramientas no aparecen, ejecuta `/reload` en la TUI.

## Herramientas

Todas las herramientas viven en el namespace `sessions`.

| Herramienta | Descripción |
| --- | --- |
| `sessions.open` | Crea una sesión nueva, envía un mensaje y (por defecto) espera a que termine el turno. |
| `sessions.send` | Envía un mensaje a una sesión existente. Puede cambiar antes su agente o modelo. |
| `sessions.status` | Consulta inmediata: en ejecución/inactiva, resultado, último texto, herramientas recientes, permisos pendientes y último mensaje. |
| `sessions.permissions` | Lista las solicitudes de permiso pendientes de una sesión. |
| `sessions.reply` | Aprueba o rechaza una solicitud pendiente (`once`, `always` o `reject`). |
| `sessions.language` | Consulta o cambia el idioma de salida (`en` por defecto, `es` disponible). |
| `sessions.read` | Lee la transcripción, incluyendo herramientas y opcionalmente su salida. |
| `sessions.wait` | Espera a que termine el turno actual y devuelve el resultado. |
| `sessions.interrupt` | Interrumpe el turno en ejecución. |
| `sessions.list` | Lista las sesiones del directorio actual con estado y resultado. |

`open`, `send` y `wait` devuelven un informe compacto con:

- el mensaje que se envió;
- el estado y resultado final;
- el texto final del asistente;
- las herramientas ejecutadas;
- cualquier error del proveedor o de la sesión;
- el ID del último mensaje, útil como cursor para `sessions.read`.

## Uso

Habla con el agente en lenguaje natural:

- “Abre una sesión nueva y dile hola.”
- “Envía esta tarea a la sesión `ses_...`, espera y dime qué hizo.”
- “¿Esa sesión sigue trabajando? Lee su transcripción.”
- “Interrúmpela.”

O llama a las herramientas directamente desde un plugin o agente:

```ts
const created = await tools.sessions.open({
  prompt: "Revisa el módulo de autenticación y reporta problemas.",
  title: "Revisión de auth",
  wait: false,
})

const status = await tools.sessions.status({ sessionID: created.id })
const result = await tools.sessions.wait({ sessionID: created.id, timeoutMs: 120_000 })
const transcript = await tools.sessions.read({
  sessionID: created.id,
  includeTools: true,
  includeToolOutput: true,
})
```

### Gestionar permisos

Si una sesión en segundo plano pide un permiso interactivo, `sessions.wait`
termina por tiempo agotado e incluye los IDs de las solicitudes pendientes.
Puedes consultarlas y responderlas sin salir del agente:

```ts
const pending = await tools.sessions.permissions({ sessionID: created.id })
// Cada entrada incluye el ID de la solicitud, la acción y los recursos.

await tools.sessions.reply({
  sessionID: created.id,
  requestID: "per_...",
  decision: "once", // once | always | reject
})
```

Las sesiones nuevas también pueden recibir sus propias reglas de permisos:

```ts
await tools.sessions.open({
  prompt: "Ejecuta las pruebas y reporta los fallos.",
  permissions: [{ action: "shell", resource: "*", effect: "ask" }],
})
```

### Idioma de salida

La salida de las herramientas está en inglés por defecto. Cambia a español (o
vuelve al inglés) en tiempo de ejecución:

```ts
await tools.sessions.language({ language: "es" })
await tools.sessions.language({ language: "en" })
```

La preferencia se guarda en el almacenamiento del plugin. Si el plugin se carga
desde el array `plugins`, también puedes fijar un idioma por defecto:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-session-bridge",
      "options": { "language": "en" }
    }
  ]
}
```

## Cómo funciona

El plugin usa la API de sesiones del servidor de OpenCode a través del contexto
del plugin:

1. `session.create` crea una sesión real.
2. `session.prompt` admite el primer mensaje.
3. El plugin consulta `session.context` hasta que aparece un mensaje `idle`
   después del mensaje enviado, que marca el final del turno.
4. El texto del asistente, las herramientas y los errores se extraen de los
   mensajes proyectados y se devuelven como un informe compacto.

Las sesiones nuevas heredan el **modelo de la sesión que las crea** por defecto y
usan el agente `build`. Ambos se pueden cambiar con las opciones `model` y
`agent`.

## Permisos y limitaciones

- Cada sesión usa sus propios permisos de herramientas. Si una sesión en segundo
  plano pide un permiso interactivo, `sessions.wait` termina por tiempo agotado
  e incluye los IDs pendientes; usa `sessions.permissions` y `sessions.reply`
  para gestionarlos desde el agente.
- La espera es de 120 segundos por defecto (`timeoutMs`). Si se agota, la sesión
  sigue ejecutándose y se puede consultar de nuevo con `sessions.status`.
- El plugin no elimina sesiones. Borra las antiguas desde la interfaz o la API si
  creas muchas.
- Las descripciones están en inglés. La salida está en inglés por defecto y se
  puede cambiar con `sessions.language` o con la opción `language` del plugin.
  La API de sesiones subyacente es independiente del idioma.

## Desarrollo

```sh
npm install
npm run typecheck
npm test
```

- `index.ts` contiene el plugin; no hay paso de compilación.
- `tests/helpers.test.ts` cubre el parseo de modelos, el formato de mensajes, la
  detección de estado, los permisos y la traducción de la salida.
- La CI ejecuta el typecheck y los tests en cada push a `main` y en cada pull
  request.
- Carga el directorio con `opencode plugin add /ruta/absoluta/a/este/repo` o
  cópialo a un directorio de plugins.

## Licencia

[MIT](LICENSE)
