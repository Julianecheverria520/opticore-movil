// src/tiquetes.js · foto del tiquete de tanqueo: archivo en el celular y envío (sin interfaz).
//
// - Archivo: documentDirectory/tiquetes/{uuid}.jpg, reducida como las fotos de viaje (≤1600 px, 0.7).
//   uuid = uuid_cliente del tanqueo: repetir la foto reemplaza el mismo archivo, y el servidor
//   (POST /movil/combustible/{uuid}/foto) sube a una ruta fija con upsert, así que reintentar no duplica.
// - Envío: etapa APARTE de la cola, al final y con su propio candado, solo cuando el tanqueo ya
//   quedó enviado. Una subida lenta (hasta 120 s) nunca frena los puntos del viaje ni los tanqueos.
//   SIN RESPUESTA → espera 5 min (salvo "Enviar ahora"); rechazo 4xx (salvo 408/429) o 5 fallas → error.
//   "ya_tiene_foto" (el administrador ya puso otra) cuenta como enviada.
// - Limpieza: borra archivos de tiquetes/ sin fila en tanqueos_pendientes y que no sean la foto de
//   un formulario abierto (con más de 1 h, por si acaso).
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { File, Directory, Paths } from 'expo-file-system';

import { API_URL } from './config';
import { leerToken } from './sesion';
import { getDb, ahoraISO } from './database/db';
import { reducirFoto, subirArchivo, existeArchivo, borrarArchivo, tamanoKB } from './viajes';

const CARPETA = 'tiquetes';
const CLAVE_EN_USO = 'tiquetesEnFormulario'; // nombres de archivo de formularios abiertos (aún sin fila)
export const TIMEOUT_FOTO_TIQUETE_MS = 120000;
export const PAUSA_FOTO_TIQUETE_MS = 5 * 60000;
export const MAX_INTENTOS_FOTO = 5;
const EDAD_MINIMA_HUERFANA_MS = 60 * 60000;

let enviandoFotos = null; // promesa de la tanda en curso (candado propio, aparte del de la cola)

