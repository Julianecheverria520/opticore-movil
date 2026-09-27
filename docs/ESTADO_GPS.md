# Estado: viajes con GPS en la app (opticore-movil + AppTransporte)

Última actualización: 2026-09-27. opticore-movil en GitHub (`main`, ver §6). AppTransporte: `99b4636` en producción; **`6003791` (ruta óptima y peajes) y `27bfd08` locales, sin push al 2026-09-27** (ver §3.12). SQL de rutas/peajes corrido en Supabase y relleno de la empresa 1 aplicado.
Leer este archivo al empezar cualquier sesión sobre viajes/GPS.

---

## 1. Qué está hecho

### Backend (AppTransporte) — desplegado en producción hasta `99b4636`
| Commit | Qué |
|---|---|
| `5cae573` | Paso 1 · `/trayecto` filtra por empresa (super_admin ve todas); `operacion.py` y `tracking.py` usan `get_current_payload` (tokens revocados); `/finalizar-viaje` y `/subir-foto` responden 404 para otra empresa; `recalcular-costos-historicos` exige super_admin |
| `694d54c` | Seguridad: peajes (importar = super_admin, lista = sesión), perfiles/OCR/digitación con dependencias estándar, `exportar-pdf` valida revocación, `/gestion-mantenimiento` exige admin |
| `a77d38c` | Paso 2 · `/movil/maestros` v2: materiales, rutas con coordenadas, datos de carga, `ultimo_preop_fecha`, `usa_preoperacional` (solo agrega claves; la app v1 sigue funcionando) |
| `1346309` | Paso 3 · `POST /movil/viajes/iniciar` y `GET /movil/viajes/activo` (idempotentes por `uuid_cliente`, marca de revisión) + migración SQL paso 1 |
| `9a34368` | Paso 4 · `POST /movil/viajes/{uuid}/puntos` (lotes ≤500, `ON CONFLICT (id_viaje, seq) DO NOTHING`) |
| `49a6c0b` | Paso 5 · `POST /movil/viajes/{uuid}/foto` y `/finalizar` (idempotentes) |
| `42424e7` | Gestor de vales: distintivo REVISAR, filtro "Solo por revisar", "Marcar como revisado" (`revisado_por`, `fecha_revisado`) |
| `29c91ee` | Escape de HTML común (`static/js/seguridad_html.js`) en todas las pantallas; `sw.js` caché v7 |
| `3e454c3` | `get_current_payload` rechaza usuario inactivo / empresa SUSPENDIDO (401; 503 si la base falla). Cache `usr_ok:{id}` / `usr_ok:sub:{user}` 60 s, invalidación al cambiar `activo` y el estado de la empresa. `api/tests/test_usuario_habilitado.py` |
| `dae79b0` | `POST /auth/token-movil`: token `canal=movil`, 7 días para `conductor` (`MOVIL_TOKEN_EXPIRE_MINUTES`, por defecto 10080), 8 h otros roles. Un token móvil solo entra a `/movil/*`, preoperacional validar/guardar y combustible/guardar (`auth.RUTAS_MOVIL`); en el resto 401, y no abre exportaciones ni vistas web. `/auth/token` sin cambios. `api/tests/test_token_movil.py` |
| `ca29564` | Fallas del preoperacional: `fallas.py` (fallas abiertas del último preoperacional, `desde` real recorriendo ≤ 90 días, 3 consultas por empresa; `extraer_observacion` entiende `FALLA [..]`, `Auditoría [..]` y el formato viejo de la app). `/validar` con `dias_abierta` real (+ `pregunta_id`, `desde`, `es_critica`, `ultima_obs`); `/movil/maestros` con `usa_autogestion_fallas` y `fallas_abiertas` por equipo; `/guardar`: pregunta **crítica** en falla = TALLER (lo decide el servidor) y devuelve `estado_equipo`. `api/tests/test_fallas_preoperacional.py` |
| `b44a822` | PWA preoperacional: "AÚN FALLA" solo va a TALLER si la pregunta es crítica; días reales; `ultima_obs`; escapa `obsAnterior`; `sw.js` caché v8 |
| `99b4636` | `CLAUDE.md`: no mostrar credenciales ni correr `test_api.py` / la suite completa (usan la base de producción) |
| `6003791` | **Sin push.** Ruta óptima y peajes: `api/maestros/rutas_geometria.py` (OSRM demo por defecto u OpenRouteService `driving-hgv` con `RUTEO_PROVEEDOR`/`ORS_API_KEY`; timeout 6 s; máx. 1 petición/s; Douglas-Peucker 15 m; polyline precisión 5). Se calcula al crear/editar ruta (sin pedir nada si origen/destino no cambian) y en segundo plano al mover un lugar; si falla, "sin geometría" (`geometria_error`). Peajes a ≤150 m de un tramo, ordenados, en `rutas_peajes`; se recalculan al importar peajes. `/movil/maestros`: `geometria` y `peajes` por ruta, `categoria_peaje` por equipo. `equipos.categoria_peaje` (I–VII). `scripts/rellenar_geometria_rutas.py`. `leaflet-routing-machine@3.2.12`. SQL: `migraciones_sql/2026_09_rutas_geometria_peajes.sql` (**ya corrido**) |
| `27bfd08` | **Sin push.** `borrar-empresa` borra primero `rutas_peajes` de sus rutas; importar peajes no da 500 si falla el recálculo. `api/tests/test_borrados_rutas_peajes.py` (SQLite con llaves foráneas) |

