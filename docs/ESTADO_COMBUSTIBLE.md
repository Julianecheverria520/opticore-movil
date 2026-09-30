# Estado: calidad de datos de tanqueos (opticore-movil + AppTransporte)

Última actualización: 2026-09-28. **Backend + web + PWA en producción**: AppTransporte `main` = `origin/main` =
`f53be8a` (fast-forward desde `b45f632`, push el 2026-09-28). Verificado sin credenciales el 2026-09-28:
`sw.js` = `opticore-v11`, `revision.js` y `combustible_numeros.js` = 200, `/referencia`, `/config`, `/{id}/anular`
y `/{id}/marcar-revisado` = 401 (existen). opticore-movil: rama `combustible-revision` (solo docs); la app va
con el build de la fase GPS.
Leer este archivo al empezar cualquier sesión sobre combustible.

**App 1.3.0 (2026-09-30)**: validaciones, foto del tiquete y tanqueo durante el viaje en la rama
`combustible-revision` de opticore-movil (commits locales, sin push; ver §5). Backend: regla "lectura menor
que la anterior" (`1b38684`, sin SQL) **en `origin/main` desde el 2026-09-30** (push de `combustible-lectura:main`,
fast-forward desde `b331750`, sin cambiar de rama en AppTransporte).

**Foto del tiquete (2026-09-28): en producción (`b331750`)**. Verificado sin credenciales el 2026-09-28: `sw.js` = `opticore-v12`, `foto_tiquete.js` = 200, `app_combustible_logic.js` v5, `POST /movil/combustible/{uuid}/foto` y `POST /maestros/combustible/{id}/foto` = 401 (existen). Ver §4.

---

## 0. Origen

Dos tanqueos mal digitados que nada detectó (consulta de solo lectura de Julián, 2026-09-28):

| id | Placa (equipo_id) | Galones | Valor | Precio/galón | Canal | Correcto |
|---|---|---|---|---|---|---|
| 21 | 48 | 25,5 | $27.500.000 | $1.078.431 | PWA (`App Móvil Integrada`, sin `uuid_cliente`) | valor $275.000 (recibo) |
| 22 | 28 | 16702 | $188.148 | $11 | PWA (`App Móvil Integrada`, sin `uuid_cliente`) | 16,702 galones |

Según la misma consulta: 21 tanqueos en total, todos `DIESEL`; **ningún equipo tiene `capacidad_tanque_gal`**
(empresa 1: 0 de 6; empresa 5: 0 de 16).

## 1. Decisiones (aprobadas por Julián el 2026-09-28)

- **Precio de referencia**: mediana del precio/galón de la misma empresa y el mismo `tipo_combustible` en los
  30 días **anteriores a la fecha del tanqueo**, sin los marcados ni el propio registro. Con < 5 datos: precio
  manual de la empresa; sin precio manual no se valida el precio (la capacidad sí).
- **Tolerancia**: ±10 % por defecto (también se puede en pesos). Parámetros en
  `empresas_clientes.config_combustible` (JSON): `precio_referencia_manual`, `tolerancia_tipo`,
  `tolerancia_valor`, `dias_ventana`, `min_muestras`, `margen_tanque_pct` (5 %).
- **Capacidad**: galones > capacidad + 5 % → revisar. Sin capacidad cargada no aplica.
- **No se bloquea**: se guarda con `requiere_revision = true` y `motivo_revision` (TEXT) legible. El servidor
  siempre vuelve a validar.
- **Por revisar** fuera de totales, KPIs y rendimiento; el aviso de "Calidad de datos" muestra cantidad **y
  monto en pesos** excluido.
- **Corrección** solo `admin` / `super_admin`, observación obligatoria, una fila por campo en
  `registros_combustible_cambios` (no se edita ni se borra: trigger). Los ids 21 y 22 se corrigen con esa
  función, no con SQL.
