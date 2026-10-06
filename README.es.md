# nostrclaw

*Read in English: [README.md](README.md)*

Un servidor [MCP](https://modelcontextprotocol.io) que permite a Claude **analizar un relé de Nostr**: si está sano, qué anuncia, qué pasa por él y qué claves parecen sospechosas. Por defecto es de **solo lectura**. Opcionalmente (apagado hasta que lo actives) Claude también puede **preparar y publicar notas y reacciones** mediante un firmador remoto ([NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md): Clave, nsec.app, un bunker): tu clave privada nunca llega a este programa y cada publicación necesita tu confirmación explícita. Mira [Publicar](#publicar-opcional-nip-46) y [docs/signing-design.md](docs/signing-design.md) (en inglés).

Escrito en TypeScript sobre el SDK oficial de MCP y `nostr-tools`. Funciona en local por stdio (Claude Code, Claude Desktop) y solo habla con los relés que permitas.

## Puesta en marcha

```bash
git clone https://github.com/rzazo24/nostrclaw && cd nostrclaw
npm install && npm run build

# Claude Code
claude mcp add nostrclaw -e NOSTRCLAW_RELAYS=wss://relay.hivescope.xyz -- node "$PWD/dist/index.js"
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "nostrclaw": {
  "command": "node", "args": ["/ruta/absoluta/a/nostrclaw/dist/index.js"],
  "env": { "NOSTRCLAW_RELAYS": "wss://relay.hivescope.xyz" }
} } }
```

Después pídele a Claude cosas como *«Audita mi relé»*, *«¿De qué está hecho el tráfico de las últimas 24 horas?»* o *«Mira esta clave: npub1…»*. El prompt `audit_relay` recorre una revisión completa.

## Herramientas

| Herramienta | Qué hace |
|---|---|
| `nostrclaw_status` | Cómo está configurado el servidor (relés permitidos, límites) y que es de solo lectura |
| `relay_overview` | Alcance y latencia (HTTP y WebSocket), documento NIP-11 (NIPs, límites, políticas) y, si el relé las publica, sus estadísticas públicas |
| `recent_events` | Eventos más recientes, filtrables por tipo, autor y antigüedad; contenido limpio y recortado; firmas verificadas |
| `count_events` | `COUNT` de NIP-45 sin descargar nada, con un mensaje claro si no está soportado |
| `activity_report` | Análisis de una muestra: recuento por tipo, eventos por hora, autores más activos, el mismo texto desde varias claves, ráfagas de una clave, porcentaje de autores con un solo evento y una lista corta de señales |
| `author_report` | Una clave: perfil (kind 0), seguidos, lista de relés, actividad en este relé |
| `account_triage` | Ordena los autores de una ventana según lo que parecen claves desechables o abusivas; cada punto de la puntuación lleva su motivo (sin perfil / seguidos / lista de relés en este relé, texto compartido con otras claves —también casi iguales—, ráfagas, solo enlaces). Ayuda de triaje, no veredicto |
| `event_engagement` | Un evento: respuestas, reacciones, reposts y zaps (NIP-45 COUNT, o una muestra si el relé no puede), desglose de reacciones y personas distintas |

`recent_events`, `count_events` y `activity_report` aceptan también un filtro `tags` (`{"e": [id]}`, `{"p": [pubkey]}`, `{"t": ["bitcoin"]}`).

## Publicar (opcional, NIP-46)

Desactivado por defecto. Se activa con `NOSTRCLAW_ENABLE_SIGNING=1` y aparecen cinco herramientas más:

| Herramienta | Qué hace |
|---|---|
| `signer_connect` | Reanuda la sesión guardada o devuelve un enlace `nostrconnect://` (y el enlace universal de Clave) para que lo abras en tu firmador. Con `bunker` se conecta a una URI `bunker://` |
| `signer_status` | Estado de la conexión, con qué npub firma, la política vigente y las firmas pedidas en la última hora |
| `signer_disconnect` | Cierra la sesión y borra la clave de la aplicación guardada |
| `draft_event` | Prepara un evento **sin firmar** y lo comprueba contra tu política. No publica nada |
| `publish_event` | Recibe el id de un borrador, **te pide confirmación**, hace que tu firmador lo firme y lo envía a tus relés |

Cómo queda todo bajo tu control:

- **Tu clave no sale de tu firmador.** nostrclaw solo guarda una clave de aplicación que lo identifica ante el firmador, con permisos `0600`.
- **Decide una persona, por un canal que el modelo no puede escribir.** Si tu cliente lo soporta, `publish_event` te pregunta *a ti* (elicitación de MCP) enseñando el evento exacto, quién lo firma y adónde va; sin un sí explícito no se firma nada. Después tu firmador pide su propia aprobación.
- **Usa la aprobación manual del firmador** (Clave: *low trust*). Si el firmador aprueba solo, cualquier cosa que pueda leer la clave de aplicación guardada en tu máquina —incluido un asistente con terminal— podría pedirle firmas sin ninguna pregunta; nostrclaw avisa cuando lo detecta.
- **Se detecta el «aprobar siempre».** Sin elicitación, la aprobación del firmador es la cerradura, así que se verifica: una firma que vuelve más rápido de lo que podría decidir una persona (por defecto 2 s) se **descarta y nunca se publica**, y se rechazan más publicaciones hasta que arregles el firmador y vuelvas a conectar.
- **Una política tuya** (`~/.config/nostrclaw/policy.json`, ninguna herramienta puede escribirla): tipos permitidos (por defecto solo notas `1` y reacciones `7`), publicaciones por hora (por defecto 5), longitud máxima, relés y patrones bloqueados (todo lo que parezca un `nsec1…`, `bunker://`, `secret=`…). Un archivo inválido detiene el servidor.
- **El modelo no puede alterar ni reenviar nada:** `publish_event` solo recibe un id de borrador; el evento firmado se compara con el borrador y va únicamente a los relés, nunca de vuelta a la conversación.
- **Registro de auditoría** (`~/.local/state/nostrclaw/audit.jsonl`): cada paso con ids y hashes, nunca contenido ni secretos.

Puesta en marcha con Clave en el iPhone:

```bash
claude mcp add nostrclaw -e NOSTRCLAW_ENABLE_SIGNING=1 -e NOSTRCLAW_RELAYS=wss://relay.hivescope.xyz -- node "$PWD/dist/index.js"
```

Luego pídele a Claude que *«conecte mi firmador»*, abre el enlace que te da en Clave y aprueba (**no elijas «aprobar siempre»**), y pídele *«prepara una nota que diga …»*. El enlace de conexión incluye `wss://relay.powr.build` además de tu relé, porque Clave solo recibe peticiones en segundo plano por ese.

## Modelo de seguridad

Un asistente que lee una red pública se expone a texto escrito por desconocidos, así que el diseño asume que **todo lo que viene de la red es hostil**:

- **Solo lectura por defecto.** Las herramientas de análisis no publican, firman, borran ni cambian nada y declaran `readOnlyHint`. Escribir solo existe tras `NOSTRCLAW_ENABLE_SIGNING=1` y con las reglas de arriba.
- **El texto ajeno va acotado.** El contenido de los eventos, los campos de perfil y la descripción del propio relé solo salen bajo una clave `untrusted`, con una nota que le dice al modelo que lo trate como datos y que nunca siga instrucciones que encuentre dentro. Las señales y las estadísticas nunca llevan texto de terceros.
- **Se quitan los caracteres ocultos** de todo lo ajeno (anchura cero, anulaciones bidireccionales, caracteres de control y «etiquetas» Unicode) y el texto largo se recorta.
- **Lista de relés permitidos.** Las herramientas solo hablan con los relés de `NOSTRCLAW_RELAYS`, así que un prompt no puede hacer que este proceso se conecte a otro sitio. Las direcciones locales y privadas se rechazan salvo con `NOSTRCLAW_ALLOW_PRIVATE=1`, no se siguen redirecciones HTTP y las respuestas tienen límite de tamaño.
- **Se verifican las firmas**; los eventos con firma incorrecta se descartan y se cuentan.
- **Salida acotada**: límites de eventos por llamada, de tamaño de muestra y de tiempo.

## Configuración

| Variable | Por defecto | Significado |
|---|---|---|
| `NOSTRCLAW_RELAYS` | `wss://relay.hivescope.xyz` | Relés que pueden usar las herramientas, separados por comas; el primero es el predeterminado |
| `NOSTRCLAW_ALLOW_PRIVATE` | desactivado | `1` permite relés en localhost o redes privadas (desarrollo) |
| `NOSTRCLAW_TIMEOUT_MS` | `8000` | Tiempo máximo por petición (500–60000) |
| `NOSTRCLAW_MAX_EVENTS` | `500` | Máximo de eventos que puede traer una llamada (1–2000) |
| `NOSTRCLAW_ENABLE_SIGNING` | desactivado | `1` activa las herramientas de firma (ver Publicar) |
| `NOSTRCLAW_SIGNER_RELAYS` | `wss://relay.powr.build` + el primer relé | Relés para hablar con el firmador |
| `NOSTRCLAW_CONFIG_DIR` | `~/.config/nostrclaw` | `policy.json` y la sesión guardada del firmador |
| `NOSTRCLAW_STATE_DIR` | `~/.local/state/nostrclaw` | `audit.jsonl` |

## Desarrollo

```bash
npm test                    # compila y ejecuta las pruebas unitarias (seguridad, análisis, herramientas con una red simulada)
RELAY_BIN=/ruta/a/nostr-relay-khatru npm test   # …y además las de extremo a extremo contra un relé real y por stdio de verdad
```

Las pruebas de firma usan un firmador NIP-46 de mentira (`test/fake-signer.ts`) a través del relé real. Sin `RELAY_BIN` se saltan las pruebas de extremo a extremo (si hay un [nostr-relay-khatru](https://github.com/rzazo24/nostr-relay-khatru) clonado al lado, se usa solo). El CI compila ese relé y lo ejecuta todo.

| Archivo | Qué hace |
|---|---|
| `src/server.ts` | Las herramientas y el prompt `audit_relay` |
| `src/analysis.ts` | El análisis: funciones puras sobre eventos (sin red) |
| `src/safety.ts` | Lista de relés, protección de direcciones privadas, limpieza del texto ajeno |
| `src/nostr/client.ts` | Cliente de Nostr mínimo y de solo lectura (REQ, COUNT, NIP-11, `/stats.json`) |
| `src/signing/` | Publicar: `policy.ts` (tu archivo de política), `signer.ts` (sesión NIP-46), `tools.ts` (las cinco herramientas), `audit.ts` |
| `src/config.ts`, `src/index.ts` | Configuración y punto de entrada por stdio |

## Hoja de ruta

1. **0.1**: análisis de solo lectura.
2. **0.2 (ahora)**: firma con NIP-46, opcional — conectar con un firmador remoto, preparar borradores y publicar solo tras confirmación humana explícita. Diseño y modelo de amenazas en [docs/signing-design.md](docs/signing-design.md).
3. Más adelante: más análisis (comparar varios relés, señales del grafo de seguidos / red de confianza).

## Licencia

MIT
