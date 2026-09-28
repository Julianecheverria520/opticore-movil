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

### App (opticore-movil, rama `combustible-revision`)
Nada todavía.

## 3. Pendientes (en orden)

1. **Julián**: correr `migraciones_sql/2026_10_combustible_revision.sql` en Supabase y confirmar las
   consultas de verificación del final del archivo. **Sin eso no se hace push del backend.**
2. Web: control de combustible (REVISAR, "Solo por revisar", detalle del tanqueo con corrección e historial,
   parámetros, aviso con monto excluido, marcados fuera de totales/rendimiento), capacidad del tanque en el
   maestro de equipos, PWA con advertencia y separadores, `sw.js` v9.
3. Push del backend + web → revisar que el log no diga `ESQUEMA: FALTAN`.
4. Configurar el precio manual de las empresas (hay pocos datos por empresa) y correr el script en simulación;
   los ids 21 y 22 deben aparecer. Marcar con `--aplicar --ids …` los aprobados.
5. Corregir 21 (valor $275.000) y 22 (16,702 gal) desde el detalle del tanqueo en la web.
6. Cargar `capacidad_tanque_gal` de los equipos.
7. App: separadores (`number-pad` en valor, `decimal-pad` + `parseDecimal` en galones, lectura ambigua con
   confirmación), vista previa "Se guardará", advertencia con rango de `/movil/maestros`
   (AsyncStorage), `advertencia_confirmada`. Solo JS; en los celulares del piloto necesita build `preview`
   (no hay EAS Update configurado).