- **Script único** para los registros existentes: simulación primero; marca solo los ids aprobados.
- **Lectura ambigua** (odómetro/horómetro, p. ej. `125.430`): la app elige la interpretación, muestra
  "Se guardará: X" y pide confirmación cuando las dos son posibles.

## 2. Hecho

### Backend + web + PWA (AppTransporte, en `main` y en producción desde el 2026-09-28)
| Commit | Qué |
|---|---|
| `3ca4239` | Borra `api/maestros/combustible` (copia vieja sin extensión) |
| `967ce84` | `api/maestros/combustible_validacion.py` (reglas); `/guardar` marca y acepta `advertencia_confirmada`; `monitor-global` (`?solo_revision=1`), `historial`, `info-lectura` con marca, precio/galón y rango; `GET/PUT /config`, `GET /{id}`, `PUT /{id}` (log + revalida + recalcula `equipos.ultimo_*`), `POST /{id}/marcar-revisado`; `/movil/maestros` con `combustible`; `capacidad_tanque_gal` editable por API; `scripts/evaluar_tanqueos_existentes.py`; `migraciones_sql/2026_10_combustible_revision.sql`; `api/tests/test_combustible_validacion.py` (30 pruebas, SQLite en memoria) |
| `a66d78f` | **PWA `/app`**: `static/js/combustible_numeros.js` (galones coma/punto, pesos con miles, lectura ambigua `125.430` según la anterior; `node scripts/probar_combustible_numeros.js`); campos de texto con `inputmode` (antes `type=number`); "Se guardará: X" en cada campo y precio/galón con rango; ventana de confirmación (lectura ambigua: el operador elige; precio/capacidad: "¿Los datos son correctos?"); envía `advertencia_confirmada`; la lectura va solo a odómetro u horómetro (antes a los dos); `sw.js` v11 con GET de la API *network-first* (antes *cache-first*: lectura y rango quedaban viejos) |

| `a26879b` | **Panel web** (`/control-combustible`): pestaña "Por revisar" con contador; REVISAR y $/gal en la tabla del equipo; **detalle del tanqueo** (rango, motivo, corrección con observación obligatoria y confirmación, "Marcar como revisado", historial de cambios); **Parámetros** de validación; por revisar fuera de totales/KPIs/rendimiento con aviso de cantidad, **pesos** y galones excluidos; CSV con marca y motivo. Maestro de equipos: **capacidad del tanque (gal)**; historial de combustible con REVISAR y $/gal. `migraciones_sql/2026_10_combustible_revision_b.sql` |

| `f53be8a` | **Anular** (`POST /{id}/anular`, admin, observación obligatoria, log; no borra; quita REVISAR; recalcula `equipos.ultimo_*` si tenía la lectura más alta; PUT de un anulado = 422). Anulados fuera de totales, KPIs, rendimiento, mediana, duplicados y "Por revisar"; visibles como ANULADO. **Posible duplicado**: otro tanqueo no anulado del mismo equipo el mismo día de Colombia → REVISAR "Posible duplicado de #N (mismo equipo, mismo día, X gal[, misma lectura: muy probable duplicado])"; al corregir solo se revisa si cambió la fecha; el script compara con los anteriores. `info-lectura.tanqueos_hoy`; `/movil/maestros` → `ultimo_tanqueo` por equipo. PWA: "¿Es un tanqueo nuevo?". Fechas de tanqueo guardadas en UTC. SQL: `2026_10_combustible_anulacion.sql`. 43 pruebas |

`origin/main` = `b45f632` (verificado con git el 2026-09-28): desplegar la rama es un *fast-forward* de estos 4 commits.

**SQL (verificación pegada por Julián el 2026-09-28):** (a) 5 columnas, pero `motivo_revision` =
`character varying` (se esperaba TEXT; la columna ya existía, probablemente de la versión del plan con
VARCHAR(255)) → corregir con `2026_10_combustible_revision_b.sql` **antes del despliegue**; (b) 11 columnas de
`registros_combustible_cambios`; (c) trigger UPDATE y DELETE; (d) 0 marcados.

