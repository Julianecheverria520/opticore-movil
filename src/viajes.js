// src/viajes.js · lógica de viajes sin interfaz (se puede probar fuera del celular)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Directory, Paths, UploadTask, UploadType } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

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

export const FOTO_ANCHO_MAX = 1600;   // px
export const FOTO_COMPRESION = 0.7;

/**
 * Reduce la foto antes de guardarla: máximo 1600 px de ancho (nunca la agranda) y JPEG
 * con compresión 0.7. Una foto de cámara de 3-6 MB (más de noche, por el ruido) queda
 * típicamente en 250-600 KB y sube en segundos aun con señal débil.
 * anchoOriginal: el que reporta la cámara (si no viene, se mide al procesar).
 */
async function reducirFoto(uri, anchoOriginal) {
  let ctx = ImageManipulator.manipulate(uri);
  if (anchoOriginal > FOTO_ANCHO_MAX) ctx = ctx.resize({ width: FOTO_ANCHO_MAX });
  let img = await ctx.renderAsync();
  if (!(anchoOriginal > 0) && img.width > FOTO_ANCHO_MAX) {
    img = await ImageManipulator.manipulate(img).resize({ width: FOTO_ANCHO_MAX }).renderAsync();
  }
  const r = await img.saveAsync({ compress: FOTO_COMPRESION, format: SaveFormat.JPEG });
  return r.uri;
}

/**
 * Reduce la foto de la cámara y la guarda en documentDirectory/viajes/{uuid}_{tipo}.jpg.
 * Si la reducción falla por cualquier motivo, se guarda la original (nunca se pierde la foto).
 * Devuelve la URI guardada.
 */
export async function guardarFoto(uriTemporal, uuid, tipo, anchoOriginal) {
  const destino = new File(carpetaFotos(), `${uuid}_${tipo}.jpg`);
  if (destino.exists) destino.delete();
  let origen = uriTemporal;
  try {
    origen = await reducirFoto(uriTemporal, Number(anchoOriginal) || 0);
  } catch (e) {
    console.warn('No se pudo reducir la foto; se guarda la original:', e?.message || e);
  }
  await new File(origen).copy(destino);
  if (origen !== uriTemporal) { try { new File(origen).delete(); } catch { /* temporal */ } }
  return destino.uri;
}

export function existeArchivo(uri) {
  try { return !!uri && new File(uri).exists; } catch { return false; }
}

/**
 * Sube un archivo como multipart/form-data (campo "file") con el cargador NATIVO de
 * expo-file-system, sin pasar por el FormData de React Native.
 * Devuelve un objeto con la misma forma que la respuesta de fetch ({ ok, status, json }).
 */
export async function subirArchivo(url, token, uri, timeoutMs = 30000) {
  const tarea = new UploadTask(new File(uri), url, {
    httpMethod: 'POST',
    uploadType: UploadType.MULTIPART,
    fieldName: 'file',
    mimeType: 'image/jpeg',
    headers: { Authorization: `Bearer ${token}` },
  });
  const t = setTimeout(() => { try { tarea.cancel(); } catch { /* ya terminó */ } }, timeoutMs);
  try {
    const r = await tarea.uploadAsync();
    const status = Number(r?.status) || 0;
    const cuerpo = r?.body ?? '';
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(cuerpo || '{}') };
  } finally {
    clearTimeout(t);
    try { tarea.release(); } catch { /* sin recursos que liberar */ }
  }
}

