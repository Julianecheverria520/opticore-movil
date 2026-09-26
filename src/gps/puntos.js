// src/gps/puntos.js · captura de puntos GPS en SQLite (sin React: lo usa la tarea en segundo plano)
import { getDb } from '../database/db';
import { distanciaKm } from '../viajes';

export const PRECISION_MAXIMA_M = 50;     // peor que esto se descarta
export const VELOCIDAD_MAXIMA_KMH = 150;  // un salto más rápido que esto es un error del GPS
export const LOTE_PUNTOS = 200;

function isoLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const s = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/**
 * Guarda las ubicaciones que entrega expo-location para el viaje EN_CURSO.
 * - Precisión peor que 50 m -> descartada.
 * - Salto a más de 150 km/h respecto al último punto guardado -> descartado.
 * - Ubicación simulada (mocked) -> se guarda, marcada, y se cuenta para avisar.
 * seq se asigna dentro del INSERT (MAX + 1), así dos ejecuciones simultáneas de la
 * tarea nunca repiten número (y el índice UNIQUE lo garantiza).
 * Devuelve { guardados, descartados, simulados, viaje } (viaje = null si no hay viaje en curso).
 */
export async function guardarUbicaciones(locations = []) {
  const db = await getDb();
  const viaje = await db.getFirstAsync(`SELECT * FROM viajes_locales WHERE estado_local = 'EN_CURSO' ORDER BY id DESC LIMIT 1`);
  const res = { guardados: 0, descartados: 0, simulados: 0, viaje };
  if (!viaje) return res;

  // Orden cronológico: el sistema puede entregar varios puntos juntos (deferred updates)
  const lista = [...locations].filter((l) => l && l.coords).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let ultimo = await db.getFirstAsync(
    'SELECT latitud, longitud, ts_iso FROM puntos_gps WHERE viaje_uuid = ? ORDER BY seq DESC LIMIT 1', viaje.uuid
  );
  let ultimoMs = ultimo ? Date.parse(ultimo.ts_iso) : null;

  for (const loc of lista) {
    const { latitude: lat, longitude: lon, accuracy, speed } = loc.coords;
    const ts = Number(loc.timestamp) || Date.now();
    if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) { res.descartados++; continue; }
    if (accuracy == null || accuracy > PRECISION_MAXIMA_M) { res.descartados++; continue; }

    if (ultimo && ultimoMs) {
      const horas = (ts - ultimoMs) / 3600000;
      if (horas <= 0) { res.descartados++; continue; } // repetido o fuera de orden
      const kmh = distanciaKm(ultimo.latitud, ultimo.longitud, lat, lon) / horas;
      if (kmh > VELOCIDAD_MAXIMA_KMH) { res.descartados++; continue; }
    }

    const simulado = loc.mocked === true || loc.coords.mocked === true ? 1 : 0;
    await db.runAsync(
      `INSERT INTO puntos_gps (viaje_uuid, seq, latitud, longitud, precision, velocidad, ts_iso, enviado, simulado)
       SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, 0, ? FROM puntos_gps WHERE viaje_uuid = ?`,
      viaje.uuid, lat, lon, accuracy, speed != null && speed >= 0 ? speed : null, isoLocal(ts), simulado, viaje.uuid
    );
    res.guardados++;
    res.simulados += simulado;
    ultimo = { latitud: lat, longitud: lon };
    ultimoMs = ts;
  }

  // Precisión de la lectura más reciente recibida, aunque se haya descartado
  const masReciente = lista.length ? lista[lista.length - 1].coords.accuracy : null;
  await db.runAsync(
    `UPDATE viajes_locales SET gps_descartados = COALESCE(gps_descartados, 0) + ?, gps_simulados = COALESCE(gps_simulados, 0) + ?,
       gps_ultimo_evento = ?, gps_ultima_precision = COALESCE(?, gps_ultima_precision) WHERE uuid = ?`,
    res.descartados, res.simulados, isoLocal(Date.now()), masReciente ?? null, viaje.uuid
  );
  return res;
}

/** Estadísticas del recorrido para la pantalla "Viaje en curso". */
export async function estadisticasRecorrido(uuid) {
  const db = await getDb();
  const c = await db.getFirstAsync(
    `SELECT COUNT(*) AS capturados,
            SUM(CASE WHEN enviado = 1 THEN 1 ELSE 0 END) AS enviados,
            SUM(CASE WHEN enviado = 0 THEN 1 ELSE 0 END) AS pendientes,
            SUM(CASE WHEN enviado = -1 THEN 1 ELSE 0 END) AS rechazados
       FROM puntos_gps WHERE viaje_uuid = ?`, uuid
  );
  const ultimo = await db.getFirstAsync(
    'SELECT ts_iso, precision FROM puntos_gps WHERE viaje_uuid = ? ORDER BY seq DESC LIMIT 1', uuid
  );
  // Distancia aproximada: suma de tramos entre puntos consecutivos
  const coords = await db.getAllAsync('SELECT latitud, longitud FROM puntos_gps WHERE viaje_uuid = ? ORDER BY seq', uuid);
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    km += distanciaKm(coords[i - 1].latitud, coords[i - 1].longitud, coords[i].latitud, coords[i].longitud);
  }
  return {
    capturados: c?.capturados || 0,
    enviados: c?.enviados || 0,
    pendientes: c?.pendientes || 0,
    rechazados: c?.rechazados || 0,
    ultimoTs: ultimo?.ts_iso || null,
    ultimaPrecision: ultimo?.precision ?? null,
    distanciaKm: km,
  };
}

/** Próximo lote de puntos pendientes del viaje, ordenado por seq. */
export async function lotePendiente(uuid, limite = LOTE_PUNTOS) {
  const db = await getDb();
  return db.getAllAsync(
    'SELECT id, seq, latitud, longitud, precision, velocidad, ts_iso FROM puntos_gps WHERE viaje_uuid = ? AND enviado = 0 ORDER BY seq LIMIT ?',
    uuid, limite
  );
}