Verificado en producción el 2026-09-26 (peticiones sin credenciales): `sw.js` = `opticore-v8`, `POST /auth/token-movil` existe (422 sin datos), la PWA sirve el `preoperacional_logic.js` nuevo.

Migraciones **ya ejecutadas** en Supabase: `migraciones_sql/2026_09_viajes_movil_paso1.sql` y `2026_09_viajes_revision_resuelta.sql`.

### App (opticore-movil)
| Commit | Qué |
|---|---|
| `ce1356c` | Paso 6 · expo-task-manager, expo-file-system, expo-dev-client; plugin expo-location con segundo plano y servicio en primer plano |
| `dca66ca` | Development build con paquete propio `com.julianecheverria.opticoremovil.dev` y nombre "OptiCore DEV" (`app.config.js` + `APP_VARIANT`) |
| `66c7208` | Bloquea `RECORD_AUDIO` |
| `2c71693` | Paso 7 · SQLite v4 (`viajes_locales`, `puntos_gps`, `materiales`, `rutas`) y sync de maestros v2 |
| `b19bbc0` | Paso 8 · Pantalla de viaje sin GPS: preoperacional del día, formulario offline, cola de viaje, finalizar |
| `33d0901` | Paso 9 · Tarea `opticore-gps` (`src/gps/tarea.js`), filtros, `seq`, subida de puntos por lotes de 200, cierre solo sin puntos pendientes |
| `0689156` | Paso 10 · Permiso "todo el tiempo" (pantalla propia), avisos, guía de batería, reanudación al abrir / volver al frente |
| `9e4199d` | "Detenido / sin movimiento" vs "Esperando señal GPS" (columna `gps_ultima_precision`) |
| `3f97ffb` | **Corrección de la cola**: fotos con subida nativa (`UploadTask`), las fotos ya no bloquean puntos ni cierre, diagnóstico por etapa en "Viaje en curso" |
| `56164ae` | Diagnóstico de fotos con tamaño (KB), tiempo y límite |
| `6849eff` | Cola de preoperacionales/tanqueos: guarda el mensaje real de las excepciones |
| `d2c642f` | Fotos reducidas a ≤1600 px de ancho y JPEG 0.7 (`expo-image-manipulator`); límite de subida de fotos 120 s |
| `023f689` | `app.json`: permiso `RECEIVE_BOOT_COMPLETED`. Sin él la app se cerraba con el primer punto GPS (`IllegalArgumentException: Requested job cannot be persisted…`): expo-task-manager programa un trabajo persistente (`setPersisted(true)`) y su manifiesto no declara el permiso |
| `f871e06` | Paso 11 · "Detenido / sin movimiento" también con la velocidad del último punto (< 5 km/h → 1 min; si no, 3 min); "Activo · en movimiento", "Consultando…", "Recorrido terminado" |
| `159af8b` | Versión 1.1.0 para el build `preview` (piloto v2) |
| `95a1ea3` | `docs/GUIA_CONDUCTOR.md`: guía corta para el conductor del piloto |
| `0c68f50` | `.gitignore`: `.env`, `.env.*`, keystores, `credentials.json`, `google-services.json` |
| `dda305f` | Login: con 403 (cuenta inactiva / empresa suspendida) muestra el motivo del servidor |
| `13e2ef9` | Reintentos **por etapa** (SQLite v8 `intentos_etapa`): las fallas de una foto ya no llevan el cierre a error |
| `45cbb7c` | Cola: inicio → puntos → foto de carga → foto de descarga → cierre; foto SIN RESPUESTA en pausa 5 min ("Enviar ahora" la fuerza) |
| `00e8949` | Viaje con problema de envío: **Reintentar / Descartar** en Viaje en curso y franja roja en Home |
| `1e0de5c` | Finalizar: guarda el cierre y después apaga el GPS |
| `5af66b5` | `POST_NOTIFICATIONS` (Android 13+): se pide al iniciar el viaje; aviso si falta. **Requiere build nuevo** |
| `7dcd013` | Conciliación con `/movil/viajes/activo`: franja naranja en Home y confirmación al iniciar si hay viajes abiertos en el servidor que el celular no tiene |
| `8d455a1` | Guía del conductor y este archivo al día |
| `a18c99c` | Login con `/auth/token-movil` (respaldo a `/auth/token` si 404); "Salir" revoca el token (`/auth/logout`) |
| `fe841e3` | Token en `expo-secure-store` (`src/sesion.js`), migración desde AsyncStorage; sin módulo nativo o si falla, sigue en AsyncStorage. **Requiere build nuevo** |
| `e700487` | Este archivo al día |
| `e9cf503` | **Mapa en Viaje en curso** (MapLibre 11.4, config plugin, nueva arquitectura): botón Ver/Ocultar mapa (se monta solo abierto), línea desde SQLite (simplificada si > 2000 puntos), refresco ≤ 10 s, origen verde / destino rojo desde `rutas`, posición = último punto o última ubicación del sistema (no enciende GPS propio), fondos OSM/Carto en `src/config.js` (`MAPA_FONDOS`), aviso "Mapa sin fondo (sin señal)". **Requiere build nuevo** |
| `bef74e1` | Equipo recordado: al abrir entra directo al panel del último equipo (o el del viaje en curso); "Cambiar" y "Salir" lo olvidan |
| `e842310` | **Viaje en curso a pantalla completa**: mapa de fondo (sigue la posición; "centrar en mí"; fondo claro/oscuro), franja superior (placa, material, ruta, estado GPS, envío) y panel inferior deslizable con "Preoperacional / Novedad" y "Finalizar viaje"; arriba del panel, todo el detalle de antes. Si el mapa no existe o falla: la pantalla anterior sin mapa. El mapa no refresca en segundo plano ni con otra pantalla encima. **Mapa y pantalla completa probados en campo** |
| `c6e4486` | **Seguimiento de fallas del preoperacional sin señal** (`src/fallas.js`, SQLite v9 `fallas_abiertas`): tarjeta "FALLA PREVIA (N días)" con "YA SE ARREGLÓ / AÚN FALLA" (observación obligatoria), TALLER solo por pregunta crítica, textos con formato PWA, actualización local al guardar. Con servidor viejo funciona como antes. Solo JS |
| `8ae49cf` · `02ef3b0` · `7b617f5` | **Logos 1.1.2**: launcher solo con el cubo (dentro de la zona segura), logo completo en el splash (`expo-splash-screen`, 136 dp, sobre blanco), ícono de la notificación del GPS = cubo blanco (`plugins/icono-notificacion.js` → drawable `notification_icon`); `expo-system-ui`, `expo-font`; sin `edgeToEdgeEnabled` ni `newArchEnabled`. `expo-doctor` 21/21 y `prebuild` sin avisos. **Requiere build nuevo** |

