import type { Lang } from "./types.ts"

const es = {
  session: "Sesión",
  sessions: "Sesiones",
  title: "Título",
  state: "Estado",
  result: "Resultado",
  lastUpdate: "Última actualización",
  lastText: "Último texto",
  lastMessage: "Último mensaje",
  messageSent: "Mensaje enviado",
  finalText: "Texto final",
  actions: "Acciones",
  recentActions: "Acciones recientes",
  pendingPermissions: "Permisos pendientes",
  error: "Error",
  unknown: "(desconocido)",
  unknownF: "(desconocida)",
  noText: "(sin texto)",
  noMessages: "(sin mensajes)",
  noTitle: "(sin título)",
  noResources: "(sin recursos)",
  none: "(ninguna)",
  noTurns: "inactiva (sin turnos)",
  running: "en ejecución",
  idle: "inactiva",
  permissionState: "permiso pendiente",
  timedOutRunning: "sigue en ejecución (tiempo agotado)",
  waitCancelled: "espera cancelada",
  waitPermission: "esperando permiso",
  waitError: "error al esperar",
  queued: "en cola",
  promptMessageID: "ID del mensaje",
  noPendingTurns: "No hay turnos pendientes.",
  noSessions: "No hay sesiones.",
  user: "Usuario",
  assistant: "Asistente",
  assistantError: "Asistente [error]",
  endOfTurn: "— Fin de turno",
  transcriptTruncated: "… (transcripción recortada)",
  outputTruncated: "… (salida recortada)",
  actionsOmitted: "… {count} acciones omitidas",
  newSession: "Nueva sesión",
  remember: "recordar",
  parent: "padre",
  request: "Solicitud",
  approvedOnce: "aprobada una vez",
  approvedSaved: "aprobada y recordada",
  rejected: "rechazada",
  noPendingPermissions: "no hay solicitudes de permiso pendientes.",
  interrupted: "interrumpida",
  noActiveTurn: "no había un turno activo",
  background: "Mensaje enviado. La sesión sigue en segundo plano.",
  replyHint: "Usa sessions.reply con el ID de la solicitud para aprobar o rechazar.",
  replyHint2: "Usa sessions.reply con el ID de la solicitud para responder.",
  replyHint3: "Usa sessions.reply con sessionID y requestID para responder.",
  created: "Sesión creada",
  couldNotOpen: "No se pudo abrir la sesión",
  couldNotSend: "No se pudo enviar el mensaje",
  couldNotInspect: "No se pudo consultar la sesión",
  couldNotQueryPermissions: "No se pudieron consultar los permisos",
  couldNotReplyPermission: "No se pudo responder al permiso",
  couldNotRead: "No se pudo leer la sesión",
  couldNotWait: "No se pudo esperar la sesión",
  couldNotInterrupt: "No se pudo interrumpir la sesión",
  couldNotList: "No se pudieron listar las sesiones",
  couldNotUpdate: "No se pudo actualizar la sesión",
  couldNotRemove: "No se pudo eliminar la sesión",
  allowRuleBlocked: 'La regla de permiso "allow" está deshabilitada por defecto.',
  allowRuleHint: "Habilita allowPermissionRules: true en las opciones del plugin para permitir reglas allow.",
  alwaysBlocked: 'La decisión "always" está deshabilitada por defecto.',
  alwaysHint: "Habilita allowPersistentPermissions: true en las opciones del plugin para guardar permisos.",
  foreignSessionBlocked: "La sesión no fue creada por este plugin.",
  foreignSessionHint:
    "Habilita allowReplyToForeignSessions: true para responder permisos de sesiones ajenas.",
  removeDisabled: "El borrado de sesiones está deshabilitado por defecto.",
  removeHint: "Habilita allowSessionRemoval: true y usa confirm: true para eliminar una sesión.",
  confirmRequired: "Se requiere confirm: true para eliminar la sesión.",
  noChanges: "No se indicó ningún cambio.",
  updated: "Sesión actualizada",
  removed: "Sesión eliminada",
  archived: "archivada",
  unarchived: "desarchivada",
  agent: "Agente",
  model: "Modelo",
  cost: "Coste",
  tokens: "Tokens",
  updatedAt: "Actualizada",
  cursorNext: "Cursor siguiente",
  noMoreResults: "No hay más resultados.",
  afterNotFound: "afterMessageID no encontrado: {id}; se muestran los últimos {limit} mensajes.",
  files: "Archivos",
  shell: "Shell",
  synthetic: "Sintético",
  compaction: "Compactación",
  reasoning: "Razonamiento",
  statusSnapshot: "Estado por timestamps; puede cambiar.",
  messageQueued: "El mensaje quedó en cola; el turno aún no empezó.",
  noPromptID: "El servidor no devolvió un ID de mensaje.",
  promptEmpty: "El prompt no puede estar vacío.",
  invalidInput: "La entrada debe ser un objeto.",
  invalidTimeout: "timeoutMs debe ser un entero entre 1 y 600000.",
  invalidLimit: "limit debe ser un entero entre 1 y 200.",
  invalidListLimit: "limit debe ser un entero entre 1 y 100.",
  invalidRecent: "recent debe ser un entero entre 1 y 100.",
  invalidMaxOutput: "maxOutputChars debe ser un entero entre 1000 y 200000.",
  invalidMaxText: "maxText debe ser un entero entre 100 y 50000.",
  invalidLanguage: "El idioma debe ser es o en.",
  invalidSessionID: "sessionID debe ser una cadena no vacía.",
  invalidRequestID: "requestID debe ser una cadena no vacía.",
  invalidDecision: "La decisión debe ser once, always o reject.",
  invalidDelivery: "delivery debe ser steer o queue.",
  invalidPermissionRule: "Cada regla de permiso debe tener action, resource y effect válidos.",
  invalidTitle: "El título no puede estar vacío.",
  invalidAgent: "agent debe ser una cadena no vacía.",
  invalidModel: "model debe tener el formato provider/model.",
  invalidMessageID: "messageID debe ser una cadena no vacía.",
  invalidOrder: "order debe ser asc o desc.",
  invalidCursor: "cursor debe ser una cadena no vacía.",
  invalidMetadata: "metadata debe ser un objeto.",
  invalidSearch: "search debe ser una cadena.",
  invalidDirectory: "directory debe ser una cadena.",
  invalidParentID: "parentID debe ser una cadena.",
  invalidSubpath: "subpath debe ser una cadena.",
  optionInvalid: "Opción de plugin inválida: {name}; se usa el valor por defecto.",
  orphanSession: "La sesión {id} quedó creada, pero el prompt falló.",
  appliedChanges: "Cambios aplicados antes del error: {changes}.",
  permissionRisk: "Revisa los permisos antes de aprobarlos; una aprobación puede ejecutar acciones en segundo plano.",
  requestApproved: "Solicitud {id}: {label}.",
  sessionInterrupted: "Sesión {id}: {label}.",
  actionsCount: "Acciones ({count}):",
  recentActionsCount: "Acciones recientes ({count}):",
  pendingPermissionsCount: "Permisos pendientes ({count}):",
  permissionRules: "Reglas de permiso",
  yes: "sí",
  no: "no",
  languageSetEs: "Idioma de salida: español.",
  languageSetEn: "Idioma de salida: inglés.",
  languageCurrentEs:
    'Idioma de salida actual: español. Usa sessions.language con language: "en" para cambiarlo.',
  languageCurrentEn:
    'Idioma de salida actual: inglés. Usa sessions.language con language: "es" para cambiarlo.',
} as const

