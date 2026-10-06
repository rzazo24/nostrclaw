# nostrclaw

*Read in English: [README.md](README.md)*

Un servidor [MCP](https://modelcontextprotocol.io) que permite a Claude **analizar un relé de Nostr**: si está sano, qué anuncia, qué pasa por él y qué claves parecen sospechosas. Es de **solo lectura**. Publicar y firmar con un firmador remoto ([NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)) está diseñado pero **deliberadamente sin activar todavía**: mira [docs/signing-design.md](docs/signing-design.md) (en inglés).

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

## Modelo de seguridad

Un asistente que lee una red pública se expone a texto escrito por desconocidos, así que el diseño asume que **todo lo que viene de la red es hostil**:

- **Solo lectura.** Ninguna herramienta publica, firma, borra ni cambia nada. Todas declaran `readOnlyHint`.
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

## Desarrollo

```bash
npm test                    # compila y ejecuta las pruebas unitarias (seguridad, análisis, herramientas con una red simulada)
RELAY_BIN=/ruta/a/nostr-relay-khatru npm test   # …y además las de extremo a extremo contra un relé real y por stdio de verdad
```

Sin `RELAY_BIN` se saltan las pruebas de extremo a extremo (si hay un [nostr-relay-khatru](https://github.com/rzazo24/nostr-relay-khatru) clonado al lado, se usa solo). El CI compila ese relé y lo ejecuta todo.

| Archivo | Qué hace |
|---|---|
| `src/server.ts` | Las herramientas y el prompt `audit_relay` |
| `src/analysis.ts` | El análisis: funciones puras sobre eventos (sin red) |
| `src/safety.ts` | Lista de relés, protección de direcciones privadas, limpieza del texto ajeno |
| `src/nostr/client.ts` | Cliente de Nostr mínimo y de solo lectura (REQ, COUNT, NIP-11, `/stats.json`) |
| `src/config.ts`, `src/index.ts` | Configuración y punto de entrada por stdio |

## Hoja de ruta

1. **0.1 (ahora)**: análisis de solo lectura.
2. **0.2**: firma con NIP-46 — conectar con un firmador remoto (Clave, nsec.app, un bunker), preparar borradores y publicar solo tras confirmación humana explícita. Diseño y modelo de amenazas en [docs/signing-design.md](docs/signing-design.md).
3. Más adelante: más análisis (comparar varios relés, señales del grafo de seguidos / red de confianza).

## Licencia

MIT