**Simulación del script (Julián, 2026-09-28, `--precio-manual 11200`):** 21 tanqueos, 5 fuera de rango, todos
empresa 5 y con mediana (9–15 tanqueos; el precio manual no se usó): 16 (SCO-001, $10 por 12,5 gal),
19 (SGE-001, $15.000/gal, puede ser real), 21, 22 y **27 (ALQ-005, 2026-09-28, $110 por 9,783 gal)**.
Los errores siguen entrando por la PWA mientras no se despliegue `a66d78f`. Decisión de Julián: **no aplicar
marcas con el script**; los 5 se corrigen o marcan como revisados desde el panel.
**SQL `_b` (Julián, 2026-09-28):** `motivo_revision` = text, 2 índices, regla de observación: OK.
**SQL de anulación (Julián, 2026-09-28):** 4 columnas y 0 anulados: OK.
**Según Julián (2026-09-28, no verificado desde aquí):** marcó con el script 16, 19 y 27; corrigió 21 y 22 desde
el panel; anuló 19 (duplicado mal digitado de 20; el 20 es el correcto); 16 y 27 quedan en "Por revisar" hasta
tener los recibos. Las pruebas locales llegaron sin detallar (el mensaje traía el marcador sin llenar).
`templates/app_combustible.html` no tiene ruta que lo sirva (plantilla muerta; no se tocó).

### App (opticore-movil, rama `combustible-revision`)
Ver §5.

## 4. Foto del tiquete (AppTransporte rama `combustible-foto`, desde `f53be8a`)

Objetivo: el administrador ve la foto del tiquete junto al tanqueo y revisa o corrige sin pedirle el
recibo al operador. Plan aprobado por Julián el 2026-09-28 con estos ajustes: por defecto **OPCIONAL**; el
operador no reemplaza una foto ya subida (solo el admin, con log); la lectura del tiquete con IA queda para
después (§4.4).

### 4.1 Decisiones
- **Bucket PRIVADO `tiquetes-combustible`** (Supabase Storage), 3 MB por archivo, solo JPG/PNG/WEBP, **sin
  políticas** en `storage.objects`: solo entra el backend con la clave `service_role`
  (`SUPABASE_SERVICE_ROLE_KEY`, variable nueva; `SUPABASE_KEY` sigue para los buckets públicos). Nada en
  `/uploads`.
- En la base solo la **ruta**: `{empresa}/{AAAA}/{MM}/{uuid}.{ext}` (año y mes del tanqueo, hora de Colombia).
  Operador: `uuid` = `uuid_cliente` del tanqueo (ruta fija + upsert: un reintento reemplaza el mismo archivo).
  Admin: `uuid` nuevo; la foto anterior **no se borra** (el log guarda las dos rutas).
- La web ve la foto con **URL firmada de 5 min** (solo en el detalle; las listas traen `tiene_foto`).
- **La foto no bloquea**: el tanqueo se guarda y la foto sube después. La PWA la comprime en el navegador
  (≤1600 px, JPEG 0,7→0,5, ~350 KB).
- `config_combustible.foto_tiquete`: `OPCIONAL` (por defecto) | `RECOMENDADA` (la PWA pide confirmar sin
  foto) | `OBLIGATORIA` (`/guardar` sin `con_foto: true` → REVISAR "Sin foto del tiquete", sumado a los otros
  motivos). Cuando llega la foto se quita solo ese motivo; si no quedan otros, se quita la marca (log con
  "Llegó la foto del tiquete"). La corrección y el detalle conservan el motivo mientras siga sin foto.
- Un tanqueo **anulado** también recibe y conserva su foto.
- `/guardar` ya era **idempotente por `uuid_cliente`** (búsqueda + índice único); ahora la PWA lo manda (uno por
  formulario abierto): tocar Guardar dos veces o reintentar tras un error de red no duplica.
