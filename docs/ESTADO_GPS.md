# Estado: viajes con GPS en la app (opticore-movil + AppTransporte)

Última actualización: 2026-09-25. AppTransporte: commits locales sin push. opticore-movil: ver §6 (remoto).
Leer este archivo al empezar cualquier sesión sobre viajes/GPS.

---

## 1. Qué está hecho

### Backend (AppTransporte) — desplegado en producción hasta al menos `49a6c0b`
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

Verificar en producción que `42424e7` y `29c91ee` estén desplegados.

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
| (este commit) | `docs/GUIA_CONDUCTOR.md`: guía corta para el conductor del piloto |

Base local del celular: SQLite `user_version` 7 (v5 GPS, v6 precisión, v7 `diag_envio`).

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
- **Bancos de prueba en Node** (SQLite real con `node:sqlite`, módulos reales de la app, servidor local): vivían en el scratchpad de la sesión (`banco/`), **no están versionados**. Si se necesitan otra vez, pedir recrearlos o moverlos a `scripts/banco/`.

---

## 3. Pendientes

1. ~~Development build nuevo~~ y ~~pruebas en carro~~: **hechos el 2026-09-25** (app abierta, pantalla bloqueada, modo avión, reinicio, finalizar: todo bien). `86102E53` ya está anulado.
2. **Prueba de noche de la foto**: anotar KB y segundos del diagnóstico.
3. **Build `preview` (piloto v2, 1.1.0)** — ver §7. Repetir con él "cerrada desde recientes" y "sin todo el tiempo".
4. **Notificaciones (Android 13+)**: el manifiesto no declara `POST_NOTIFICATIONS`; el servicio funciona, pero el aviso "Viaje en curso" puede no verse en la barra. Decidir si se pide el permiso.
6. **Paso 11 · pulido y recuperación**: conciliar viajes con `/movil/viajes/activo` (viaje abierto en el servidor que el celular no tiene), descartar/reintentar viajes con error permanente desde la app, pruebas de volumen de puntos, limpieza de fotos huérfanas.
7. **Paso 12 · piloto** con 1 volqueta en paralelo a la PWA, 2–3 días: comparar recorridos, batería y viajes perdidos.
8. **Usuarios inactivos**: `get_current_payload` no rechaza usuarios inactivos ni empresas suspendidas. Propuesta: cache `usr_ok:{user_id}` con `core/cache` (TTL ~60 s), invalidar al cambiar `activo` o suspender la empresa, 401 "Usuario inactivo".
9. **Anular viajes de prueba** en el Gestor de vales. Consulta de solo lectura del 2026-09-25 (DataPrueba, sin anular):
   ids #276–280, #282, #283, #285–289 (`PRUEBA-GPS-010/030/031/032`, FINALIZADOS, marcados REVISAR), `62A17B79` (#291, remisión `8288W8W8WUW`, FINALIZADO, REVISAR), #130 (`PRUEBA 134`, mayo). **Abierto**: #260 (conductor 79278242, RNS080, EN_PROGRESO desde 2026-09-21; confirmar si es prueba). `62F053CD` y `2E148DC3` ya están anulados.

---

## 4. Decisiones tomadas

- **Preoperacional del día**: con señal se consulta `/validar` en vivo; sin señal, `ultimo_preop_fecha` = hoy (Bogotá) o un preoperacional de hoy en el celular; si no se sabe, **se exige**.
- **Viaje offline que excede el plan / placa inactiva / otro viaje abierto / cantidad > capacidad + 2 / fecha > 7 días**: el servidor lo **acepta y lo marca** `requiere_revision` con `motivo_revision`. Placa que no existe en la empresa = 404 permanente.
- **Fechas**: `fecha_inicio`/`fecha_fin`/`timestamp` en texto `YYYY-MM-DD HH:MM:SS` hora Bogotá (igual que `operacion.py`); `ts` de cada punto = `location.timestamp`.
- **GPS**: `Accuracy.High`, 30 m, 15 s, deferred 60 s **y** 100 m (en Android el diferido solo aplica en segundo plano y exige ambas condiciones). Descarta precisión > 50 m y saltos > 150 km/h; guarda y cuenta ubicaciones simuladas.
- **Servicio en primer plano**: según la documentación de Android, iniciado con la app visible sigue recibiendo ubicación con pantalla apagada **sin** "todo el tiempo"; lo que no se puede es crearlo desde segundo plano (Android 14: `SecurityException`). Por eso se reanuda al abrir / volver al frente.
- **Cola del viaje**: inicio → foto de carga → puntos → foto de descarga → cierre. Las **fotos no bloquean**; el **cierre espera** a que no queden puntos. Toda falla queda en `diag_envio`.
- **Fotos**: ≤1600 px de ancho, JPEG 0.7, subida nativa multipart, límite 120 s.
- **Web**: `seguridad_html.js` (`escaparHTML`, `argJS`, `urlSegura`) para todo texto del servidor insertado con `innerHTML`.

---

## 5. Cosas a vigilar

- **Fallo intermitente de `ultimo_preop_fecha`**: en una de 5 corridas del banco, el caso "sin señal y `ultimo_preop_fecha` = hoy" exigió el preoperacional sin causa encontrada; no se volvió a reproducir. Si en el celular pide el preoperacional estando hecho, investigar `preoperacionalRequerido` (`src/viajes.js`).
- **Viajes EN_PROGRESO olvidados causan REVISAR**: si el conductor tiene otro viaje abierto en el servidor (PWA, prueba abandonada), los nuevos salen marcados "otro viaje en curso". Pasó con `DCA21390` y `62F053CD`. Cerrar o anular esos viajes antes de probar.
- **Remisión real vs. esperada**: en una prueba el viaje se registró con remisión `SHAHAH` en lugar de `PRUEBA-GPS-040`; buscar por conductor/placa, no solo por remisión.
- **Vehículo detenido**: no genera puntos (filtro de 30 m); la pantalla muestra "Detenido / sin movimiento" tras 3 min.
- **En segundo plano los puntos llegan por tandas** (≥60 s y ≥100 m): "Último punto" se atrasa hasta abrir la app.
- **Permisos nativos que exigen las librerías**: el banco de pruebas en Node simula la parte nativa y NO detecta faltantes del manifiesto (así pasó con `RECEIVE_BOOT_COMPLETED`). Toda funcionalidad nativa nueva se valida en el celular.
- **"EN LÍNEA" en Home** solo refleja la descarga de maestros; para saber si la cola sube, mirar "por enviar" y el diagnóstico del viaje.

---

## 6. Repositorio

`opticore-movil` no tenía remoto configurado al 2026-09-25 (`git remote -v` vacío). Ver la respuesta de esa sesión.

## 7. Build `preview` (APK piloto v2)

Verificado con `npx expo config --type introspect` (sin `APP_VARIANT`): paquete `com.julianecheverria.opticoremovil`, versión 1.1.0,
permisos `RECEIVE_BOOT_COMPLETED`, `ACCESS_FINE/COARSE/BACKGROUND_LOCATION`, `FOREGROUND_SERVICE(_LOCATION)`, `CAMERA`; `RECORD_AUDIO` removido.
`expo-location`, `expo-task-manager`, `expo-image-manipulator` en dependencias. En release `__DEV__` es falso → `API_URL` = `https://opticore-ia.com`.

```
npx eas-cli build -p android --profile preview
```

Se instala **encima** del piloto v1 (mismo paquete y firma de EAS): conserva la base local y la migra.