function carpeta() {
  const dir = new Directory(Paths.document, CARPETA);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const nombreDe = (uri) => String(uri || '').split(/[/\\]/).pop().split('?')[0];

async function leerEnUso() {
  try { const l = JSON.parse((await AsyncStorage.getItem(CLAVE_EN_USO)) || '[]'); return Array.isArray(l) ? l : []; }
  catch { return []; }
}

async function marcarEnUso(nombre, enUso) {
  const l = (await leerEnUso()).filter((n) => n !== nombre);
  if (enUso) l.push(nombre);
  await AsyncStorage.setItem(CLAVE_EN_USO, JSON.stringify(l));
}

/**
 * Guarda la foto de la cámara como tiquetes/{uuid}.jpg (reducida; si falla la reducción, la original)
 * y la marca como "en un formulario abierto" para que la limpieza no la borre. Devuelve la URI.
 */
export async function guardarFotoTiquete(uriTemporal, uuid, anchoOriginal) {
  const destino = new File(carpeta(), `${uuid}.jpg`);
  let origen = uriTemporal;
  try {
    origen = await reducirFoto(uriTemporal, Number(anchoOriginal) || 0);
  } catch (e) {
    console.warn('No se pudo reducir la foto del tiquete; se guarda la original:', e?.message || e);
  }
  if (destino.exists) destino.delete();
  await new File(origen).copy(destino);
  if (origen !== uriTemporal) { try { new File(origen).delete(); } catch { /* temporal */ } }
  await marcarEnUso(destino.name, true);
  return destino.uri;
}

/** El formulario terminó: guardó (la fila ya la referencia) o salió sin guardar (borrar = true). */
export async function soltarFotoFormulario(uri, { borrar = false } = {}) {
  if (!uri) return;
  if (borrar) borrarArchivo(uri);
  try { await marcarEnUso(nombreDe(uri), false); } catch { /* la limpieza la respeta 1 h */ }
}

// ── Envío ──────────────────────────────────────────────────────────────────────

async function anotarFoto(db, id, codigo, mensaje) {
  try {
    await db.runAsync('UPDATE tanqueos_pendientes SET diag_foto = ? WHERE id = ?',
      JSON.stringify({ codigo, mensaje: String(mensaje ?? '').slice(0, 200), hora: ahoraISO() }), id);
  } catch { /* el diagnóstico es informativo */ }
}

function leerDiagFoto(texto) {
  try { return JSON.parse(texto || 'null'); } catch { return null; }
}

function enPausa(t, forzar) {
  if (forzar) return false;
  const d = leerDiagFoto(t.diag_foto);
  if (!d || d.codigo !== 'SIN RESPUESTA') return false;
  const ms = Date.parse(d.hora);
  return Number.isFinite(ms) && Date.now() - ms < PAUSA_FOTO_TIQUETE_MS;
}

async function detalle(r) {
  try {
    const j = await r.json();
    return typeof j?.detail === 'string' ? j.detail : JSON.stringify(j?.detail ?? j);
  } catch {
    return `HTTP ${r.status}`;
  }
}

/** Sube UNA foto. → 'ok' | 'sigue' (falló solo esta) | 'sin_red' | 'sesion' (detener la tanda) */
async function subirUna(db, t, token) {
  if (!existeArchivo(t.foto_uri)) {
    await db.runAsync("UPDATE tanqueos_pendientes SET foto_estado = 'error' WHERE id = ?", t.id);
    await anotarFoto(db, t.id, 'SIN ARCHIVO', 'La foto ya no está en el celular');
    return 'sigue';
  }
  const kb = tamanoKB(t.foto_uri);
  const t0 = Date.now();
  const medida = () => `${kb ?? '?'} KB · ${((Date.now() - t0) / 1000).toFixed(1)} s (límite ${TIMEOUT_FOTO_TIQUETE_MS / 1000} s)`;

  let r;
  try {
    r = await subirArchivo(`${API_URL}/movil/combustible/${encodeURIComponent(t.uuid)}/foto`, token, t.foto_uri, TIMEOUT_FOTO_TIQUETE_MS);
  } catch (e) {
    await anotarFoto(db, t.id, 'SIN RESPUESTA', `${medida()} · ${e?.message || String(e)}`);
    return 'sin_red';
  }
  if (r.status === 401) { await anotarFoto(db, t.id, 401, 'Sesión vencida'); return 'sesion'; }

  if (r.ok) {
    let cuerpo = {};
    try { cuerpo = await r.json(); } catch { /* sin cuerpo */ }
    await db.runAsync("UPDATE tanqueos_pendientes SET foto_estado = 'synced' WHERE id = ?", t.id);
    await anotarFoto(db, t.id, r.status, `${medida()} · ${cuerpo?.status === 'ya_tiene_foto' ? 'El tanqueo ya tenía foto (puesta en la web)' : 'OK'}`);
    borrarArchivo(t.foto_uri); // ya está en el servidor
    return 'ok';
  }

  const msg = `${r.status}: ${await detalle(r)}`;
  const intentos = (Number(t.intentos_foto) || 0) + 1;
  const permanente = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
  const estado = permanente || intentos >= MAX_INTENTOS_FOTO ? 'error' : 'pending';
  await db.runAsync('UPDATE tanqueos_pendientes SET intentos_foto = ?, foto_estado = ? WHERE id = ?', intentos, estado, t.id);
  await anotarFoto(db, t.id, r.status, `${medida()} · ${msg}`);
  return 'sigue';
}

async function tanda({ forzarFotos = false } = {}) {
  const red = await NetInfo.fetch();
  if (!red.isConnected || red.isInternetReachable === false) return { sinRed: true };
  const token = await leerToken();
  if (!token) return { sesionExpirada: true };
  const usuario = await AsyncStorage.getItem('userName');
  const db = await getDb();

  // Solo tanqueos que el servidor ya tiene (la foto se asocia por uuid_cliente)
  const filas = await db.getAllAsync(
    `SELECT id, uuid, foto_uri, intentos_foto, diag_foto FROM tanqueos_pendientes
      WHERE sync_status = 'synced' AND foto_estado = 'pending' AND (usuario IS NULL OR usuario = ?) ORDER BY id ASC`,
    usuario ?? ''
  );
  const res = { enviadas: 0, errores: 0 };
  for (const t of filas) {
    if (enPausa(t, forzarFotos)) continue;
    const e = await subirUna(db, t, token);
    if (e === 'ok') res.enviadas++;
    else if (e === 'sin_red') return { ...res, sinRed: true };
    else if (e === 'sesion') return { ...res, sesionExpirada: true };
  }
  res.errores = (await db.getFirstAsync("SELECT COUNT(*) AS n FROM tanqueos_pendientes WHERE foto_estado = 'error'"))?.n || 0;
  return res;
}

/**
 * Sube las fotos pendientes. Si ya hay una tanda en curso devuelve esa misma promesa (no lanza otra).
 * opciones.forzarFotos: incluye las que están en pausa por SIN RESPUESTA ("Enviar ahora").
 */
export function enviarFotosTiquete(opciones = {}) {
  if (!enviandoFotos) {
    enviandoFotos = tanda(opciones)
      .catch((e) => { console.warn('Fotos de tiquetes:', e?.message || e); return { error: true }; })
      .finally(() => { enviandoFotos = null; });
  }
  return enviandoFotos;
}

/** Espera la tanda en curso (si hay). */
export function esperarFotosTiquete() {
  return enviandoFotos || Promise.resolve(null);
}

/** "Reintentar": las fotos con error vuelven a la cola (el archivo tiene que seguir en el celular). */
export async function reintentarFotosTiquete() {
  const db = await getDb();
  await db.runAsync(
    "UPDATE tanqueos_pendientes SET foto_estado = 'pending', intentos_foto = 0, diag_foto = NULL WHERE foto_estado = 'error' AND foto_uri IS NOT NULL"
  );
}

/**
 * Tarjeta "Fotos de tiquetes" en Home.
 * → { pendientes, errores, esperandoTanqueo, ultimo: {placa, codigo, mensaje, hora} | null }
 */
export async function resumenFotosTiquete(db) {
  const d = db || await getDb();
  const c = await d.getFirstAsync(
    `SELECT SUM(CASE WHEN foto_estado = 'pending' AND sync_status <> 'error' THEN 1 ELSE 0 END) AS pendientes,
            SUM(CASE WHEN foto_estado = 'pending' AND sync_status = 'pending' THEN 1 ELSE 0 END) AS esperando,
            SUM(CASE WHEN foto_estado = 'error' THEN 1 ELSE 0 END) AS errores
       FROM tanqueos_pendientes`
  );
  const fila = await d.getFirstAsync(
    `SELECT placa, diag_foto FROM tanqueos_pendientes
      WHERE diag_foto IS NOT NULL AND (foto_estado = 'error' OR (foto_estado = 'pending' AND sync_status <> 'error'))
      ORDER BY id DESC LIMIT 1`
  );
  const diag = leerDiagFoto(fila?.diag_foto);
  return {
    pendientes: c?.pendientes || 0,
    errores: c?.errores || 0,
    esperandoTanqueo: c?.esperando || 0,
    ultimo: diag ? { placa: fila.placa, ...diag } : null,
  };
}

// ── Limpieza ───────────────────────────────────────────────────────────────────

/** Borra de tiquetes/ los archivos sin fila ni formulario abierto (y con más de 1 h). Devuelve cuántos. */
export async function limpiarTiquetesHuerfanos(db) {
  let dir;
  try { dir = new Directory(Paths.document, CARPETA); if (!dir.exists) return 0; } catch { return 0; }
  const usados = new Set();
  for (const r of await db.getAllAsync('SELECT uuid, foto_uri FROM tanqueos_pendientes')) {
    if (r.uuid) usados.add(`${r.uuid}.jpg`);
    if (r.foto_uri) usados.add(nombreDe(r.foto_uri));
  }
  for (const n of await leerEnUso()) usados.add(n);

  let borrados = 0;
  for (const f of dir.list()) {
    if (!(f instanceof File) || usados.has(f.name)) continue;
    const mt = Number(f.modificationTime) || 0;
    if (mt && Date.now() - mt < EDAD_MINIMA_HUERFANA_MS) continue;
    try { f.delete(); borrados++; } catch { /* se intenta en la próxima limpieza */ }
  }
  return borrados;
}