export type StringKey = keyof typeof es

const en: Record<StringKey, string> = {
  session: "Session",
  sessions: "Sessions",
  title: "Title",
  state: "State",
  result: "Result",
  lastUpdate: "Last update",
  lastText: "Last text",
  lastMessage: "Last message",
  messageSent: "Message sent",
  finalText: "Final text",
  actions: "Actions",
  recentActions: "Recent actions",
  pendingPermissions: "Pending permissions",
  error: "Error",
  unknown: "(unknown)",
  unknownF: "(unknown)",
  noText: "(no text)",
  noMessages: "(no messages)",
  noTitle: "(untitled)",
  noResources: "(no resources)",
  none: "(none)",
  noTurns: "idle (no turns)",
  running: "running",
  idle: "idle",
  permissionState: "permission pending",
  timedOutRunning: "still running (timed out)",
  waitCancelled: "wait cancelled",
  waitPermission: "waiting for permission",
  waitError: "wait failed",
  queued: "queued",
  promptMessageID: "Message ID",
  noPendingTurns: "No pending turns.",
  noSessions: "No sessions.",
  user: "User",
  assistant: "Assistant",
  assistantError: "Assistant [error]",
  endOfTurn: "— End of turn",
  transcriptTruncated: "… (transcript truncated)",
  outputTruncated: "… (output truncated)",
  actionsOmitted: "… {count} actions omitted",
  newSession: "New session",
  remember: "remember",
  parent: "parent",
  request: "Request",
  approvedOnce: "approved once",
  approvedSaved: "approved and saved",
  rejected: "rejected",
  noPendingPermissions: "no pending permission requests.",
  interrupted: "interrupted",
  noActiveTurn: "there was no active turn",
  background: "Message sent. The session continues in the background.",
  replyHint: "Use sessions.reply with the request ID to approve or reject.",
  replyHint2: "Use sessions.reply with the request ID to respond.",
  replyHint3: "Use sessions.reply with sessionID and requestID to respond.",
  created: "Session created",
  couldNotOpen: "Could not open the session",
  couldNotSend: "Could not send the message",
  couldNotInspect: "Could not inspect the session",
  couldNotQueryPermissions: "Could not query permissions",
  couldNotReplyPermission: "Could not reply to permission",
  couldNotRead: "Could not read the session",
  couldNotWait: "Could not wait for the session",
  couldNotInterrupt: "Could not interrupt the session",
  couldNotList: "Could not list sessions",
  couldNotUpdate: "Could not update the session",
  couldNotRemove: "Could not remove the session",
  allowRuleBlocked: 'The "allow" permission rule is disabled by default.',
  allowRuleHint: "Enable allowPermissionRules: true in the plugin options to allow allow rules.",
  alwaysBlocked: 'The "always" decision is disabled by default.',
  alwaysHint: "Enable allowPersistentPermissions: true in the plugin options to save permissions.",
  foreignSessionBlocked: "The session was not created by this plugin.",
  foreignSessionHint:
    "Enable allowReplyToForeignSessions: true to reply to permissions from foreign sessions.",
  removeDisabled: "Session removal is disabled by default.",
  removeHint: "Enable allowSessionRemoval: true and use confirm: true to remove a session.",
  confirmRequired: "confirm: true is required to remove the session.",
  noChanges: "No changes were specified.",
  updated: "Session updated",
  removed: "Session removed",
  archived: "archived",
  unarchived: "unarchived",
  agent: "Agent",
  model: "Model",
  cost: "Cost",
  tokens: "Tokens",
  updatedAt: "Updated",
  cursorNext: "Next cursor",
  noMoreResults: "No more results.",
  afterNotFound: "afterMessageID not found: {id}; showing the last {limit} messages.",
  files: "Files",
  shell: "Shell",
  synthetic: "Synthetic",
  compaction: "Compaction",
  reasoning: "Reasoning",
  statusSnapshot: "Timestamp snapshot; may change.",
  messageQueued: "The message is queued; the turn has not started yet.",
  noPromptID: "The server did not return a message ID.",
  promptEmpty: "Prompt cannot be empty.",
  invalidInput: "Input must be an object.",
  invalidTimeout: "timeoutMs must be an integer between 1 and 600000.",
  invalidLimit: "limit must be an integer between 1 and 200.",
  invalidListLimit: "limit must be an integer between 1 and 100.",
  invalidRecent: "recent must be an integer between 1 and 100.",
  invalidMaxOutput: "maxOutputChars must be an integer between 1000 and 200000.",
  invalidMaxText: "maxText must be an integer between 100 and 50000.",
  invalidLanguage: "Language must be es or en.",
  invalidSessionID: "sessionID must be a non-empty string.",
  invalidRequestID: "requestID must be a non-empty string.",
  invalidDecision: "Decision must be once, always, or reject.",
  invalidDelivery: "delivery must be steer or queue.",
  invalidPermissionRule: "Each permission rule must have a valid action, resource, and effect.",
  invalidTitle: "Title cannot be empty.",
  invalidAgent: "agent must be a non-empty string.",
  invalidModel: "model must use the provider/model format.",
  invalidMessageID: "messageID must be a non-empty string.",
  invalidOrder: "order must be asc or desc.",
  invalidCursor: "cursor must be a non-empty string.",
  invalidMetadata: "metadata must be an object.",
  invalidSearch: "search must be a string.",
  invalidDirectory: "directory must be a string.",
  invalidParentID: "parentID must be a string.",
  invalidSubpath: "subpath must be a string.",
  optionInvalid: "Invalid plugin option: {name}; using the default.",
  orphanSession: "Session {id} was created, but the prompt failed.",
  appliedChanges: "Changes applied before the error: {changes}.",
  permissionRisk: "Review permissions before approving; an approval can run actions in the background.",
  requestApproved: "Request {id}: {label}.",
  sessionInterrupted: "Session {id}: {label}.",
  actionsCount: "Actions ({count}):",
  recentActionsCount: "Recent actions ({count}):",
  pendingPermissionsCount: "Pending permissions ({count}):",
  permissionRules: "Permission rules",
  yes: "yes",
  no: "no",
  languageSetEs: "Output language: Spanish.",
  languageSetEn: "Output language: English.",
  languageCurrentEs:
    'Current output language: Spanish. Use sessions.language with language: "en" to change it.',
  languageCurrentEn:
    'Current output language: English. Use sessions.language with language: "es" to change it.',
}