- `foto_recibo_url` (columna vieja, sin uso en el código) no se toca; se consulta si tiene datos (SQL (c)).

### 4.2 Hecho (commits locales, sin push)
| Commit | Qué |
|---|---|
| `84e60d3` | **Backend + SQL**: `core/tiquetes_storage.py`, `api/maestros/combustible_foto.py`; `POST /movil/combustible/{uuid_cliente}/foto` (operador: misma empresa y mismo usuario que registró; `ya_tiene_foto` si el admin ya puso otra; 413/415/400; 503 sin clave; 502 si Storage falla); `POST /maestros/combustible/{id}/foto` (admin, `multipart` con `observacion`, log `foto_tiquete`); `con_foto` en `/guardar`; `foto_tiquete` en `/config`, `info-lectura` y `/movil/maestros`; `tiene_foto` en `monitor-global` e `historial`; `foto` (URL firmada) en `GET /{id}`. `migraciones_sql/2026_10_combustible_foto.sql`. `api/tests/test_combustible_foto.py` (23 pruebas, SQLite + Storage falso) |
| `8dc355f` | **Web + PWA**: `static/js/foto_tiquete.js` (compresión + cola IndexedDB `OptiCoreFotos`: 3 intentos a 2/5/15 s, luego al abrir la app y al volver la señal, 7 días). Panel: miniatura en el detalle, visor (zoom, girar, abrir), "Adjuntar/Reemplazar foto" con la observación del detalle, 📷 en Por revisar y en la tabla del equipo (y en el maestro de equipos), Parámetros → Foto del tiquete. PWA: "Tomar foto del tiquete" (cámara trasera), vista previa, Cambiar/Quitar, confirmación según la empresa, `uuid_cliente` + `con_foto`. `sw.js` `opticore-v12` |

Pruebas: `test_combustible_foto.py` 23 y `test_combustible_validacion.py` 43, todas OK (2026-09-28).
**Incidente menor (2026-09-28)**: al comprobar las rutas se importó `main.py` sin `INIT_DB=false`: corrió
`create_all` (sin tablas nuevas: no creó nada), `crear_iniciales` (se cortó antes de sembrar) y la
verificación de esquema contra producción, que reportó `FALTAN 3 COLUMNA(S)` (`foto_tiquete_*`, lo esperado
antes del SQL). Sin escrituras.

### 4.3 Para desplegar (en orden)
1. ~~SQL~~: la primera versión no dejó las columnas y el bucket (ya existía) quedó sin límites; Julián lo corrigió a mano y el archivo se reescribió (`b331750`: dos bloques, `ON CONFLICT DO UPDATE`). **Verificación pegada por Julián el 2026-09-28**: (a) 3 columnas OK; (b) `public=false`, 3145728, jpeg/png/webp; (c) 22 tanqueos, `foto_recibo_url` con 0 datos (se deja sin tocar); (d) 0 políticas; (e) `ix_registros_combustible_uuid_cliente` UNIQUE; (f) 2 con foto, solo empresa 1.
2. ~~`SUPABASE_SERVICE_ROLE_KEY`~~: en Render y en el `.env` local, según Julián (sin ella, 503).
3. ~~Prueba local~~ con DataPrueba: **todo OK según Julián (2026-09-28)**: la foto pendiente subió sola al reabrir la PWA; adjuntar desde la web, visor, Recomendada, Obligatoria (el motivo se quita al adjuntar), URL vencida a los 5 min; limpieza hecha (Parámetros en Opcional, tanqueos de prueba anulados).
4. ~~Push~~: `main` = `origin/main` = `b331750` (fast-forward desde `f53be8a`, 2026-09-28). **Julián**: revisar en el log de Render que no aparezca `ESQUEMA: FALTAN`.
5. **Julián**: Parámetros de la empresa 5 → Foto del tiquete = Recomendada; adjuntar las fotos de 16, 19, 21,
   22 y 27 desde el panel.

