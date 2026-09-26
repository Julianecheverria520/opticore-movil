// src/gps/tarea.js · tarea 'opticore-gps'
// Se importa al inicio de index.js: TaskManager.defineTask tiene que ejecutarse al cargar
// el JavaScript, también cuando Android despierta la app sin interfaz para entregar puntos.
// Corre SIN React: solo SQLite (getDb) y la cola de envío.
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { TAREA_GPS } from './control';
import { guardarUbicaciones } from './puntos';
import { enviarPendientes } from '../database/syncUp';

const INTERVALO_SUBIDA_MS = 60000;

/** Sube la cola como máximo cada 60 s, sin bloquear la tarea (no se espera la respuesta). */
export async function subirSiToca() {
  try {
    const ultima = Number(await AsyncStorage.getItem('gpsUltimaSubida')) || 0;
    if (Date.now() - ultima < INTERVALO_SUBIDA_MS) return;
    await AsyncStorage.setItem('gpsUltimaSubida', String(Date.now()));
    enviarPendientes().catch(() => {});
  } catch { /* la subida nunca debe romper la captura */ }
}

TaskManager.defineTask(TAREA_GPS, async ({ data, error }) => {
  if (error) {
    console.warn('Tarea GPS:', error.message || error);
    return;
  }
  try {
    const r = await guardarUbicaciones(data?.locations || []);
    if (!r.viaje) {
      // No hay viaje en curso (se finalizó): la tarea no debe seguir gastando batería
      if (await Location.hasStartedLocationUpdatesAsync(TAREA_GPS)) await Location.stopLocationUpdatesAsync(TAREA_GPS);
      return;
    }
    subirSiToca();
  } catch (e) {
    console.warn('Tarea GPS, error guardando puntos:', e?.message || e);
  }
});
