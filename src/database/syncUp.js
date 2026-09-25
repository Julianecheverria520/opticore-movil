import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDb } from './db';
import { API_URL } from '../config';

const RUTA_PREOP = '/maestros/equipos/preoperacional/guardar';
// E1 · El endpoint ya existía en el servidor. Requiere el backend con E5 (idempotencia
// y fecha real del tanqueo) desplegado ANTES de publicar esta versión de la app.
const RUTA_TANQUEO = '/maestros/combustible/guardar';

const MAX_INTENTOS = 5;
const TIMEOUT_MS = 12000;
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

    for (const { tabla } of COLAS) {
      await db.runAsync(`DELETE FROM ${tabla} WHERE sync_status = 'synced' AND fecha < datetime('now','-14 days','localtime')`);
    }
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
  return { pendientes: await contar('pending'), errores: await contar('error') };
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
