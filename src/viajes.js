// src/viajes.js · lógica de viajes sin interfaz (se puede probar fuera del celular)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Directory, Paths } from 'expo-file-system';

import { getDb, nuevoUUID, ahoraISO } from './database/db';
import { fetchConTimeout } from './red';

export const RADIO_CERCANOS_KM = 5;
export const GABELA_CANTIDAD = 2; // igual que la PWA y el servidor: capacidad nominal + 2

/** "YYYY-MM-DD" de hoy en Bogotá (UTC-5 fijo, sin horario de verano), sin depender de Intl. */
export function hoyBogota(ahora = new Date()) {
  return new Date(ahora.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Distancia en km entre dos coordenadas (Haversine). Infinity si falta alguna. */
export function distanciaKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v === null || v === undefined || Number.isNaN(Number(v)))) return Infinity;
  const R = 6371;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Orígenes únicos de las rutas, con los que están a menos de 5 km primero (más cercano arriba).
 * `pos` puede ser null (sin GPS): entonces todos van en "otros", en orden alfabético.
 */
export function ordenarOrigenes(rutas, pos) {
  const porNombre = new Map();
  for (const r of rutas) {
    if (!r.origen || porNombre.has(r.origen)) continue;
    const d = pos ? distanciaKm(pos.lat, pos.lon, r.origen_lat, r.origen_lon) : Infinity;
    porNombre.set(r.origen, { nombre: r.origen, distanciaKm: d });
  }
  const todos = [...porNombre.values()];
  const cercanos = todos.filter((o) => o.distanciaKm <= RADIO_CERCANOS_KM).sort((a, b) => a.distanciaKm - b.distanciaKm);
  const otros = todos.filter((o) => o.distanciaKm > RADIO_CERCANOS_KM).sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { cercanos, otros };
}

/** Capacidad nominal del equipo: m3 si la tiene, si no toneladas. */
export function capacidadEquipo(eq) {
  const m3 = Number(eq?.capacidad_m3) || 0;
  const ton = Number(eq?.capacidad_ton) || 0;
  if (m3 > 0) return { capacidad: m3, unidad: 'm³' };
  if (ton > 0) return { capacidad: ton, unidad: 'Ton' };
  return { capacidad: 0, unidad: '' };
}

/**
 * Valida la cantidad contra la capacidad: 'bloquear' por encima de capacidad + 2,
 * 'advertir' por encima de la capacidad, 'ok' en otro caso (o si no hay capacidad).
 */
export function validarCantidad(cantidad, eq) {
  const { capacidad } = capacidadEquipo(eq);
  if (!(capacidad > 0) || !(cantidad > 0)) return { nivel: 'ok', capacidad, maximo: capacidad + GABELA_CANTIDAD };
  if (cantidad > capacidad + GABELA_CANTIDAD) return { nivel: 'bloquear', capacidad, maximo: capacidad + GABELA_CANTIDAD };
  if (cantidad > capacidad) return { nivel: 'advertir', capacidad, maximo: capacidad + GABELA_CANTIDAD };
  return { nivel: 'ok', capacidad, maximo: capacidad + GABELA_CANTIDAD };
}

/** ¿Este celular guardó un preoperacional de la placa hoy? (enviado o pendiente) */
async function preopLocalHoy(db, placa) {
  const r = await db.getFirstAsync(
    `SELECT COUNT(*) AS n FROM reportes_pendientes
      WHERE equipo_id = ? AND date(fecha) = date('now', 'localtime')`,
    placa
  );
  return (r?.n || 0) > 0;
}

/**
 * Decisión 1 · ¿Hace falta el preoperacional de hoy antes de iniciar el viaje?
 * - La empresa no lo usa -> no.
 * - Un preoperacional guardado HOY en este celular (enviado o no) -> ya está.
 * - Con señal: se pregunta en vivo a /validar (completado_hoy del servidor).
 * - Sin señal: ultimo_preop_fecha de los maestros == hoy -> ya está.
 * - Si no se puede saber -> se exige (opción a).
 * Devuelve { requerido, fuente, motivo }.
 */