Base local del celular: SQLite `user_version` 9 (v5 GPS, v6 precisión, v7 `diag_envio`, v8 `intentos_etapa`, v9 `fallas_abiertas`).
`viajes_locales.sync_status`: `pending | synced | error | descartado`; `estado_local`: `EN_CURSO | FINALIZADO | DESCARTADO`.

---

## 2. Cómo se prueba

- **Development build** ("OptiCore DEV", se instala junto a la app del piloto):
  `npx eas-cli build -p android --profile development`
- **Servidor JS**: `npx expo start --dev-client --tunnel` (en `opticore-movil`). En desarrollo la app usa producción (`src/config.js`), salvo `EXPO_PUBLIC_API_URL`.
- **Backend local** (lee y escribe en la base de PRODUCCIÓN): en `AppTransporte`,
  `$env:INIT_DB="false"; py -3.13 -m uvicorn main:app --host 0.0.0.0 --port 8082`
- **Datos de prueba**: empresa **DataPrueba (id 1)**, conductor **1012392327**, placa **JMU965**, remisiones **`PRUEBA-GPS-…`**. Solo escribir ahí.
- **Web**: Gestor de vales (`/gestor-vales`) para ver, anular y revisar viajes; monitor y `/trayecto` para el recorrido.
- **En la app**: "Viaje en curso" → bloque "Diagnóstico de envío (último intento)" muestra código HTTP, mensaje, KB/tiempo de fotos y hora de cada etapa.
- **Bancos de prueba en Node** (SQLite real con `node:sqlite`, módulos reales de la app, servidor local): se recrearon el 2026-09-26 en el scratchpad (`banco/`: cargador con módulos nativos simulados, servidor falso; pruebas de las mejoras 1, 2, 4 y 7, 23 comprobaciones). **No están versionados**; si se necesitan otra vez, pedir moverlos a `scripts/banco/`.

