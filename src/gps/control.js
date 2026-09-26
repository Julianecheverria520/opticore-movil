// src/gps/control.js · iniciar / detener / reanudar el GPS del viaje
import * as Location from 'expo-location';
import { Platform, PermissionsAndroid } from 'react-native';

import { viajeEnCurso } from '../viajes';

export const TAREA_GPS = 'opticore-gps';

// Frecuencia acordada (paso 5 del plan), confirmada contra expo-location 57 en Android:
// timeInterval y distanceInterval aplican siempre; deferred* solo con la app en segundo plano
// y exige AMBAS condiciones (60 s y 100 m) antes de entregar el lote.
export function opcionesGPS(placa) {
  return {
    accuracy: Location.Accuracy.High,
    distanceInterval: 30,
    timeInterval: 15000,
    deferredUpdatesInterval: 60000,
    deferredUpdatesDistance: 100,
    foregroundService: {
      notificationTitle: 'Viaje en curso',
      notificationBody: `${placa} · registrando recorrido`,
      killServiceOnDestroy: false,
    },
  };
}

// Android 13+ (API 33): sin este permiso el servicio de ubicación funciona igual, pero su
// aviso "Viaje en curso" no aparece en la barra y el conductor no ve que se está registrando.
const PERMISO_NOTIFICACIONES = 'android.permission.POST_NOTIFICATIONS';
const pideNotificaciones = () => Platform.OS === 'android' && Number(Platform.Version) >= 33;

/** Pide el permiso de notificaciones (solo Android 13+). Nunca bloquea el viaje. */
export async function pedirPermisoNotificaciones() {
  if (!pideNotificaciones()) return true;
  try {
    return (await PermissionsAndroid.request(PERMISO_NOTIFICACIONES)) === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

/** Estado de permisos y de la tarea. */
export async function estadoGPS() {
  const [fg, bg, corriendo, servicios, notificaciones] = await Promise.all([
    Location.getForegroundPermissionsAsync().catch(() => ({ status: 'undetermined' })),
    Location.getBackgroundPermissionsAsync().catch(() => ({ status: 'undetermined' })),
    Location.hasStartedLocationUpdatesAsync(TAREA_GPS).catch(() => false),
    Location.hasServicesEnabledAsync().catch(() => true),
    pideNotificaciones() ? PermissionsAndroid.check(PERMISO_NOTIFICACIONES).catch(() => true) : true,
  ]);
  return {
    permisoPrimerPlano: fg.status === 'granted',
    permisoSegundoPlano: bg.status === 'granted',
    corriendo: !!corriendo,
    ubicacionActivada: !!servicios,
    notificaciones: !!notificaciones,
  };
}

/**
 * Arranca el GPS del viaje. Debe llamarse con la app ABIERTA (Android no deja crear
 * un servicio de ubicación desde segundo plano sin "Permitir todo el tiempo").
 * Devuelve { ok, motivo }.
 */
export async function iniciarGPS(placa) {
  try {
    let fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== 'granted') fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return { ok: false, motivo: 'sin_permiso' };

    if (await Location.hasStartedLocationUpdatesAsync(TAREA_GPS)) return { ok: true, motivo: 'ya_corriendo' };
    await Location.startLocationUpdatesAsync(TAREA_GPS, opcionesGPS(placa));
    return { ok: true, motivo: 'iniciado' };
  } catch (e) {
    console.warn('No se pudo iniciar el GPS:', e?.message || e);
    return { ok: false, motivo: 'error', error: e?.message || String(e) };
  }
}

export async function detenerGPS() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(TAREA_GPS)) await Location.stopLocationUpdatesAsync(TAREA_GPS);
  } catch (e) {
    console.warn('No se pudo detener el GPS:', e?.message || e);
  }
}

/**
 * Al abrir la app: si hay un viaje EN_CURSO y la tarea no está corriendo (reinicio del
 * celular, cierre forzado), la vuelve a arrancar. Si no hay viaje, apaga una tarea huérfana.
 */
export async function asegurarGPS() {
  const viaje = await viajeEnCurso();
  if (!viaje) { await detenerGPS(); return { viaje: null }; }
  const r = await iniciarGPS(viaje.placa);
  return { viaje, ...r };
}