export const STRINGS = { es, en } as const

export function t(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  let value: string = STRINGS[lang][key]
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.split(`{${name}}`).join(String(replacement))
    }
  }
  return value
}

const EXACT: Record<string, string> = {
  "No hay turnos pendientes.": t("en", "noPendingTurns"),
  "No hay sesiones.": t("en", "noSessions"),
  "Mensaje enviado. La sesión sigue en segundo plano.": t("en", "background"),
  "Usa sessions.reply con el ID de la solicitud para aprobar o rechazar.": t("en", "replyHint"),
  "Usa sessions.reply con el ID de la solicitud para responder.": t("en", "replyHint2"),
  "Usa sessions.reply con sessionID y requestID para responder.": t("en", "replyHint3"),
  "… (transcripción recortada)": t("en", "transcriptTruncated"),
  "… (salida recortada)": t("en", "outputTruncated"),
  "Nueva sesión": t("en", "newSession"),
  "(desconocido)": t("en", "unknown"),
  "(desconocida)": t("en", "unknownF"),
  "(sin mensajes)": t("en", "noMessages"),
  "(sin título)": t("en", "noTitle"),
  "(sin texto)": t("en", "noText"),
  "(sin recursos)": t("en", "noResources"),
  "(ninguna)": t("en", "none"),
  "sigue en ejecución (tiempo agotado)": t("en", "timedOutRunning"),
  "espera cancelada": t("en", "waitCancelled"),
  "permiso pendiente": t("en", "permissionState"),
  "en ejecución": t("en", "running"),
  inactiva: t("en", "idle"),
  "inactiva (sin turnos)": t("en", "noTurns"),
  interrumpida: t("en", "interrupted"),
  "no había un turno activo": t("en", "noActiveTurn"),
  "Sesiones:": t("en", "sessions") + ":",
}

