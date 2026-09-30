// src/combustible.js · datos para validar un tanqueo SIN señal (sin interfaz: se prueba en Node,
// scripts/banco/probar_combustible.mjs). Reglas iguales a la PWA (app_combustible_logic.js) y al
// servidor (combustible_validacion.py), que siempre vuelve a validar y marca REVISAR sin bloquear.
//
// La PWA consulta /maestros/combustible/info-lectura con señal; la app NO: el token móvil solo entra
// a auth.RUTAS_MOVIL. Todo sale de la última bajada de /movil/maestros (v11) y de SQLite.
import { leerConfigCombustible } from './database/sync';

// El servidor valida con el rango del tipo por defecto (combustible_validacion.TIPO_POR_DEFECTO)
export const TIPO_POR_DEFECTO = 'DIESEL';
const MARGEN_TANQUE_POR_DEFECTO = 5;

/** ms → "YYYY-MM-DD HH:MM:SS" en Bogotá (UTC-5 fijo, sin horario de verano), sin depender de Intl. */
export function fechaHoraBogota(ms) {
  return new Date(ms - 5 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Momento de un tanqueo del celular: fecha_iso (con zona) o, en filas viejas, fecha (hora local). */
function msTanqueoLocal(t) {
  const ms = Date.parse(t.fecha_iso || '');
  if (Number.isFinite(ms)) return ms;
  return Date.parse(String(t.fecha || '').replace(' ', 'T'));
}

/**
 * Tanqueos del equipo HOY (Bogotá) para "¿Es un tanqueo nuevo?": el último según el servidor
 * (equipos.ultimo_tanqueo_*, ya en hora Bogotá) más los del celular (enviados o no, p. ej. sin
 * señal). Uno enviado vuelve también como ultimo_tanqueo en la siguiente bajada: se cuenta una
 * sola vez (misma hora y minuto, mismos galones).
 * → [{ hora: 'HH:MM', galones }] ordenados por hora.
 */
export function tanqueosDeHoy(ultimoServidor, locales = [], ahora = new Date()) {
  const hoy = fechaHoraBogota(ahora.getTime()).slice(0, 10);
  const vistos = new Map();
  const agregar = (fechaHora, galones) => {
    if (!fechaHora || fechaHora.slice(0, 10) !== hoy) return;
    const hora = fechaHora.slice(11, 16);
    const clave = `${hora}|${Math.round((Number(galones) || 0) * 1000)}`;
    if (!vistos.has(clave)) vistos.set(clave, { hora, galones: Number(galones) || 0 });
  };
  if (ultimoServidor?.fecha) agregar(String(ultimoServidor.fecha), ultimoServidor.galones);
  for (const t of locales) {
    const ms = msTanqueoLocal(t);
    if (Number.isFinite(ms)) agregar(fechaHoraBogota(ms), t.cantidad_galones);
  }
  return [...vistos.values()].sort((a, b) => a.hora.localeCompare(b.hora));
}

/** Rango {min, max, precio, fuente, muestras, dias} de la config, o null si no sirve. */
function rangoValido(r) {
  return r && Number.isFinite(Number(r.min)) && Number.isFinite(Number(r.max)) ? r : null;
}

/**
 * Todo lo que el formulario necesita para advertir antes de guardar.
 * Sin config de combustible (servidor viejo, nunca sincronizó): sin rango (solo el aviso de
 * precio muy bajo), margen 5 % y foto opcional: la pantalla queda como antes.
 * → { rango, capacidad, margen, fotoModo, hoy }
 */
export async function datosValidacion(db, placa) {
  const cfg = await leerConfigCombustible();
  const eq = await db.getFirstAsync(
    'SELECT capacidad_tanque_gal, ultimo_tanqueo_fecha, ultimo_tanqueo_galones FROM equipos WHERE placa = ?', placa
  );
  const locales = await db.getAllAsync(
    'SELECT fecha, fecha_iso, cantidad_galones FROM tanqueos_pendientes WHERE placa = ?', placa
  );
  const margen = Number(cfg?.margen_tanque_pct);
  return {
    rango: rangoValido(cfg?.rangos?.[TIPO_POR_DEFECTO]),
    capacidad: Number(eq?.capacidad_tanque_gal) > 0 ? Number(eq.capacidad_tanque_gal) : null,
    margen: Number.isFinite(margen) ? margen : MARGEN_TANQUE_POR_DEFECTO,
    fotoModo: ['RECOMENDADA', 'OBLIGATORIA'].includes(cfg?.foto_tiquete) ? cfg.foto_tiquete : 'OPCIONAL',
    hoy: tanqueosDeHoy(
      eq?.ultimo_tanqueo_fecha ? { fecha: eq.ultimo_tanqueo_fecha, galones: eq.ultimo_tanqueo_galones } : null,
      locales
    ),
  };
}