### 4.4 Después (no ahora)
- ~~App nativa~~: hecho en la app 1.3.0 (§5).
- **Leer el tiquete con IA**: al llegar la foto, un modelo de visión extrae galones, valor, precio/galón,
  fecha, estación y placa → `ia_tiquete` (JSON con confianza). Nunca corrige solo: si difiere (galones ±2 %,
  valor ±1 %) marca REVISAR "El tiquete dice …" y el detalle muestra digitado vs. leído con "Aplicar valores
  del tiquete" (pasa por la corrección con log). Falta decidir proveedor y si va por empresa.

## 3. Pendientes (en orden)

1. **Julián**: revisar el log del arranque en Render: que **no** aparezca `ESQUEMA: FALTAN`.
2. **Julián**: en producción, Parámetros de cada empresa (empresa 1 casi sin datos: precio manual) y resolver 16 y 27
   con los recibos.
3. Cargar `capacidad_tanque_gal` (hoy 0 de 22 equipos).
4. ~~App nativa~~: hecha (§5). Falta la ronda de pruebas en el celular, el despliegue de `1b38684` y el build
   `preview` 1.3.0 (§5.4).
5. Vigilar: todo segundo tanqueo del mismo equipo en el día queda por revisar. Si molesta, limitar a "misma lectura"
   o a una ventana de horas.
6. No hay "desanular" en pantalla (a propósito); si hiciera falta, se agrega con su log.
7. **Foto del tiquete**: ver §4.3.

## 5. App nativa 1.3.0 (opticore-movil, rama `combustible-revision`)

Plan aprobado por Julián el 2026-09-30. Solo JS (sin módulos nativos nuevos): sirve el development build actual
("OptiCore DEV"). Commits locales, sin push.

### 5.1 Hecho
| Commit | Qué |
|---|---|
| `cbfd660` | `src/combustibleNumeros.js`: copia de `combustible_numeros.js` (PWA), 1253 comparaciones iguales |
| `0fc65e5` | favicon web con el logo nuevo (aparte; no es de combustible) |
| `c5838d8` | **SQLite v11** (solo agrega columnas): `tanqueos_pendientes` → `advertencia_confirmada`, `foto_uri`, `foto_estado` (`sin_foto`/`pending`/`synced`/`error`/`descartada`), `intentos_foto`, `diag_foto`, `requiere_revision`, `motivo_revision`, `viaje_uuid` (solo local); `equipos` → `ultimo_tanqueo_fecha`, `ultimo_tanqueo_galones`. Clave `combustible` de maestros en AsyncStorage (`leerConfigCombustible`) |
| `711ac51` | Banco de pruebas en Node versionado (`scripts/banco/`) |
| `1693291` | **Pantalla**: `decimal-pad` en galones y lectura, `number-pad` en valor; "Se guardará" en cada campo; precio/galón en vivo con rango (verde/ámbar); confirmaciones en el orden y con los textos de la PWA. `src/combustible.js`: rango DIESEL, margen, modo de foto y "tanqueo de hoy" (ultimo_tanqueo de hoy en Bogotá + tanqueos del celular, sin repetir). **No usa `info-lectura`**: el token móvil no entra ahí (`auth.RUTAS_MOVIL`); todo sale de maestros |
| `3bd24fd` | Lectura menor que la anterior: ya no bloquea; "La lectura (X) es menor que la anterior (Y). ¿Es correcta?" → `advertencia_confirmada`. El contador local solo sube (antes bajaba) |
| `2765aec` | **Cola**: un tanqueo sin respuesta o con 5xx detiene solo su cola (los puntos del viaje siguen; 401 detiene todo). **Foto del tiquete** (`src/tiquetes.js`): `tiquetes/{uuid}.jpg`, etapa aparte al final con candado propio, solo con el tanqueo enviado; SIN RESPUESTA → pausa 5 min; rechazo (salvo 408/429) o 5 fallas → error; `ya_tiene_foto` = enviada. Pantalla: tomar/cambiar/quitar, "¿Guardar sin foto del tiquete?" / "Falta la foto del tiquete". Home: tarjeta "Fotos de tiquetes" (Enviar ahora / Reintentar). Limpieza de huérfanas |
| `c4b4dbe` | Foto con error: se conserva (tanqueo y archivo) hasta Reintentar o **Descartar** (con confirmación) en Home |
| `546951b` | **Resultado**: espera hasta ~8 s ("Enviando…"); tarjeta ámbar "Quedó marcado para revisión" con el motivo, verde "Guardado y enviado", azul "Se enviará cuando haya señal", roja si el servidor lo rechaza |
| `5d24864` | **Tanqueo durante el viaje**: botón "Registrar tanqueo" en el panel de Viaje en curso (push, el viaje sigue montado, no toca el GPS); coordenadas del último punto del viaje (≤ 10 min) o la ubicación actual; "Detén el vehículo antes de registrar el tanqueo" (> 10 km/h, no bloquea); Atrás del viaje solo con el viaje enfocado. **Borrador** por placa (12 h): si la app se cierra, "Tienes un tanqueo sin guardar de las HH:MM. ¿Continuar?" con el mismo uuid; recupera la foto si Android cerró la app con la cámara abierta; salir con datos pide "¿Descartar lo digitado?" |
| (este commit) | Documentación y versión **1.3.0** |