export async function preoperacionalRequerido(placa, { token, apiUrl, timeoutMs = 5000 } = {}) {
  if ((await AsyncStorage.getItem('usaPreoperacional')) === '0') {
    return { requerido: false, fuente: 'empresa', motivo: 'La empresa no exige preoperacional.' };
  }
  const db = await getDb();
  if (await preopLocalHoy(db, placa)) {
    return { requerido: false, fuente: 'local', motivo: 'Preoperacional de hoy guardado en este celular.' };
  }

  if (token && apiUrl) {
    try {
      const res = await fetchConTimeout(
        `${apiUrl}/maestros/equipos/preoperacional/validar/${encodeURIComponent(placa)}`,
        { headers: { Authorization: `Bearer ${token}` } },
        timeoutMs
      );
      if (res.ok) {
        const d = await res.json();
        if (d.exige_preoperacional === false) {
          return { requerido: false, fuente: 'servidor', motivo: 'La empresa no exige preoperacional.' };
        }
        if (d.completado_hoy) {
          // Se anota para que, sin señal, el celular también lo sepa el resto del día
          await db.runAsync('UPDATE equipos SET ultimo_preop_fecha = ? WHERE placa = ?', hoyBogota(), placa);
          return { requerido: false, fuente: 'servidor', motivo: 'El servidor confirma el preoperacional de hoy.' };
        }
        return { requerido: true, fuente: 'servidor', motivo: 'El servidor no tiene preoperacional de hoy para este equipo.' };
      }
    } catch {
      // sin red o timeout: se decide con lo guardado
    }
  }

  const eq = await db.getFirstAsync('SELECT ultimo_preop_fecha FROM equipos WHERE placa = ?', placa);
  if (eq?.ultimo_preop_fecha === hoyBogota()) {
    return { requerido: false, fuente: 'maestros', motivo: 'Según la última sincronización ya hay preoperacional de hoy.' };
  }
  return { requerido: true, fuente: 'desconocido', motivo: 'Sin señal no se puede confirmar el preoperacional de hoy.' };
}

// ── FOTOS ─────────────────────────────────────────────────────────────────────

function carpetaFotos() {
  const dir = new Directory(Paths.document, 'viajes');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Copia la foto temporal de la cámara a documentDirectory/viajes/{uuid}_{tipo}.jpg. Devuelve la URI. */
export async function guardarFoto(uriTemporal, uuid, tipo) {
  const destino = new File(carpetaFotos(), `${uuid}_${tipo}.jpg`);
  if (destino.exists) destino.delete();
  await new File(uriTemporal).copy(destino);
  return destino.uri;
}

export function existeArchivo(uri) {
  try { return !!uri && new File(uri).exists; } catch { return false; }
}

export function borrarArchivo(uri) {
  try { if (uri) { const f = new File(uri); if (f.exists) f.delete(); } } catch { /* no bloquea */ }
}

// ── VIAJE LOCAL ───────────────────────────────────────────────────────────────

/** El viaje en curso de ESTE celular (solo puede haber uno). */
export async function viajeEnCurso() {
  const db = await getDb();
  return db.getFirstAsync(`SELECT * FROM viajes_locales WHERE estado_local = 'EN_CURSO' ORDER BY id DESC LIMIT 1`);
}

export async function obtenerViaje(uuid) {
  const db = await getDb();
  return db.getFirstAsync('SELECT * FROM viajes_locales WHERE uuid = ?', uuid);
}

export function uuidViaje() {
  return nuevoUUID();
}

/**
 * Guarda el viaje en SQLite y lo deja en cola (inicio + foto_inicio).
 * Lanza un Error con mensaje para el operador si ya hay un viaje en curso.
 */
export async function crearViajeLocal(d) {
  const db = await getDb();
  const abierto = await viajeEnCurso();
  if (abierto) throw new Error(`Ya hay un viaje en curso (${abierto.placa}). Finalízalo antes de iniciar otro.`);
  const usuario = await AsyncStorage.getItem('userName');
  await db.runAsync(
    `INSERT INTO viajes_locales
       (uuid, usuario, placa, material, origen, destino, ruta_id, ruta_nombre, remision, cantidad,
        fecha, fecha_inicio_iso, lat_inicio, lon_inicio, foto_inicio_path, estado_local,
        sync_inicio, sync_foto_inicio, sync_foto_fin, sync_fin, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?, ?, ?, ?, 'EN_CURSO',
             'pending', ?, 'pending', 'pending', 'pending')`,
    d.uuid, usuario, d.placa, d.material, d.origen, d.destino, d.rutaId ?? null, d.rutaNombre ?? null,
    d.remision, d.cantidad ?? null, d.fechaInicioIso || ahoraISO(), d.lat ?? null, d.lon ?? null,
    d.fotoInicioPath ?? null, d.fotoInicioPath ? 'pending' : 'error'
  );
  return obtenerViaje(d.uuid);
}

/** Cierra el viaje en el celular y deja en cola foto_fin + fin. */
export async function finalizarViajeLocal(uuid, { fotoFinPath, lat, lon, fechaFinIso } = {}) {
  const db = await getDb();
  await db.runAsync(
    `UPDATE viajes_locales
        SET estado_local = 'FINALIZADO', fecha_fin_iso = ?, lat_fin = ?, lon_fin = ?,
            foto_fin_path = ?, sync_foto_fin = ?, sync_status = CASE WHEN sync_status = 'synced' THEN 'pending' ELSE sync_status END
      WHERE uuid = ? AND estado_local = 'EN_CURSO'`,
    fechaFinIso || ahoraISO(), lat ?? null, lon ?? null, fotoFinPath ?? null, fotoFinPath ? 'pending' : 'error', uuid
  );
  return obtenerViaje(uuid);
}