function translateStateValue(value: string): string {
  const exact = EXACT[value]
  if (exact) return exact
  if (value.startsWith("inactiva (")) return `${t("en", "idle")} (${value.slice("inactiva (".length)}`
  return value
}

type Prefix = {
  spanish: string
  english: string
  value?: (value: string) => string
}

const PREFIXES: Prefix[] = [
  { spanish: "Sesión creada: ", english: `${t("en", "created")}: ` },
  { spanish: "Sesiones: ", english: `${t("en", "sessions")}: ` },
  { spanish: "Sesión: ", english: `${t("en", "session")}: ` },
  { spanish: "Título: ", english: `${t("en", "title")}: ` },
  { spanish: "Mensaje enviado: ", english: `${t("en", "messageSent")}: ` },
  { spanish: "Estado: ", english: `${t("en", "state")}: `, value: translateStateValue },
  { spanish: "Resultado: ", english: `${t("en", "result")}: `, value: translateStateValue },
  {
    spanish: "Última actualización: ",
    english: `${t("en", "lastUpdate")}: `,
    value: translateStateValue,
  },
  { spanish: "Último texto: ", english: `${t("en", "lastText")}: `, value: translateStateValue },
  { spanish: "Último mensaje: ", english: `${t("en", "lastMessage")}: ` },
  {
    spanish: "Texto final:",
    english: `${t("en", "finalText")}:`,
    value: (value) => {
      const leading = /^\s*/.exec(value)?.[0] ?? ""
      return leading + translateStateValue(value.trimStart())
    },
  },
  { spanish: "Acciones recientes: ", english: `${t("en", "recentActions")}: `, value: translateStateValue },
  { spanish: "Acciones recientes (", english: `${t("en", "recentActions")} (` },
  { spanish: "Acciones: ", english: `${t("en", "actions")}: `, value: translateStateValue },
  { spanish: "Acciones (", english: `${t("en", "actions")} (` },
  { spanish: "Permisos pendientes (", english: `${t("en", "pendingPermissions")} (` },
  { spanish: "Usuario: ", english: `${t("en", "user")}: ` },
  { spanish: "Asistente [error]: ", english: `${t("en", "assistantError")}: ` },
  { spanish: "Asistente: ", english: `${t("en", "assistant")}: ` },
  { spanish: "— Fin de turno: ", english: `${t("en", "endOfTurn")}: ` },
  { spanish: "recordar: ", english: `${t("en", "remember")}: ` },
  { spanish: " | padre: ", english: ` | ${t("en", "parent")}: ` },
  { spanish: "No se pudo abrir la sesión: ", english: `${t("en", "couldNotOpen")}: ` },
  { spanish: "No se pudo enviar el mensaje: ", english: `${t("en", "couldNotSend")}: ` },
  { spanish: "No se pudo consultar la sesión: ", english: `${t("en", "couldNotInspect")}: ` },
  { spanish: "No se pudieron consultar los permisos: ", english: `${t("en", "couldNotQueryPermissions")}: ` },
  { spanish: "No se pudo responder al permiso: ", english: `${t("en", "couldNotReplyPermission")}: ` },
  { spanish: "No se pudo leer la sesión: ", english: `${t("en", "couldNotRead")}: ` },
  { spanish: "No se pudo esperar la sesión: ", english: `${t("en", "couldNotWait")}: ` },
  { spanish: "No se pudo interrumpir la sesión: ", english: `${t("en", "couldNotInterrupt")}: ` },
  { spanish: "No se pudieron listar las sesiones: ", english: `${t("en", "couldNotList")}: ` },
  { spanish: "No se pudo actualizar la sesión: ", english: `${t("en", "couldNotUpdate")}: ` },
  { spanish: "No se pudo eliminar la sesión: ", english: `${t("en", "couldNotRemove")}: ` },
]

