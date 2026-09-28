# Estado: calidad de datos de tanqueos (opticore-movil + AppTransporte)

Última actualización: 2026-09-28. Rama `combustible-revision` en **ambos repos** (sin push, sin mezclar
con la fase GPS; el orden frente a la Fase B 1.2.0 se decide al hacer el build `preview`).
Leer este archivo al empezar cualquier sesión sobre combustible.

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

### Backend (AppTransporte, rama `combustible-revision`, **sin push**)
| Commit | Qué |
|---|---|
| `3ca4239` | Borra `api/maestros/combustible` (copia vieja sin extensión) |
| `967ce84` | `api/maestros/combustible_validacion.py` (reglas); `/guardar` marca y acepta `advertencia_confirmada`; `monitor-global` (`?solo_revision=1`), `historial`, `info-lectura` con marca, precio/galón y rango; `GET/PUT /config`, `GET /{id}`, `PUT /{id}` (log + revalida + recalcula `equipos.ultimo_*`), `POST /{id}/marcar-revisado`; `/movil/maestros` con `combustible`; `capacidad_tanque_gal` editable por API; `scripts/evaluar_tanqueos_existentes.py`; `migraciones_sql/2026_10_combustible_revision.sql`; `api/tests/test_combustible_validacion.py` (30 pruebas, SQLite en memoria) |
| `a66d78f` | **PWA `/app`**: `static/js/combustible_numeros.js` (galones coma/punto, pesos con miles, lectura ambigua `125.430` según la anterior; `node scripts/probar_combustible_numeros.js`); campos de texto con `inputmode` (antes `type=number`); "Se guardará: X" en cada campo y precio/galón con rango; ventana de confirmación (lectura ambigua: el operador elige; precio/capacidad: "¿Los datos son correctos?"); envía `advertencia_confirmada`; la lectura va solo a odómetro u horómetro (antes a los dos); `sw.js` v11 con GET de la API *network-first* (antes *cache-first*: lectura y rango quedaban viejos) |

| `a26879b` | **Panel web** (`/control-combustible`): pestaña "Por revisar" con contador; REVISAR y $/gal en la tabla del equipo; **detalle del tanqueo** (rango, motivo, corrección con observación obligatoria y confirmación, "Marcar como revisado", historial de cambios); **Parámetros** de validación; por revisar fuera de totales/KPIs/rendimiento con aviso de cantidad, **pesos** y galones excluidos; CSV con marca y motivo. Maestro de equipos: **capacidad del tanque (gal)**; historial de combustible con REVISAR y $/gal. `migraciones_sql/2026_10_combustible_revision_b.sql` |

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
`templates/app_combustible.html` no tiene ruta que lo sirva (plantilla muerta; no se tocó).

### App (opticore-movil, rama `combustible-revision`)
Nada todavía.

## 3. Pendientes (en orden)

**Mínimo para desplegar backend + web:**
1. **Julián**: correr `migraciones_sql/2026_10_combustible_revision_b.sql` y pegar sus 3 verificaciones
   (`motivo_revision` = text; 2 índices; regla de observación).
2. **Julián**: prueba local del panel y la PWA (lista en la respuesta del 2026-09-28).
3. Merge `combustible-revision` → `main` y push. Después: log sin `ESQUEMA: FALTAN`; `sw.js` = `opticore-v11`.
4. En el panel: Parámetros de cada empresa (empresa 1 casi sin datos: precio manual); corregir o marcar
   revisados 16, 19, 21, 22 y 27 (los 5 no tienen marca: corregirlos desde "Monitor de Tanques" → equipo →
   tanqueo, o por su id; no aparecen en "Por revisar" porque no se marcaron).

**Después:**
5. Cargar `capacidad_tanque_gal` de los equipos (hoy 0 de 22).
6. App nativa (con el build de la fase GPS): separadores (`number-pad` en valor, `decimal-pad` + `parseDecimal`
   en galones, lectura ambigua con confirmación), "Se guardará", advertencia con el rango de `/movil/maestros`
   (AsyncStorage), `advertencia_confirmada`. Solo JS; necesita build `preview` (no hay EAS Update).
