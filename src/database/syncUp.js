import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDb } from './db';
import { API_URL } from '../config';
import { existeArchivo, borrarArchivo, subirArchivo } from '../viajes';
import { ahoraISO } from './db';
import { lotePendiente } from '../gps/puntos';

const RUTA_PREOP = '/maestros/equipos/preoperacional/guardar';
// E1 · El endpoint ya existía en el servidor. Requiere el backend con E5 (idempotencia
// y fecha real del tanqueo) desplegado ANTES de publicar esta versión de la app.
const RUTA_TANQUEO = '/maestros/combustible/guardar';

const MAX_INTENTOS = 5;
const TIMEOUT_MS = 12000;
const TIMEOUT_FOTO_MS = 30000;   // una foto con señal débil tarda más que un JSON
const RUTA_VIAJES = '/movil/viajes';
const MAX_LOTES_POR_PASADA = 10;   // hasta 2.000 puntos por pasada; el resto en la siguiente
let enviando = false;

function payloadPreop(r) {
  return {
    uuid_cliente: r.uuid,
    placa: r.equipo_id,
    fecha_reporte: r.fecha_iso || `${String(r.fecha).replace(' ', 'T')}-05:00`,
    odometro_anterior: r.odometro_anterior || 0,
    horometro_anterior: r.horometro_anterior || 0,
    odometro_nuevo: r.odometro || 0,
    horometro_nuevo: r.horometro || 0,
    estado_equipo: r.estado_equipo,
    check_list: JSON.parse(r.respuestas_json || '{}'),
    observaciones: r.observaciones || '',
    latitud: r.latitud,
    longitud: r.longitud,
  };
}

function payloadTanqueo(r) {
  return {
    uuid_cliente: r.uuid,
    fecha_registro: r.fecha_iso || `${String(r.fecha).replace(' ', 'T')}-05:00`,
    placa: r.placa,
    cantidad_galones: r.cantidad_galones,
    valor_total: r.valor_total,
    proveedor: r.proveedor || '',
    tanque_lleno: !!r.tanque_lleno,
    odometro_tanqueo: r.odometro_tanqueo || 0,
    horometro_tanqueo: r.horometro_tanqueo || 0,
    latitud: r.latitud,
    longitud: r.longitud,
    observaciones: r.observaciones || '',
  };
}

const COLAS = [
  { tabla: 'reportes_pendientes', ruta: RUTA_PREOP, armar: payloadPreop },
  { tabla: 'tanqueos_pendientes', ruta: RUTA_TANQUEO, armar: payloadTanqueo },
];