---

## 3. Pendientes

1. ~~Development build nuevo~~ y ~~pruebas en carro~~: **hechos el 2026-09-25** (app abierta, pantalla bloqueada, modo avión, reinicio, finalizar: todo bien). `86102E53` ya está anulado.
2. **Prueba de noche de la foto**: anotar KB y segundos del diagnóstico.
3. ~~Desplegar backend~~ (`99b4636` en producción) y ~~development build nuevo~~ (mapa y pantalla completa probados en campo). **Sigue: build `preview` 1.1.1** (ver §7), instalar encima del piloto y repetir "cerrada desde recientes" y "sin todo el tiempo".
4. ~~Token de 7 días (3b)~~ y ~~secure-store~~: hechos (`dae79b0`, `a18c99c`, `fe841e3`). Las sesiones abiertas antes siguen con su token de 8 h hasta que venza; el siguiente login ya usa `/auth/token-movil`.
6. **Después del piloto (mejora 8)**: distancia acumulada en vez de releer todos los puntos cada 10 s, prueba de volumen de puntos, limpieza de fotos huérfanas (con error que nunca se borran).
7. **Paso 12 · piloto** con 1 volqueta en paralelo a la PWA, 2–3 días: comparar recorridos, batería y viajes perdidos.
8. ~~Usuarios inactivos~~: hecho en `3e454c3` (desplegado).
10. **Fallas del preoperacional: listas** (backend `ca29564` + PWA `b44a822` en producción, sin SQL; app `c6e4486`, entra en el `preview` 1.1.1). DataPrueba tiene `usa_autogestion_fallas = true` pero **ninguna pregunta crítica**: marcar una (p. ej. la 3, freno) para probar TALLER; la pregunta 2 tiene el texto dañado. Después del piloto: resolver fallas desde taller/oficina con tabla propia.
11. ~~Incidente de credenciales (2026-09-26)~~: la cadena de conexión de Supabase quedó en una conversación; **cerrado, contraseña rotada**. Reglas nuevas en `CLAUDE.md` de ambos repos.
12. **Push y despliegue de `6003791` + `27bfd08`** (AppTransporte): sin ellos `/movil/maestros` no manda `geometria`/`peajes`. Verificar después con la sesión: `/movil/maestros` → rutas con `geometria`.
13. **Después del piloto · borrar empresa** (`DELETE /super_admin/borrar-empresa`): borra equipos y usuarios sin borrar antes lo que depende de ellos (preoperacionales y sus detalles, historial de mantenimiento, tanqueos: `equipo_id`/`usuario_id` obligatorios). Con cualquiera de esos registros el borrado falla con 500 y no borra nada. `rutas_peajes` ya está resuelto (`27bfd08`).
9. **Anular viajes de prueba** en el Gestor de vales. Consulta de solo lectura del 2026-09-25 (DataPrueba, sin anular):
   ids #276–280, #282, #283, #285–289 (`PRUEBA-GPS-010/030/031/032`, FINALIZADOS, marcados REVISAR), `62A17B79` (#291, remisión `8288W8W8WUW`, FINALIZADO, REVISAR), #130 (`PRUEBA 134`, mayo). #260 (conductor 79278242, RNS080, EN_PROGRESO desde 2026-09-21) **era de prueba**: anularlo con los demás. `62F053CD` y `2E148DC3` ya están anulados.

