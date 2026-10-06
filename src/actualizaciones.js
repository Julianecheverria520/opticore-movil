// src/actualizaciones.js · actualizaciones OTA (EAS Update)
//
// app.json tiene `updates.checkAutomatically: "NEVER"`: la app nativa no revisa sola al arrancar
// (no sabe si hay un viaje en curso). La revisión se hace aquí, desde Home:
//   - solo con señal y SIN viaje EN_CURSO en este celular;
//   - descarga en segundo plano, sin alertas ni bloqueos;
//   - NUNCA recarga: lo descargado entra en el siguiente arranque en frío.
// La tarea del GPS en segundo plano no pasa por Home, así que nunca descarga nada.
import NetInfo from '@react-native-community/netinfo';
import * as Updates from 'expo-updates';
import { viajeEnCurso } from './viajes';

// Al volver al frente no se revisa más de una vez cada 30 min
const INTERVALO_MS = 30 * 60 * 1000;
// Con señal débil la consulta puede quedarse colgada: se abandona (la descarga sigue sola si ya empezó)
const LIMITE_CONSULTA_MS = 15000;

let revisando = false;
let ultimaRevision = 0;

function conLimite(promesa, ms) {
  return Promise.race([
    promesa,
    new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('tiempo agotado')), ms)),
  ]);
}

/**
 * Revisa y descarga una actualización si se puede. Nunca lanza error.
 * Devuelve 'descargada' | 'al_dia' | 'omitida' | 'error'.
 */
export async function revisarActualizacion({ forzar = false } = {}) {
  // En desarrollo (Metro / development build) expo-updates está apagado
  if (__DEV__ || !Updates.isEnabled) return 'omitida';
  if (revisando) return 'omitida';
  if (!forzar && Date.now() - ultimaRevision < INTERVALO_MS) return 'omitida';
  revisando = true;
  try {
    if (await viajeEnCurso()) return 'omitida';
    const red = await NetInfo.fetch();
    if (!red.isConnected || red.isInternetReachable === false) return 'omitida';

    ultimaRevision = Date.now();
    const r = await conLimite(Updates.checkForUpdateAsync(), LIMITE_CONSULTA_MS);
    if (!r.isAvailable) return 'al_dia';
    // Se vuelve a mirar: el viaje pudo empezar mientras se consultaba
    if (await viajeEnCurso()) return 'omitida';
    await Updates.fetchUpdateAsync();
    return 'descargada';
  } catch (e) {
    console.log('Actualización OTA no disponible:', e?.message || e);
    return 'error';
  } finally {
    revisando = false;
  }
}

/** "v1.4.0 · APK" o "v1.4.0 · act. 3f2a9c1b (06-oct)": qué JS está corriendo en este celular. */
export function describirVersion() {
  if (__DEV__) return 'desarrollo';
  // Con la política "appVersion", runtimeVersion = version de app.json del APK instalado
  const version = Updates.runtimeVersion ? `v${Updates.runtimeVersion}` : 'v?';
  if (!Updates.isEnabled) return `${version} · sin OTA`;
  if (Updates.isEmbeddedLaunch || !Updates.updateId) {
    return `${version} · APK${Updates.isEmergencyLaunch ? ' (recuperada)' : ''}`;
  }
  const id = Updates.updateId.slice(0, 8);
  const f = Updates.createdAt;
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const fecha = f ? ` (${String(f.getDate()).padStart(2, '0')}-${meses[f.getMonth()]})` : '';
  return `${version} · act. ${id}${fecha}`;
}