async function post(ruta, token, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${API_URL}${ruta}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/** Sube una foto (multipart) con el cargador nativo de expo-file-system. */
function postFoto(ruta, token, uri) {
  return subirArchivo(`${API_URL}${ruta}`, token, uri, TIMEOUT_FOTO_MS);
}

/**
 * Diagnóstico visible en "Viaje en curso": resultado del ÚLTIMO intento de cada etapa
 * (código HTTP o "SIN RESPUESTA", mensaje y hora). Nunca rompe el envío.
 */
async function anotar(db, id, etapa, codigo, mensaje) {
  try {
    const fila = await db.getFirstAsync('SELECT diag_envio FROM viajes_locales WHERE id = ?', id);
    let d = {};
    try { d = JSON.parse(fila?.diag_envio || '{}') || {}; } catch { d = {}; }
    d[etapa] = { codigo, mensaje: String(mensaje ?? '').slice(0, 200), hora: ahoraISO() };
    await db.runAsync('UPDATE viajes_locales SET diag_envio = ? WHERE id = ?', JSON.stringify(d), id);
  } catch { /* el diagnóstico es informativo */ }
}

async function detalle(res) {
  try {
    const j = await res.json();
    return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function procesarCola(db, { tabla, ruta, armar }, token, usuario) {
  const res = { enviados: 0, errores: 0 };
  const filas = await db.getAllAsync(
    `SELECT * FROM ${tabla} WHERE sync_status = 'pending' AND (usuario IS NULL OR usuario = ?) ORDER BY id ASC`,
    usuario ?? ''
  );

  for (const fila of filas) {
    let r;
    try { r = await post(ruta, token, armar(fila)); }
    catch { return { ...res, sinRed: true }; }

    if (r.status === 401) return { ...res, sesionExpirada: true };

    // 2xx incluye {"status": "duplicate"}: el servidor ya lo tenía (reenvío tras un timeout)
    if (r.ok) {
      await db.runAsync(`UPDATE ${tabla} SET sync_status = 'synced', ultimo_error = NULL WHERE id = ?`, fila.id);
      res.enviados++;
      continue;
    }

    const msg = await detalle(r);
    const intentos = (fila.intentos || 0) + 1;
    const permanente = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;

    if (permanente || intentos >= MAX_INTENTOS) {
      await db.runAsync(`UPDATE ${tabla} SET sync_status = 'error', intentos = ?, ultimo_error = ? WHERE id = ?`, intentos, `${r.status}: ${msg}`, fila.id);
      res.errores++;
      continue;
    }

    await db.runAsync(`UPDATE ${tabla} SET intentos = ?, ultimo_error = ? WHERE id = ?`, intentos, `${r.status}: ${msg}`, fila.id);
    return { ...res, servidorNoDisponible: true };
  }
  return res;
}

// ── VIAJES ────────────────────────────────────────────────────────────────────
// Un viaje sube por etapas y en orden: inicio -> foto_inicio -> puntos GPS
// -> foto_fin -> fin (el fin solo cuando no quedan puntos). Cada etapa es idempotente en el servidor (uuid_cliente), así que
// un reintento tras un timeout nunca duplica nada. Reglas iguales a las otras colas:
//   · sin red / 401 -> se detiene sin tocar nada
//   · 4xx (salvo 408/429) -> error permanente de ESA etapa
//   · 5xx / 408 / 429 -> reintento en la próxima pasada (MAX_INTENTOS)
// Las FOTOS nunca bloquean: si fallan (por lo que sea) se reintentan en la próxima
// pasada, pero los puntos y el cierre siguen. El inicio y el fin sí son obligatorios.
// Toda falla queda en diag_envio con su código y mensaje reales (antes una excepción
// cualquiera se trataba en silencio como "sin red" y el viaje quedaba atascado).

function payloadInicioViaje(v) {
  return {
    uuid_cliente: v.uuid,
    placa: v.placa,
    material: v.material,
    origen: v.origen,
    destino: v.destino,
    ruta_id: v.ruta_id,
    remision: v.remision,
    cantidad: v.cantidad,
    fecha_inicio: v.fecha_inicio_iso,
    latitud: v.lat_inicio,
    longitud: v.lon_inicio,
  };
}

function payloadFinViaje(v) {
  return { fecha_fin: v.fecha_fin_iso, latitud: v.lat_fin, longitud: v.lon_fin };
}

/** Ejecuta una etapa. Devuelve 'ok' | 'permanente' | 'sin_red' | 'sesion' | 'servidor'. */
async function etapaViaje(db, v, columna, etapa, llamar, alOk) {
  let r;
  try { r = await llamar(); } catch (e) {
    await anotar(db, v.id, etapa, 'SIN RESPUESTA', e?.message || String(e));
    return 'sin_red';
  }
  if (r.status === 401) { await anotar(db, v.id, etapa, 401, 'Sesión vencida'); return 'sesion'; }

  if (r.ok) {
    let cuerpo = {};
    try { cuerpo = await r.json(); } catch { /* respuesta sin cuerpo */ }
    await db.runAsync(`UPDATE viajes_locales SET ${columna} = 'synced', intentos = 0, ultimo_error = NULL WHERE id = ?`, v.id);
    await anotar(db, v.id, etapa, r.status, cuerpo?.status || 'OK');
    if (alOk) await alOk(cuerpo);
    return 'ok';
  }

  const msg = `${r.status}: ${await detalle(r)}`;
  await anotar(db, v.id, etapa, r.status, msg);
  const intentos = (v.intentos || 0) + 1;
  const permanente = r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429;
  if (permanente || intentos >= MAX_INTENTOS) {
    await db.runAsync(`UPDATE viajes_locales SET ${columna} = 'error', intentos = ?, ultimo_error = ? WHERE id = ?`, intentos, msg, v.id);
    return 'permanente';
  }
  await db.runAsync('UPDATE viajes_locales SET intentos = ?, ultimo_error = ? WHERE id = ?', intentos, msg, v.id);
  return 'servidor';
}

const DETENER = { sin_red: { sinRed: true }, sesion: { sesionExpirada: true }, servidor: { servidorNoDisponible: true } };

async function procesarViajes(db, token, usuario) {
  const res = { enviados: 0, errores: 0 };
  const viajes = await db.getAllAsync(
    `SELECT * FROM viajes_locales WHERE sync_status = 'pending' AND (usuario IS NULL OR usuario = ?) ORDER BY id ASC`,
    usuario ?? ''
  );

  for (let v of viajes) {
    const base = `${RUTA_VIAJES}/${encodeURIComponent(v.uuid)}`;
    const recargar = async () => { v = await db.getFirstAsync('SELECT * FROM viajes_locales WHERE id = ?', v.id); };

    // 1. INICIO (sin él, el servidor no conoce el viaje: nada más se puede subir)
    if (v.sync_inicio === 'pending') {
      const e = await etapaViaje(db, v, 'sync_inicio', 'inicio', () => post(`${RUTA_VIAJES}/iniciar`, token, payloadInicioViaje(v)),
        (c) => db.runAsync(
          'UPDATE viajes_locales SET id_viaje_servidor = ?, requiere_revision = ?, motivo_revision = ? WHERE id = ?',
          c.id_viaje ?? null, c.requiere_revision ? 1 : 0, c.motivo_revision ?? null, v.id));
      if (DETENER[e]) return { ...res, ...DETENER[e] };
      if (e === 'permanente') {
        await db.runAsync("UPDATE viajes_locales SET sync_status = 'error' WHERE id = ?", v.id);
        res.errores++;
        continue;
      }
      res.enviados++;
      await recargar();
    }
    if (v.sync_inicio !== 'synced') continue;

    // 2. FOTO DE INICIO
    if (v.sync_foto_inicio === 'pending') {
      if (!existeArchivo(v.foto_inicio_path)) {
        await db.runAsync("UPDATE viajes_locales SET sync_foto_inicio = 'error', ultimo_error = 'Foto de inicio no encontrada en el celular' WHERE id = ?", v.id);
        await anotar(db, v.id, 'foto_inicio', 'SIN ARCHIVO', 'Foto de inicio no encontrada en el celular');
      } else {
        const e = await etapaViaje(db, v, 'sync_foto_inicio', 'foto_inicio', () => postFoto(`${base}/foto?tipo=inicio`, token, v.foto_inicio_path));
        if (e === 'sesion') return { ...res, ...DETENER[e] };
        // cualquier otro fallo de la foto NO detiene: los puntos y el cierre siguen
      }
      await recargar();
    }

    // 3. PUNTOS GPS: lotes de hasta 200 ordenados por seq. Solo un 2xx los marca enviados.
    //    El servidor ignora los que ya tenía (id_viaje, seq), así que reenviar es seguro.
    for (let lote = 0; lote < MAX_LOTES_POR_PASADA; lote++) {
      const puntos = await lotePendiente(v.uuid);
      if (!puntos.length) break;
      const ids = puntos.map((p) => p.id);
      const marcar = (valor) => db.runAsync(`UPDATE puntos_gps SET enviado = ? WHERE id IN (${ids.map(() => '?').join(',')})`, valor, ...ids);
      let r;
      try {
        r = await post(`${base}/puntos`, token, {
          puntos: puntos.map((p) => ({ seq: p.seq, latitud: p.latitud, longitud: p.longitud, precision: p.precision, velocidad: p.velocidad, ts: p.ts_iso })),
        });
      } catch (e) {
        await anotar(db, v.id, 'puntos', 'SIN RESPUESTA', e?.message || String(e));
        return { ...res, sinRed: true };
      }
      if (r.status === 401) { await anotar(db, v.id, 'puntos', 401, 'Sesión vencida'); return { ...res, sesionExpirada: true }; }
      if (r.ok) {
        let c = {};
        try { c = await r.json(); } catch { /* sin cuerpo */ }
        await marcar(1);
        await anotar(db, v.id, 'puntos', r.status, `Lote de ${puntos.length}: ${c.insertados ?? '?'} nuevos, ${c.ignorados ?? '?'} ya estaban`);
        continue;
      }

      const msg = `Puntos GPS ${r.status}: ${await detalle(r)}`;
      await anotar(db, v.id, 'puntos', r.status, msg);
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
        // Rechazo permanente de este lote: se aparta (-1) para no bloquear el resto ni el cierre
        await marcar(-1);
        await db.runAsync('UPDATE viajes_locales SET ultimo_error = ? WHERE id = ?', msg, v.id);
        continue;
      }
      await db.runAsync('UPDATE viajes_locales SET ultimo_error = ? WHERE id = ?', msg, v.id);
      return { ...res, servidorNoDisponible: true };
    }

    if (v.estado_local !== 'FINALIZADO') continue;

    // 4. FOTO DE FIN
    if (v.sync_foto_fin === 'pending') {
      if (!existeArchivo(v.foto_fin_path)) {
        await db.runAsync("UPDATE viajes_locales SET sync_foto_fin = 'error', ultimo_error = 'Foto de fin no encontrada en el celular' WHERE id = ?", v.id);
        await anotar(db, v.id, 'foto_fin', 'SIN ARCHIVO', 'Foto de fin no encontrada en el celular');
      } else {
        const e = await etapaViaje(db, v, 'sync_foto_fin', 'foto_fin', () => postFoto(`${base}/foto?tipo=fin`, token, v.foto_fin_path));
        if (e === 'sesion') return { ...res, ...DETENER[e] };
      }
      await recargar();
    }

    // 5. FIN: solo cuando ya no quedan puntos por subir (el recorrido llega completo antes del cierre)
    const quedan = await db.getFirstAsync('SELECT COUNT(*) AS n FROM puntos_gps WHERE viaje_uuid = ? AND enviado = 0', v.uuid);
    if ((quedan?.n || 0) > 0) continue;

    if (v.sync_fin === 'pending') {
      const e = await etapaViaje(db, v, 'sync_fin', 'fin', () => post(`${base}/finalizar`, token, payloadFinViaje(v)));
      if (DETENER[e]) return { ...res, ...DETENER[e] };
      if (e === 'permanente') {
        await db.runAsync("UPDATE viajes_locales SET sync_status = 'error' WHERE id = ?", v.id);
        res.errores++;
        continue;
      }
      res.enviados++;
      await recargar();
    }

    // Todo arriba: se cierra la fila y se liberan las fotos que ya están en el servidor
    if (v.sync_fin === 'synced' && v.sync_foto_inicio !== 'pending' && v.sync_foto_fin !== 'pending') {
      await db.runAsync("UPDATE viajes_locales SET sync_status = 'synced' WHERE id = ?", v.id);
      if (v.sync_foto_inicio === 'synced') borrarArchivo(v.foto_inicio_path);
      if (v.sync_foto_fin === 'synced') borrarArchivo(v.foto_fin_path);
    }
  }
  return res;
}

/**
 * Sube la cola. Con un 401 devuelve { sesionExpirada: true } y NO borra nada:
 * la pantalla decide pedir credenciales sin sacar al operador de la app (E3).
 */
export async function enviarPendientes() {
  if (enviando) return { omitido: true };
  enviando = true;
  try {
    const red = await NetInfo.fetch();
    if (!red.isConnected || red.isInternetReachable === false) return { sinRed: true };

    const token = await AsyncStorage.getItem('userToken');
    if (!token) return { sesionExpirada: true };
    const usuario = await AsyncStorage.getItem('userName');

    const db = await getDb();
    const total = { enviados: 0, errores: 0 };

    for (const cola of COLAS) {
      if (!cola.ruta) continue;
      const r = await procesarCola(db, cola, token, usuario);
      total.enviados += r.enviados;
      total.errores += r.errores;
      if (r.sinRed || r.sesionExpirada || r.servidorNoDisponible) return { ...r, enviados: total.enviados, errores: total.errores };
    }

    const rv = await procesarViajes(db, token, usuario);
    total.enviados += rv.enviados;
    total.errores += rv.errores;
    if (rv.sinRed || rv.sesionExpirada || rv.servidorNoDisponible) return { ...rv, enviados: total.enviados, errores: total.errores };

    for (const { tabla } of COLAS) {
      await db.runAsync(`DELETE FROM ${tabla} WHERE sync_status = 'synced' AND fecha < datetime('now','-14 days','localtime')`);
    }
    await db.runAsync(`DELETE FROM puntos_gps WHERE viaje_uuid IN (SELECT uuid FROM viajes_locales WHERE sync_status = 'synced' AND fecha < datetime('now','-14 days','localtime'))`);
    await db.runAsync(`DELETE FROM viajes_locales WHERE sync_status = 'synced' AND fecha < datetime('now','-14 days','localtime')`);
    return total;
  } catch (e) {
    console.warn('Error enviando pendientes:', e?.message || e);
    return { error: true };
  } finally {
    enviando = false;
  }
}

export async function contarPendientes() {
  const db = await getDb();
  const contar = async (estado) => {
    let n = 0;
    for (const { tabla } of COLAS) n += (await db.getFirstAsync(`SELECT COUNT(*) AS n FROM ${tabla} WHERE sync_status = ?`, estado)).n;
    return n;
  };
  // Viajes: "por enviar" solo lo que ya se puede subir (un viaje en curso con el inicio
  // enviado no cuenta hasta que se finalice). Errores: inicio/fin fallidos o fotos con error.
  const vp = await db.getFirstAsync(
    `SELECT COUNT(*) AS n FROM viajes_locales WHERE sync_status = 'pending' AND (
        sync_inicio = 'pending' OR sync_foto_inicio = 'pending'
        OR (estado_local = 'FINALIZADO' AND (sync_fin = 'pending' OR sync_foto_fin = 'pending')))`
  );
  const ve = await db.getFirstAsync(
    `SELECT COUNT(*) AS n FROM viajes_locales
      WHERE sync_status = 'error' OR sync_foto_inicio = 'error' OR sync_foto_fin = 'error'`
  );
  return { pendientes: (await contar('pending')) + (vp?.n || 0), errores: (await contar('error')) + (ve?.n || 0) };
}

/**
 * Llama a alReconectar() cada vez que el celular pasa de SIN red a CON red.
 * E6 · El primer evento de NetInfo solo registra el estado inicial: la pantalla ya
 * sincroniza al abrir, y antes ambos disparos corrían en paralelo.
 */
export function iniciarAutoSync(alReconectar) {
  let estabaConectado = null;
  return NetInfo.addEventListener((estado) => {
    const conectado = !!estado.isConnected && estado.isInternetReachable !== false;
    const primerEvento = estabaConectado === null;
    const reconecto = conectado && estabaConectado === false;
    estabaConectado = conectado;
    if (!primerEvento && reconecto && alReconectar) {
      Promise.resolve(alReconectar()).catch(() => {});
    }
  });
}
