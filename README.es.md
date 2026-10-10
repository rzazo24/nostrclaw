# nostrclaw

*Read in English: [README.md](README.md)*

Un servidor [MCP](https://modelcontextprotocol.io) que permite a Claude **analizar un relé de Nostr**: si está sano, qué anuncia, qué pasa por él y qué claves parecen sospechosas o automatizadas, quién las avala y quién interactúa con una nota. Por defecto es de **solo lectura**. Opcionalmente (apagado hasta que lo actives) Claude también puede **preparar y publicar notas, respuestas y reacciones, y borrar tus propios eventos** mediante un firmador remoto ([NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md): Clave, nsec.app, un bunker): tu clave privada nunca llega a este programa y cada publicación necesita tu confirmación explícita. Mira [Publicar](#publicar-opcional-nip-46) y [docs/signing-design.md](docs/signing-design.md) (en inglés).

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
| `account_triage` | Lista los autores de una ventana cuyo *comportamiento* parece spam (texto compartido con otras claves —también casi iguales—, ráfagas, solo enlaces), cada punto con su motivo. Los saludos cortos («Azul», «gm») no cuentan como copia y «high» exige dos señales de comportamiento. Que falte perfil/seguidos/lista de relés en este relé suma, pero nunca marca a una clave por sí solo; las claves sin señal de comportamiento solo se cuentan. Ayuda de triaje, no veredicto |
| `event_engagement` | Un evento: respuestas, reacciones, reposts y zaps, contados a partir de los eventos que lo referencian (hasta 500; el COUNT de NIP-45 con filtro de etiqueta responde un 0 falso en khatru+sqlite, así que no se usa), desglose de reacciones y personas distintas |
| `compare_relays` | Varios relés configurados lado a lado: NIP-11 (software, NIPs, límites), latencia, eventos por hora, tipos que guarda y **propagación**: los eventos recientes de un relé de referencia (el tuyo por defecto) se buscan por id en los demás, y ves qué parte llegó a cada uno. Los relés públicos muy activos solo devuelven lo más nuevo, así que las muestras nunca se comparan directamente. Si un relé falla se informa y se compara el resto; una respuesta vacía lleva el motivo que dio el relé |
| `review_interactions` | De una nota: quién respondió, reaccionó o hizo repost, y un veredicto por persona: `promotional-bot` (responde a desconocidos con el mismo anuncio o enlaces), `automated` (publica en bloque o periódicamente, o solo reacciona, pero no empuja nada a desconocidos), `suspicious`, `unknown` o `established`. Lo que una clave *hace* —sobre todo lo que dice a otras personas— pesa más que su puntuación de confianza |
| `trust_score` | Puntuación de red de confianza para claves, a partir de las listas de seguidos que guardan los relés: seguidores, seguidores que a su vez tienen seguidores, cercanía a claves en las que *tú* confías (`trusted`), claves distintas que interactuaron con ella y tiempo visto. Pasa `pubkeys`, o ninguna para examinar las claves *nuevas* de una ventana reciente. Un anillo de claves desechables que se siguen entre sí sigue en «unknown»; cada punto lleva su motivo; es una ayuda, no una comprobación de identidad |
| `event_locations` | Para hasta 20 ids de evento, qué relés configurados tienen cada uno (solo tipo y antigüedad, sin contenido) |

`recent_events`, `count_events`, `activity_report` y `author_report` aceptan también `relays` (2 a 8 relés configurados) para preguntar a todos a la vez: las respuestas se juntan **sin duplicados**, `recent_events` indica qué relés tienen cada evento, `count_events` da un recuento por relé (sin sumarlos) y todos los resultados incluyen `perRelay` (qué devolvió cada uno, si se cortó en el límite, su evento más antiguo y más nuevo). Si un relé falla se informa y los demás contestan. Con un solo relé la salida es la de siempre.

Las dos herramientas de comparación necesitan al menos dos relés en `NOSTRCLAW_RELAYS` (separados por comas).

`recent_events`, `count_events` y `activity_report` aceptan también un filtro `tags` (`{"e": [id]}`, `{"p": [pubkey]}`, `{"t": ["bitcoin"]}`).

## Publicar (opcional, NIP-46)

Desactivado por defecto. Se activa con `NOSTRCLAW_ENABLE_SIGNING=1` y aparecen nueve herramientas más:

| Herramienta | Qué hace |
|---|---|
| `signer_connect` | Reanuda la sesión guardada o devuelve un enlace `nostrconnect://` (y el enlace universal de Clave) para que lo abras en tu firmador. Con `bunker` se conecta a una URI `bunker://` |
| `signer_status` | Estado de la conexión, con qué npub firma, la política vigente y las firmas hechas y pedidas en la última hora |
| `signer_disconnect` | Cierra la sesión y borra la clave de la aplicación guardada |
| `draft_event` | Prepara un evento **sin firmar** y lo comprueba contra tu política. No publica nada |
| `draft_reaction` | Busca un evento y prepara una reacción (NIP-25) con las etiquetas `e`, `p`, `k` (y `a`) ya construidas; contenido `+`, `-` o un emoji |
| `draft_reply` | Busca una nota y prepara una respuesta con las etiquetas de hilo de NIP-10 (marcas `root` / `reply`) y las `p` ya construidas; los `#hashtags` y `nostr:npub…` se convierten en etiquetas. La pregunta de confirmación enseña a qué respondes |
| `draft_deletion` | Prepara una **petición de borrado** NIP-09 de hasta 5 eventos *tuyos*. Busca cada uno y rechaza los que no firmó tu clave (no puede tocar eventos ajenos). **Desactivado por defecto**: añade `5` a `allowedKinds` en `policy.json`. Los relés la atienden a su criterio y pueden quedar copias hechas en otros sitios |
| `draft_relay_list` | Prepara el **reemplazo de una de tus listas de relés**: kind `10002` (NIP-65, dónde te encuentran las notas) o `10050` (NIP-17, dónde te escriben mensajes privados). Lee tu lista actual y te muestra **qué se quita, qué se añade y qué se mantiene** antes de confirmar. Solo se pueden nombrar relés de `NOSTRCLAW_RELAYS` o que ya estén en tu lista, solo `wss://`, máximo 10; se conservan los marcadores read/write de los que se quedan. **Desactivado por defecto**: añade `10002` / `10050` a `allowedKinds` en `policy.json` |
| `publish_event` | Recibe el id de un borrador, primero comprueba que el firmador está despierto (un `ping` rápido; si no hay respuesta reconstruye la conexión una vez desde la sesión guardada y repite, y solo entonces dice que Clave está en segundo plano, *antes* de preguntarte nada), luego **te pide confirmación**, hace que tu firmador lo firme y lo envía a tus relés |
| `retry_publish` | Reenvía un evento que nostrclaw firmó él mismo (se guarda 15 minutos) a los relés que no lo aceptaron, **sin nueva firma**; máximo 3 reintentos; no puede enviar nada más |

### Emparejar con una dirección `bunker://` (recomendado para Clave)

Un enlace `nostrconnect://` funciona, pero en iPhone Clave solo contesta a las peticiones de firma con la app abierta en pantalla. Emparejada con una dirección `bunker://`, su servicio de avisos puede despertarla en segundo plano. Copia la dirección de tu firmador y ejecuta esto **en tu propio terminal** (no a través del asistente: la dirección lleva un secreto):

```bash
node dist/index.js connect-bunker --claude nostrclaw-sign   # pide la dirección sin mostrarla
```

No imprime nunca la dirección ni su secreto, empareja con una clave de aplicación **nueva** y solo sustituye la sesión guardada si el firmador contesta (la anterior se copia a `signer.json.bak-before-bunker`). Después reinicia Claude Code y usa `signer_connect`: reanuda la sesión guardada. El nivel de confianza que le des en el firmador es decisión tuya y no cambia (mantenlo bajo: mira el modelo de seguridad).

Cómo queda todo bajo tu control:

- **Tu clave no sale de tu firmador.** nostrclaw solo guarda una clave de aplicación que lo identifica ante el firmador, con permisos `0600`.
- **Decide una persona, por un canal que el modelo no puede escribir.** Si tu cliente lo soporta, `publish_event` te pregunta *a ti* (elicitación de MCP) enseñando el evento exacto, quién lo firma y adónde va; sin un sí explícito no se firma nada. Después tu firmador pide su propia aprobación.
- **Clave en segundo plano:** emparejada con una **dirección `bunker://`** (mira más arriba), Clave contestó con la app en segundo plano incluso con *low trust*: la conexión se reanudó sola y llegó una petición de firma para aprobar (medido el 2026-10-09, **usando Claude Code desde Termius en el mismo iPhone que Clave**, la configuración que fallaba con `nostrconnect://`: una reacción, firmada en unos 6 s y publicada en 6 relés). Emparejada con un enlace `nostrconnect://`, con aprobación manual (*low trust*) Clave muestra una **notificación en blanco** y espera; púlsala y aprueba, y para firmar déjala abierta en pantalla. nostrclaw sigue preguntando unos dos minutos y medio mientras lo haces.
- **Usa la aprobación manual del firmador** (Clave: *low trust*). Si el firmador aprueba solo, cualquier cosa que pueda leer la clave de aplicación guardada en tu máquina —incluido un asistente con terminal— podría pedirle firmas sin ninguna pregunta; nostrclaw avisa cuando lo detecta.
- **Se detecta el «aprobar siempre».** Sin elicitación, la aprobación del firmador es la cerradura, así que se verifica: una firma que vuelve más rápido de lo que podría decidir una persona (por defecto 2 s) se **descarta y nunca se publica**, y se rechazan más publicaciones hasta que arregles el firmador y vuelvas a conectar.
- **Una política tuya** (`~/.config/nostrclaw/policy.json`, ninguna herramienta puede escribirla): tipos permitidos (por defecto solo notas `1` y reacciones `7`; añade `5` para poder borrar tus propios eventos), firmas por hora (por defecto 5; cuenta las firmas realmente hechas), longitud máxima, relés y patrones bloqueados (todo lo que parezca un `nsec1…`, `bunker://`, `secret=`…). Un archivo inválido detiene el servidor.
- **El modelo no puede alterar ni reenviar nada:** `publish_event` solo recibe un id de borrador; el evento firmado se compara con el borrador y va únicamente a los relés, nunca de vuelta a la conversación.
- **Registro de auditoría** (`~/.local/state/nostrclaw/audit.jsonl`): cada paso con ids y hashes, nunca contenido ni secretos.

Puesta en marcha con Clave en el iPhone:

```bash
claude mcp add nostrclaw -e NOSTRCLAW_ENABLE_SIGNING=1 -e NOSTRCLAW_RELAYS=wss://relay.hivescope.xyz -- node "$PWD/dist/index.js"
```

Luego pídele a Claude que *«conecte mi firmador»*, abre el enlace que te da en Clave y aprueba (**no elijas «aprobar siempre»**), y pídele *«prepara una nota que diga …»*. El enlace de conexión incluye `wss://relay.powr.build` además de tu relé, porque Clave solo recibe peticiones en segundo plano por ese.

**Recomendado para Clave en el iPhone:** empareja una vez con una dirección `bunker://` (sección anterior) y sáltate este enlace.

### Un bunker propio en lugar de Clave (opcional)

`connect-bunker` acepta la dirección `bunker://` de **cualquier** firmador NIP-46, también uno que tengas en tu propio servidor (el autor usa *hivescope-bunker*: la clave cifrada en disco, desbloqueada a mano tras cada reinicio, una conexión por aplicación con su lista de tipos y un límite por hora). El emparejamiento es el mismo: ejecuta `connect-bunker` en tu propio terminal y pega la dirección.

Cambian dos cosas, y conviene decidirlas a conciencia:

- **Tu clave vive (cifrada) en ese servidor**, no en el llavero de tu móvil. Quien tenga root en la máquina mientras el bunker está desbloqueado puede firmar dentro de los límites de la conexión.
- **Ese firmador aprueba por política, no una persona**, así que sus firmas vuelven en una fracción de segundo. nostrclaw descarta una firma que llega más rápido que `minHumanApprovalMs` (por defecto 2000), porque eso suele significar «aprobar siempre» en un firmador que debía preguntar. Con un bunker propio es lo esperado: pon `"minHumanApprovalMs": 0` en `policy.json` (un archivo que solo editas tú). Lo que sigue en pie: `publish_event` te pregunta **a ti** antes de cada firma, por un canal que el modelo no puede escribir, y la propia conexión del bunker solo permite los tipos y el ritmo que le diste.

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

## Si algo falla: `nostrclaw doctor`

Si algo no funciona, lanza el doctor. Es de solo lectura (nunca firma, publica ni escribe) y nunca imprime secretos:

```bash
node dist/index.js doctor --claude nostrclaw-sign      # la configuración que Claude Code lanza de verdad, leída de ~/.claude.json
node dist/index.js doctor --claude nostrclaw-sign --check-signer   # además reanuda la sesión y hace ping a Clave (ábrela antes en pantalla)
node dist/index.js doctor --json                        # legible por máquinas; código de salida 1 si hay un problema
```

Comprueba la versión de Node, la configuración, cada relé (dirección permitida, NIP-11, una consulta real, límites de autenticación o pago), `policy.json`, la sesión
guardada del firmador (permisos, daños, si usa `relay.powr.build`), el registro de auditoría y, con `--check-signer`, que el firmador contesta. Cada hallazgo dice
qué está mal y cómo arreglarlo. Sin `--claude` lee los `NOSTRCLAW_*` del entorno de la shell.

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
| `src/text.ts`, `src/bursts.ts` | Agrupación de textos repetidos (también casi iguales) y detección de ráfagas |
| `src/triage.ts` | `account_triage`: puntuación de comportamiento de los autores de una ventana |
| `src/trust.ts` | `trust_score`: confianza por red de seguidos, interacciones y antigüedad |
| `src/review.ts` | `review_interactions`: veredicto por persona (bot promocional / automatizada / …) |
| `src/compare.ts` | `compare_relays`: eventos por hora y propagación entre relés |
| `src/compose.ts` | Etiquetas de reacciones (NIP-25), respuestas (NIP-10), hashtags y menciones |
| `src/doctor.ts` | `nostrclaw doctor`: revisión de solo lectura de la configuración |
| `src/safety.ts` | Lista de relés, protección de direcciones privadas, limpieza del texto ajeno |
| `src/nostr/client.ts` | Cliente de Nostr mínimo y de solo lectura (REQ, COUNT, NIP-11, `/stats.json`) |
| `src/signing/` | Publicar: `policy.ts` (tu archivo de política), `signer.ts` (sesión NIP-46), `tools.ts` (las nueve herramientas), `audit.ts` |
| `src/config.ts`, `src/index.ts` | Configuración y punto de entrada por stdio |

## Hoja de ruta

1. **0.1**: análisis de solo lectura.
2. **0.2**: firma con NIP-46, opcional — conectar con un firmador remoto, preparar borradores y publicar solo tras confirmación humana explícita. Diseño y modelo de amenazas en [docs/signing-design.md](docs/signing-design.md).
3. **0.3 – 0.9 (ahora)**: `account_triage`, `event_engagement`, `trust_score` (red de confianza), `compare_relays` y `event_locations` (propagación entre relés), `review_interactions` (bots), `draft_reaction` / `draft_reply`, una comprobación rápida del firmador antes de preguntarte, `retry_publish`, `nostrclaw doctor` y análisis en varios relés a la vez.
4. **0.10**: borrar tus propios eventos (NIP-09), opcional.
5. Ideas, sin empezar: publicar el paquete en npm.

## Licencia

MIT