function localizePermissionLine(line: string): string {
  return line
    .split(` | ${t("es", "remember")}: `)
    .join(` | ${t("en", "remember")}: `)
    .split(` | ${t("es", "parent")}: `)
    .join(` | ${t("en", "parent")}: `)
    .split(t("es", "noResources"))
    .join(t("en", "noResources"))
}

function localizeLine(line: string): string {
  const exact = EXACT[line]
  if (exact) return exact

  if (line.startsWith("  · ")) return localizePermissionLine(line)

  const sessionMatch = /^Sesión (.+): (no hay solicitudes de permiso pendientes|interrumpida|no había un turno activo)\.$/.exec(
    line,
  )
  if (sessionMatch) {
    if (sessionMatch[2] === "no hay solicitudes de permiso pendientes") {
      return `${t("en", "session")} ${sessionMatch[1]}: ${t("en", "noPendingPermissions")}`
    }
    const label =
      sessionMatch[2] === "interrumpida"
        ? t("en", "interrupted")
        : t("en", "noActiveTurn")
    return `${t("en", "session")} ${sessionMatch[1]}: ${label}.`
  }

  const requestMatch = /^Solicitud (.+): (aprobada una vez|aprobada y recordada|rechazada)\.$/.exec(line)
  if (requestMatch) {
    const label =
      requestMatch[2] === "aprobada una vez"
        ? t("en", "approvedOnce")
        : requestMatch[2] === "aprobada y recordada"
          ? t("en", "approvedSaved")
          : t("en", "rejected")
    return `${t("en", "request")} ${requestMatch[1]}: ${label}.`
  }

  for (const prefix of PREFIXES) {
    if (!line.startsWith(prefix.spanish)) continue
    const value = line.slice(prefix.spanish.length)
    return prefix.english + (prefix.value ? prefix.value(value) : value)
  }

  return line
}

/**
 * Legacy compatibility translator. New code uses `t()` to build labels and
 * inserts dynamic content verbatim; this function only rewrites structural
 * labels and known fixed phrases, never arbitrary assistant/tool content.
 */
export function localize(content: string, language: Lang): string {
  if (language !== "en") return content
  return content.split("\n").map(localizeLine).join("\n")
}