---

## 4. Decisiones tomadas

- **Preoperacional del día**: con señal se consulta `/validar` en vivo; sin señal, `ultimo_preop_fecha` = hoy (Bogotá) o un preoperacional de hoy en el celular; si no se sabe, **se exige**.
- **Viaje offline que excede el plan / placa inactiva / otro viaje abierto / cantidad > capacidad + 2 / fecha > 7 días**: el servidor lo **acepta y lo marca** `requiere_revision` con `motivo_revision`. Placa que no existe en la empresa = 404 permanente.
- **Fechas**: `fecha_inicio`/`fecha_fin`/`timestamp` en texto `YYYY-MM-DD HH:MM:SS` hora Bogotá (igual que `operacion.py`); `ts` de cada punto = `location.timestamp`.
- **GPS**: `Accuracy.High`, 30 m, 15 s, deferred 60 s **y** 100 m (en Android el diferido solo aplica en segundo plano y exige ambas condiciones). Descarta precisión > 50 m y saltos > 150 km/h; guarda y cuenta ubicaciones simuladas.
- **Servicio en primer plano**: según la documentación de Android, iniciado con la app visible sigue recibiendo ubicación con pantalla apagada **sin** "todo el tiempo"; lo que no se puede es crearlo desde segundo plano (Android 14: `SecurityException`). Por eso se reanuda al abrir / volver al frente.
- **Cola del viaje**: inicio → puntos → foto de carga → foto de descarga → cierre. Las **fotos no bloquean**; el **cierre espera** a que no queden puntos. Toda falla queda en `diag_envio`. Cada etapa cuenta sus fallas (`intentos_etapa`); 4xx (salvo 408/429) o 5 fallas → error de esa etapa. Una foto SIN RESPUESTA espera 5 min antes de reintentarse.
- **Viaje con problema**: el conductor decide **Reintentar** (etapas en error y puntos rechazados vuelven a la cola) o **Descartar** (deja de enviar; borra fotos y puntos no enviados del celular; lo que ya está en el servidor lo anula el admin).
- **401 por usuario inactivo / empresa suspendida** = sesión vencida: la app no borra la cola. 503 = reintentar.
- **Token de la app**: `/auth/token-movil`, 7 días solo para conductores, limitado a las rutas de la app; guardado en SecureStore (Keystore), excluido de las copias de seguridad de Android. Una ruta nueva que use la app con token debe agregarse a `auth.RUTAS_MOVIL` o responderá 401.
- **Fallas del preoperacional (autogestión)**: sin tabla propia; una falla está abierta si la pregunta quedó en falla en el **último** preoperacional del equipo (el más reciente por `fecha_reporte` manda, también con reportes que llegan tarde). La respuesta del conductor viaja dentro del preoperacional (`check_list` + `observaciones` con formato PWA). "AÚN FALLA" en pregunta **crítica** = TALLER; no crítica = sigue ACTIVO y la falla sigue abierta. El servidor aplica la regla en `/guardar`; la app y la PWA la replican (la app sin señal). Placas con preoperacionales sin enviar conservan sus fallas locales al bajar maestros. Taller/oficina no cierran fallas (después del piloto).
- **Fotos**: ≤1600 px de ancho, JPEG 0.7, subida nativa multipart, límite 120 s.
- **Web**: `seguridad_html.js` (`escaparHTML`, `argJS`, `urlSegura`) para todo texto del servidor insertado con `innerHTML`.

