/**
 * Autogestión de fallas del preoperacional, sin señal.
 *
 * El servidor manda en /movil/maestros, por equipo, las fallas abiertas (preguntas en falla en
 * su último preoperacional) con "desde" (día en que empezó la racha). Se guardan en SQLite
 * (fallas_abiertas, v9). En el siguiente preoperacional el conductor dice por cada una
 * "YA SE ARREGLÓ" o "AÚN FALLA"; la respuesta viaja dentro del mismo preoperacional
 * (check_list true/false + texto en observaciones), que ya es idempotente por uuid_cliente.
 *
 * Al guardar un preoperacional en el celular se actualiza la tabla local, para que un segundo
 * preoperacional sin señal ya vea lo que respondió el primero. Mientras la placa tenga
 * preoperacionales sin enviar, la bajada de maestros no pisa esa tabla (sync.js).
 *
 * Los textos usan los formatos de la PWA para que web y app se entiendan:
 *   - FALLA [pregunta]: texto
 *   - Auditoría [pregunta]: ✅ SOLUCIONADO - Obs: texto  |  ❌ AÚN FALLA - Obs: texto
 */

export const RESUELTA = 'RESUELTA';
export const CONTINUA = 'CONTINUA';

const p2 = (n) => String(n).padStart(2, '0');

/** Día local del celular 'YYYY-MM-DD' (el celular está en hora de Bogotá). */
export function hoyLocal(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Días calendario desde 'YYYY-MM-DD' hasta hoy (0 si es hoy o si la fecha no sirve). */
export function diasDesde(desde, hoy = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(desde || ''));
  if (!m) return 0;
  const inicio = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const fin = Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  return Math.max(Math.round((fin - inicio) / 86400000), 0);
}

export function textoDias(falla, hoy = new Date()) {
  const n = diasDesde(falla?.desde, hoy);
  return `${n}${falla?.historial_limitado ? '+' : ''} ${n === 1 ? 'día' : 'días'}`;
}

/** Observaciones del reporte con el mismo formato que arma la PWA. */
export function armarObservaciones({ general = '', nuevas = [], seguimiento = [] }) {
  let txt = (general || '').trim();
  if (nuevas.length) {
    txt += '\n\n--- DETALLE DE FALLAS NUEVAS ---' +
      nuevas.map((n) => `\n- FALLA [${n.pregunta}]: ${n.obs}`).join('');
  }
  if (seguimiento.length) {
    txt += '\n\n--- AUDITORÍA DE FALLAS ANTERIORES ---' +
      seguimiento.map((s) => {
        const badge = s.resultado === RESUELTA ? '✅ SOLUCIONADO' : '❌ AÚN FALLA';
        return `\n- Auditoría [${s.pregunta}]: ${badge} - Obs: ${(s.obs || '').trim() || 'Sin observaciones'}`;
      }).join('');
  }
  return txt.trim();
}

/** Fallas abiertas guardadas para una placa: { [pregunta_id]: falla } */
export async function leerFallasAbiertas(db, placa) {
  const filas = await db.getAllAsync('SELECT * FROM fallas_abiertas WHERE placa = ?', placa);
  const r = {};
  for (const f of filas) r[f.pregunta_id] = { ...f, historial_limitado: f.historial_limitado === 1 };
  return r;
}

async function insertar(db, placa, f) {
  await db.runAsync(
    `INSERT OR REPLACE INTO fallas_abiertas
       (placa, pregunta_id, pregunta, categoria, es_critica, desde, historial_limitado, ultima_obs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    placa, Number(f.pregunta_id), f.pregunta || '', f.categoria || 'GENERAL',
    f.es_critica ? 1 : 0, f.desde || null, f.historial_limitado ? 1 : 0, f.ultima_obs || ''
  );
}

/**
 * Reemplaza las fallas de UNA placa con la lista del servidor (/movil/maestros o /validar).
 * Solo se llama si el servidor es nuevo (manda la lista) y la placa no tiene preoperacionales sin enviar.
 */
export async function reemplazarFallasPlaca(db, placa, lista) {
  await db.runAsync('DELETE FROM fallas_abiertas WHERE placa = ?', placa);
  for (const f of lista || []) {
    if (f && f.pregunta_id != null) await insertar(db, placa, f);
  }
}

/**
 * Bajada de maestros: equipos del servidor nuevo (traen fallas_abiertas). Las placas con
 * preoperacionales sin enviar conservan lo local; las que ya no vienen se borran.
 * Devuelve false (sin tocar nada) si el servidor es viejo.
 */
export async function guardarFallasDescargadas(db, equipos, placasConPendientes) {
  if (!equipos.length || !equipos.every((e) => Array.isArray(e.fallas_abiertas))) return false;
  const placas = [];
  for (const eq of equipos) {
    const placa = (eq.placa || '').trim().toUpperCase();
    if (!placa) continue;
    placas.push(placa);
    if (placasConPendientes.has(placa)) continue;
    await reemplazarFallasPlaca(db, placa, eq.fallas_abiertas);
  }
  const marcas = placas.map(() => '?').join(',');
  await db.runAsync(`DELETE FROM fallas_abiertas WHERE placa NOT IN (${marcas})`, ...placas);
  return true;
}

/**
 * Tras guardar un preoperacional en el celular:
 *  - "YA SE ARREGLÓ" → se borra;  "AÚN FALLA" → se conserva "desde" y se actualiza la observación;
 *  - falla nueva → se inserta con desde = hoy.
 * seguimiento: [{pregunta_id, resultado, obs}]; nuevas: [{pregunta_id, pregunta, categoria, es_critica, obs}]
 */
export async function actualizarFallasLocales(db, placa, { seguimiento = [], nuevas = [] }, hoy = new Date()) {
  for (const s of seguimiento) {
    if (s.resultado === RESUELTA) {
      await db.runAsync('DELETE FROM fallas_abiertas WHERE placa = ? AND pregunta_id = ?', placa, Number(s.pregunta_id));
    } else {
      await db.runAsync('UPDATE fallas_abiertas SET ultima_obs = ? WHERE placa = ? AND pregunta_id = ?',
        (s.obs || '').trim(), placa, Number(s.pregunta_id));
    }
  }
  for (const n of nuevas) {
    await insertar(db, placa, { ...n, desde: hoyLocal(hoy), historial_limitado: false, ultima_obs: n.obs });
  }
}
