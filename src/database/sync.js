import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDb } from './db';
import { fetchConTimeout, esErrorDeRed } from '../red';
import { guardarFallasDescargadas } from '../fallas';

// 'ok' | 'vacio' | 'sesion' | 'sin_red' | 'error'
export let ultimoMotivoSync = null;

let enCurso = null;

/**
 * Baja equipos, preguntas y categorías desde GET /movil/maestros.
 * v2 (viajes): también materiales, rutas con coordenadas, datos de carga de cada
 * equipo, fecha del último preoperacional y si la empresa usa preoperacional.
 * (Antes pedía /maestros/equipos/ y /maestros/categorias/, que no existen en el
 * servidor: la bajada fallaba siempre con 404.)
 *
 * v9 · fallas abiertas del preoperacional por equipo (src/fallas.js). Un servidor
 * viejo no las manda: la tabla local no se toca y la app funciona como antes.
 *
 * E6 · Si ya hay una bajada en curso, devuelve esa misma promesa en lugar de lanzar
 * otra transacción DELETE/INSERT en paralelo.
 */
export function sincronizarDatosMaestros(token, API_URL) {
  if (!enCurso) {
    enCurso = bajar(token, API_URL).finally(() => { enCurso = null; });
  }
  return enCurso;
}

async function bajar(token, API_URL) {
  try {
    if (!token) { ultimoMotivoSync = 'sesion'; return false; }

    const res = await fetchConTimeout(`${API_URL}/movil/maestros`, {
      headers: { Authorization: `Bearer ${token}` },
    }, 20000);
    if (res.status === 401) { ultimoMotivoSync = 'sesion'; return false; }
    if (!res.ok) { ultimoMotivoSync = 'error'; return false; }

    const data = await res.json();
    const eqArray = Array.isArray(data?.equipos) ? data.equipos : [];
    const pregArray = Array.isArray(data?.preguntas) ? data.preguntas : [];
    const catArray = Array.isArray(data?.categorias) ? data.categorias : [];
    // v2 · un servidor v1 no manda estas listas: quedan vacías y NO se borra lo local
    const matArray = Array.isArray(data?.materiales) ? data.materiales : [];
    const rutasArray = Array.isArray(data?.rutas) ? data.rutas : [];

    if (eqArray.length === 0 && pregArray.length === 0) {
      ultimoMotivoSync = 'vacio';
      return false;
    }

    const db = await getDb();

    // E8 · Placas con registros que aún no llegan al servidor (preoperacionales Y tanqueos).
    // Para ellas se conserva la lectura local si es mayor, para no retroceder el odómetro.
    const pend = await db.getAllAsync(`
      SELECT equipo_id AS placa FROM reportes_pendientes WHERE sync_status != 'synced'
      UNION
      SELECT placa FROM tanqueos_pendientes WHERE sync_status != 'synced'
    `);
    const conPendientes = new Set(pend.map((p) => (p.placa || '').trim().toUpperCase()));
    // Placas con preoperacionales sin enviar: sus fallas locales van por delante del servidor
    const preopPend = await db.getAllAsync(
      "SELECT DISTINCT equipo_id AS placa FROM reportes_pendientes WHERE sync_status != 'synced'"
    );
    const conPreopPendiente = new Set(preopPend.map((p) => (p.placa || '').trim().toUpperCase()));
    const locales = {};
    (await db.getAllAsync('SELECT placa, ultimo_odometro, ultimo_horometro, estado FROM equipos'))
      .forEach((e) => { locales[e.placa] = e; });

    await db.withExclusiveTransactionAsync(async (tx) => {
      // R2 · Cada tabla se reemplaza SOLO si el servidor mandó datos. Una lista vacía
      // (error del servidor, preguntas desactivadas por error) ya no borra el checklist local.
      if (catArray.length) {
        await tx.runAsync('DELETE FROM categorias');
        const st = await tx.prepareAsync('INSERT INTO categorias (id, nombre) VALUES (?, ?)');
        try { for (const c of catArray) await st.executeAsync(c.id, c.nombre || ''); }
        finally { await st.finalizeAsync(); }
      }

      if (pregArray.length) {
        await tx.runAsync('DELETE FROM preguntas');
        const st = await tx.prepareAsync(
          'INSERT INTO preguntas (id, categoria, pregunta, es_critica, tipo_activo_id) VALUES (?, ?, ?, ?, ?)'
        );
        try {
          for (const p of pregArray) {
            if (p.activo === false) continue;
            await st.executeAsync(p.id, p.categoria || 'GENERAL', p.pregunta || '', p.es_critica ? 1 : 0, p.tipo_activo_id ?? null);
          }
        } finally { await st.finalizeAsync(); }
      }

      if (eqArray.length) {
        await tx.runAsync('DELETE FROM equipos');
        const st = await tx.prepareAsync(
          `INSERT OR REPLACE INTO equipos (id, placa, tipo, estado, ultimo_odometro, ultimo_horometro,
             tiene_horometro, tiene_odometro, tipo_activo_id, capacidad_tanque_gal, meta_rendimiento,
             requiere_cantidad, capacidad_m3, capacidad_ton, ultimo_preop_fecha)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        try {
          for (const eq of eqArray) {
            const placa = (eq.placa || '').trim().toUpperCase();
            if (!placa) continue;
            const loc = conPendientes.has(placa) ? locales[placa] : null;

            const odo = Math.max(Number(eq.ultimo_odometro) || 0, loc?.ultimo_odometro || 0);
            const horo = Math.max(Number(eq.ultimo_horometro) || 0, loc?.ultimo_horometro || 0);
            const estado = loc?.estado || eq.estado || 'ACTIVO';
            const tieneHoro = eq.tiene_horometro == null ? null : (eq.tiene_horometro ? 1 : 0);
            const tieneOdo = eq.tiene_odometro == null ? null : (eq.tiene_odometro ? 1 : 0);

            await st.executeAsync(
              eq.id, placa, eq.tipo || 'VEHICULO', estado, odo, horo, tieneHoro, tieneOdo,
              eq.tipo_activo_id ?? null, eq.capacidad_tanque_gal ?? null, eq.meta_rendimiento ?? null,
              eq.requiere_cantidad == null ? null : (eq.requiere_cantidad ? 1 : 0),
              eq.capacidad_m3 ?? null, eq.capacidad_ton ?? null, eq.ultimo_preop_fecha ?? null
            );
          }
        } finally { await st.finalizeAsync(); }
      }

      // v9 · fallas abiertas (solo si el servidor las manda)
      if (eqArray.length) await guardarFallasDescargadas(tx, eqArray, conPreopPendiente);

      // v2 · materiales y rutas: misma regla R2 (lista vacía = no se toca lo local)
      if (matArray.length) {
        await tx.runAsync('DELETE FROM materiales');
        const st = await tx.prepareAsync('INSERT OR REPLACE INTO materiales (id, nombre, unidad) VALUES (?, ?, ?)');
        try { for (const m of matArray) await st.executeAsync(m.id, m.nombre || '', m.unidad || 'M3'); }
        finally { await st.finalizeAsync(); }
      }

      if (rutasArray.length) {
        await tx.runAsync('DELETE FROM rutas');
        const st = await tx.prepareAsync(
          `INSERT OR REPLACE INTO rutas (id, nombre, distancia_km, origen, destino,
             origen_lat, origen_lon, destino_lat, destino_lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        try {
          for (const r of rutasArray) {
            await st.executeAsync(
              r.id, r.nombre || '', r.distancia_km ?? null, r.origen || '', r.destino || '',
              r.origen_lat ?? null, r.origen_lon ?? null, r.destino_lat ?? null, r.destino_lon ?? null
            );
          }
        } finally { await st.finalizeAsync(); }
      }
    });

    // v2 · la empresa exige (o no) preoperacional antes de iniciar un viaje
    if (typeof data?.usa_preoperacional === 'boolean') {
      await AsyncStorage.setItem('usaPreoperacional', data.usa_preoperacional ? '1' : '0');
    }
    // v9 · autogestión de fallas de la empresa (un servidor viejo no la manda: queda como estaba)
    if (typeof data?.usa_autogestion_fallas === 'boolean') {
      await AsyncStorage.setItem('usaAutogestionFallas', data.usa_autogestion_fallas ? '1' : '0');
    }

    const a = new Date();
    const min = a.getMinutes() < 10 ? `0${a.getMinutes()}` : a.getMinutes();
    await AsyncStorage.setItem('lastSyncDate', `${a.getDate()}/${a.getMonth() + 1}/${a.getFullYear()} ${a.getHours()}:${min}`);

    ultimoMotivoSync = 'ok';
    return true;
  } catch (e) {
    ultimoMotivoSync = esErrorDeRed(e) ? 'sin_red' : 'error';
    if (ultimoMotivoSync === 'error') console.warn('Bajada de maestros falló:', e?.message || e);
    return false;
  }
}
