// src/configEquipo.js · Configuración de activos del equipo, leída SIN señal (sin interfaz: se prueba
// en Node, scripts/banco/probar_config_equipo.mjs).
//
// /movil/maestros manda en cada equipo su configuración EFECTIVA plana
// ({paquete: {campo: valor, ..., aplica}}, core/config_activos.py del servidor), que sync.js guarda en
// equipos.config_json, y arriba "config_conectados": los paquetes que la operación ya obedece.
// Un paquete que no está conectado es solo informativo: la app lo ignora.
//
// Todo devuelve null cuando no hay nada que obedecer (servidor viejo, equipo sin config_json o paquete
// sin conectar). Quien lo usa cae a lo de siempre con null.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDb } from './database/db';

export const CLAVE_CONFIG_CONECTADOS = 'configConectados';

/** Paquetes conectados según la última bajada ([] si nunca llegó). */
export async function leerConfigConectados() {
  try {
    const l = JSON.parse((await AsyncStorage.getItem(CLAVE_CONFIG_CONECTADOS)) || '[]');
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

/**
 * Valores de `paquete` para la fila del equipo (SQLite, con config_json), o null.
 * `conectados` es la lista de leerConfigConectados(); función pura para probarla sin AsyncStorage.
 */
export function paqueteDe(equipo, paquete, conectados) {
  if (!equipo?.config_json || !Array.isArray(conectados) || !conectados.includes(paquete)) return null;
  try {
    const c = JSON.parse(equipo.config_json);
    const p = c && typeof c === 'object' ? c[paquete] : null;
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

/** Como paqueteDe, leyendo los paquetes conectados de AsyncStorage. */
export async function configPaquete(equipo, paquete) {
  return paqueteDe(equipo, paquete, await leerConfigConectados());
}

/** configPaquete buscando el equipo por placa en SQLite (null si la placa no está). */
export async function configPaquetePorPlaca(placa, paquete) {
  const db = await getDb();
  const eq = await db.getFirstAsync('SELECT config_json FROM equipos WHERE placa = ?', String(placa || '').trim().toUpperCase());
  return configPaquete(eq, paquete);
}

// ── Viajes ────────────────────────────────────────────────────────────────────

const NIVELES_FOTO = ['NO', 'OPCIONAL', 'OBLIGATORIA'];

/** Nivel de una foto del viaje: NO | OPCIONAL | OBLIGATORIA. Sin config o valor raro: OBLIGATORIA (como siempre). */
export function nivelFoto(viajes, campo) {
  const v = String(viajes?.[campo] ?? '').trim().toUpperCase();
  return NIVELES_FOTO.includes(v) ? v : 'OBLIGATORIA';
}

/** ¿El equipo puede iniciar viajes? Solo un "aplica: false" explícito lo impide. */
export function haceViajes(viajes) {
  return viajes?.aplica !== false;
}

/** ¿Pide cantidad? La config si trae el campo; si no, la columna del equipo (como antes). */
export function pideCantidad(viajes, equipo) {
  if (typeof viajes?.requiere_cantidad === 'boolean') return viajes.requiere_cantidad;
  return !!equipo?.requiere_cantidad;
}

/** ¿Se dibuja la ruta planeada con sus peajes? Solo un "false" explícito la oculta. */
export function muestraRutaPeajes(viajes) {
  return viajes?.mostrar_ruta_peajes !== false;
}

export const TEXTO_SIN_VIAJES = 'Este equipo no hace viajes';
export const AYUDA_SIN_VIAJES = 'Lo habilita el administrador en Configuración de activos.';