/** Tamaño del archivo en KB (null si no se puede leer). */
export function tamanoKB(uri) {
  try { return Math.round((new File(uri).size || 0) / 1024); } catch { return null; }
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

// ── VIAJES CON PROBLEMA DE ENVÍO ──────────────────────────────────────────────
// Error permanente de una etapa (4xx o 5 fallas), foto con error o puntos rechazados.
// El conductor decide: reintentar o descartar (sync_status = 'descartado').

const COND_PROBLEMA = `sync_status <> 'descartado' AND (
    sync_status = 'error' OR sync_foto_inicio = 'error' OR sync_foto_fin = 'error'
    OR EXISTS (SELECT 1 FROM puntos_gps p WHERE p.viaje_uuid = viajes_locales.uuid AND p.enviado = -1))`;

/** Viajes de este celular con algún problema de envío (el más reciente primero). */
export async function viajesConProblema() {
  const db = await getDb();
  return db.getAllAsync(`SELECT * FROM viajes_locales WHERE ${COND_PROBLEMA} ORDER BY id DESC`);
}

/** ¿Este viaje tiene un problema que el conductor puede reintentar o descartar? */
export async function tieneProblema(uuid) {
  const db = await getDb();
  return !!(await db.getFirstAsync(`SELECT 1 AS si FROM viajes_locales WHERE uuid = ? AND ${COND_PROBLEMA}`, uuid));
}

/** Vuelve a poner en cola lo que quedó con error (etapas y puntos rechazados). */
export async function reintentarViaje(uuid) {
  const db = await getDb();
  const reabrir = (c) => `${c} = CASE WHEN ${c} = 'error' THEN 'pending' ELSE ${c} END`;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE viajes_locales SET ${['sync_inicio', 'sync_foto_inicio', 'sync_foto_fin', 'sync_fin'].map(reabrir).join(', ')},
              sync_status = 'pending', intentos_etapa = NULL, ultimo_error = NULL
        WHERE uuid = ? AND sync_status <> 'descartado'`, uuid
    );
    await db.runAsync('UPDATE puntos_gps SET enviado = 0 WHERE viaje_uuid = ? AND enviado = -1', uuid);
  });
  return obtenerViaje(uuid);
}

/**
 * Deja de enviar lo que falte del viaje: borra del celular sus fotos y los puntos no
 * enviados. Si estaba EN_CURSO pasa a DESCARTADO (el GPS lo detiene la pantalla y, si no,
 * la tarea al no encontrar viaje en curso). Lo que ya llegó al servidor no se toca.
 */
export async function descartarViaje(uuid) {
  const db = await getDb();
  const v = await obtenerViaje(uuid);
  if (!v) return null;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE viajes_locales SET sync_status = 'descartado',
              estado_local = CASE WHEN estado_local = 'EN_CURSO' THEN 'DESCARTADO' ELSE estado_local END
        WHERE uuid = ?`, uuid
    );
    await db.runAsync('DELETE FROM puntos_gps WHERE viaje_uuid = ? AND enviado <> 1', uuid);
  });
  borrarArchivo(v.foto_inicio_path);
  borrarArchivo(v.foto_fin_path);
  return obtenerViaje(uuid);
}

// ── CONCILIACIÓN CON EL SERVIDOR ──────────────────────────────────────────────

/**
 * Viajes EN_PROGRESO del conductor en el servidor que este celular NO está manejando:
 * iniciados en la PWA, pruebas abandonadas o viajes descartados aquí. Mientras sigan
 * abiertos, el servidor marca los viajes nuevos "otro viaje en curso" (REVISAR).
 * Devuelve la lista (vacía si no hay) o null si no se pudo consultar (sin señal).
 */
export async function viajesAbiertosAjenos({ token, apiUrl, timeoutMs = 6000 } = {}) {
  if (!token || !apiUrl) return null;
  try {
    const res = await fetchConTimeout(`${apiUrl}/movil/viajes/activo`, { headers: { Authorization: `Bearer ${token}` } }, timeoutMs);
    if (!res.ok) return null;
    const d = await res.json();
    const db = await getDb();
    const propios = new Set(
      (await db.getAllAsync("SELECT uuid FROM viajes_locales WHERE sync_status <> 'descartado'")).map((r) => r.uuid)
    );
    return (d.viajes || []).filter((v) => !v.uuid_cliente || !propios.has(v.uuid_cliente));
  } catch {
    return null;
  }
}

/** Texto para el conductor con la lista de viajes abiertos en el sistema. */
export function describirAjenos(lista) {
  const filas = lista.map((v) => `• #${v.id_viaje} · ${v.placa} · remisión ${v.remision || '—'} · desde ${String(v.fecha_inicio || '').slice(0, 16)}`);
  return `${filas.join('\n')}\n\nNo están en este celular (se iniciaron en otro lado o se descartaron). ` +
    'Pide al administrador que los cierre o anule en el Gestor de vales: mientras sigan abiertos, ' +
    'tus viajes nuevos quedan marcados para revisión.';
}