---

## 5. Cosas a vigilar

- **Fallo intermitente de `ultimo_preop_fecha`**: en una de 5 corridas del banco, el caso "sin señal y `ultimo_preop_fecha` = hoy" exigió el preoperacional sin causa encontrada; no se volvió a reproducir. Si en el celular pide el preoperacional estando hecho, investigar `preoperacionalRequerido` (`src/viajes.js`).
- **Viajes EN_PROGRESO olvidados causan REVISAR**: si el conductor tiene otro viaje abierto en el servidor (PWA, prueba abandonada), los nuevos salen marcados "otro viaje en curso". Pasó con `DCA21390` y `62F053CD`. Cerrar o anular esos viajes antes de probar.
- **Remisión real vs. esperada**: en una prueba el viaje se registró con remisión `SHAHAH` en lugar de `PRUEBA-GPS-040`; buscar por conductor/placa, no solo por remisión.
- **Vehículo detenido**: no genera puntos (filtro de 30 m); la pantalla muestra "Detenido / sin movimiento" tras 1 min si el último punto venía a < 5 km/h, si no tras 3 min.
- **En segundo plano los puntos llegan por tandas** (≥60 s y ≥100 m): "Último punto" se atrasa hasta abrir la app.
- **Permisos nativos que exigen las librerías**: el banco de pruebas en Node simula la parte nativa y NO detecta faltantes del manifiesto (así pasó con `RECEIVE_BOOT_COMPLETED`). Toda funcionalidad nativa nueva se valida en el celular.
- **"EN LÍNEA" en Home** solo refleja la descarga de maestros; para saber si la cola sube, mirar "por enviar" y el diagnóstico del viaje.

---

## 6. Repositorio

`origin` = `https://github.com/Julianecheverria520/opticore-movil.git` (privado), rama `main` (antes `master`). Primer push el 2026-09-26.

## 7. Build `preview` (APK piloto v2)

Verificado con `npx expo config --type introspect` (sin `APP_VARIANT`): paquete `com.julianecheverria.opticoremovil`, versión **1.1.1** (versionCode lo lleva EAS: `appVersionSource: remote` + `autoIncrement`; el `preview` 1.1.0 code 2 de `e842310` no tiene las fallas previas, el siguiente sale con code 3),
permisos `RECEIVE_BOOT_COMPLETED`, `POST_NOTIFICATIONS`, `ACCESS_FINE/COARSE/BACKGROUND_LOCATION`, `FOREGROUND_SERVICE(_LOCATION)`, `CAMERA`; `RECORD_AUDIO` removido.
`expo-location`, `expo-task-manager`, `expo-image-manipulator` en dependencias. En release `__DEV__` es falso → `API_URL` = `https://opticore-ia.com`.

```
npx eas-cli build -p android --profile preview
```

Se instala **encima** del piloto v1 (mismo paquete y firma de EAS): conserva la base local y la migra.