Pruebas en Node (sin celular ni servidor): `probar_sqlite_v11` 23, `probar_combustible` 23, `probar_cola_fotos` 49,
`probar_viaje_tanqueo` 22, `probar_combustible_numeros` (1253 comparaciones con la PWA). El paquete Android compila
(`npx expo export --platform android`). **No se ha probado en el celular.**

    node --import ./scripts/banco/registro.mjs scripts/banco/<prueba>.mjs

### 5.2 Backend: lectura menor que la anterior (AppTransporte `1b38684`, en `origin/main` desde el 2026-09-30)
`evaluar_registro` → `motivos_lectura`: REVISAR "Lectura menor que la anterior (125.430 Km, preoperacional del
28 sep)" o "(…, tanqueo #N del 27 sep)". La anterior = la **más reciente** antes de la fecha del tanqueo entre
tanqueos no anulados y preoperacionales (decisión de Julián, 2026-09-30: incluir preoperacionales). La más reciente
y no la mayor: tras un cambio de odómetro solo se marca el primero. No usa `equipos.ultimo_*` (un tanqueo sin señal
que llega tarde no se marca). No baja `ultimo_*`. Aplica en `/guardar`, la corrección y el script. Sin SQL.
`test_combustible_validacion.py`: 53 OK (10 nuevas); `test_combustible_foto.py`: 23 OK (2026-09-30, SQLite en memoria).

### 5.3 Decisiones
- La foto del tiquete **no bloquea** ni frena los puntos del viaje; el tanqueo nunca espera a la foto.
- Foto con error: no se borra a los 14 días; solo Reintentar (éxito) o Descartar a mano.
- Borrador: uno por placa, vigente 12 h; la limpieza de `tiquetes/` respeta sus fotos.
- Vincular el tanqueo al viaje en el servidor (`viaje_uuid_cliente` en `registros_combustible`): **después**. La app
  ya guarda `viaje_uuid` en el celular, pero no lo envía.

### 5.4 Para desplegar (en orden)
1. **Julián**: ronda única de pruebas en el celular (GPS + Fase B + combustible + tanqueo durante el viaje).
2. ~~Push de `combustible-lectura`~~: hecho el 2026-09-30 (`b331750..1b38684`). Julián saltó la prueba local (bloque A);
   la regla se verifica en producción en el paso G. **Julián**: revisar en el log de Render que no aparezca `ESQUEMA: FALTAN`.
3. Push de `combustible-revision` de opticore-movil y build `preview` 1.3.0
   (`npx eas-cli build -p android --profile preview`), instalado encima del piloto.
