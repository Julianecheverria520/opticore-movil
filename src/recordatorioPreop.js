// src/recordatorioPreop.js · Recordatorio del preoperacional: notificación LOCAL programada en el celular.
//
// La empresa configura en la web (Mantenimiento › Configuración de Inspección) hora, días y textos;
// llegan en /movil/maestros como "recordatorio_preop" = { activo, hora "HH:MM", dias [1..7] (1 = lunes),
// titulo, mensaje } y sync.js los guarda en AsyncStorage. Con cada apertura, sincronización, cambio de
// equipo y preoperacional guardado se reprograman los avisos de los próximos 7 días como notificaciones
// de fecha fija: llegan aunque el operador no abra la app en días, sin señal, y el de hoy se salta si
// ya hay preoperacional (aunque no se haya enviado).
//
// expo-notifications es nativo (1.5.0): se carga con import() como en sesion.js; sin el módulo, o si
// algo falla, no se programa nada y la pantalla sigue (console.warn). Nada de aquí lanza errores.
// La parte de fechas es pura: scripts/banco/probar_recordatorio_preop.mjs.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Platform } from 'react-native';
import { getDb } from './database/db';
import { leerToken } from './sesion';

export const CLAVE_RECORDATORIO = 'recordatorioPreop';
const CLAVE_EQUIPO = 'equipoRecordado'; // la misma de HomeScreen
const CLAVE_PERMISO_PEDIDO = 'recordatorioPermisoPedido';
const PREFIJO = 'recordatorio-preop-'; // identificador propio: no toca la notificación del GPS
const CANAL = 'recordatorios';
const DIAS_ADELANTE = 7;
export const TIPO = 'recordatorio_preop'; // content.data.tipo, para reconocer el toque

export const DEFECTO = Object.freeze({
  activo: false,
  hora: '09:00',
  dias: [1, 2, 3, 4, 5, 6],
  titulo: 'Preoperacional pendiente',
  mensaje: 'Aún no has hecho el preoperacional de hoy. Entra a OptiCore y hazlo antes de operar.',
});

// ── Funciones puras ─────────────────────────────────────────────────────────

/** Config completa a partir de lo guardado; lo que falte o venga dañado toma el valor por defecto. */
export function normalizarConfig(c) {
  if (!c || typeof c !== 'object') return { ...DEFECTO };
  const hora = typeof c.hora === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(c.hora) ? c.hora : DEFECTO.hora;
  const dias = Array.isArray(c.dias)
    ? [...new Set(c.dias.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b)
    : DEFECTO.dias;
  const texto = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);
  return {
    activo: c.activo === true,
    hora,
    dias,
    titulo: texto(c.titulo, DEFECTO.titulo),
    mensaje: texto(c.mensaje, DEFECTO.mensaje),
  };
}

/** "YYYY-MM-DD" en la hora local del celular. */
export function fechaLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Avisos a programar: [{ dia: "YYYY-MM-DD", fecha: Date }] de hoy y los 6 días siguientes que estén en
 * `dias`, a la hora local de `config.hora`. Hoy se salta si la hora ya pasó o si `hechoHoy`.
 */
export function avisosAProgramar(config, ahora, hechoHoy) {
  const c = normalizarConfig(config);
  if (!c.activo) return [];
  const [h, m] = c.hora.split(':').map(Number);
  const res = [];
  for (let i = 0; i < DIAS_ADELANTE; i++) {
    const f = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + i, h, m, 0, 0);
    const iso = f.getDay() === 0 ? 7 : f.getDay(); // 1 = lunes … 7 = domingo
    if (!c.dias.includes(iso)) continue;
    if (i === 0 && (hechoHoy || f <= ahora)) continue;
    res.push({ dia: fechaLocal(f), fecha: f });
  }
  return res;
}

// ── Con módulos de la app ───────────────────────────────────────────────────

let _N; // undefined = sin intentar · null = no disponible
async function notif() {
  if (_N === undefined) {
    try {
      _N = await import('expo-notifications');
    } catch (e) {
      console.warn('expo-notifications no está en este build; no hay recordatorio:', e?.message || e);
      _N = null;
    }
  }
  return _N;
}

export async function leerConfigRecordatorio() {
  try {
    return normalizarConfig(JSON.parse((await AsyncStorage.getItem(CLAVE_RECORDATORIO)) || 'null'));
  } catch {
    return { ...DEFECTO };
  }
}

/** ¿Hay preoperacional de hoy? En este celular (enviado o no) o, según los maestros, el del equipo recordado. */
export async function preopHechoHoy(ahora = new Date()) {
  const hoy = fechaLocal(ahora);
  const db = await getDb();
  const r = await db.getFirstAsync(
    `SELECT COUNT(*) AS n FROM reportes_pendientes
      WHERE substr(fecha_iso, 1, 10) = ? OR (fecha_iso IS NULL AND date(fecha) = ?)`,
    hoy, hoy
  );
  if ((r?.n || 0) > 0) return true;
  const placa = await AsyncStorage.getItem(CLAVE_EQUIPO);
  if (!placa) return false;
  const eq = await db.getFirstAsync('SELECT ultimo_preop_fecha FROM equipos WHERE placa = ?', placa);
  return String(eq?.ultimo_preop_fecha || '').slice(0, 10) === hoy;
}

/** Ajustes que se hacen una vez por arranque: cómo se muestra con la app abierta y el canal de Android. */
let _configurado = false;
async function configurar(N) {
  if (_configurado) return;
  N.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true,
    }),
  });
  if (Platform.OS === 'android') {
    await N.setNotificationChannelAsync(CANAL, { name: 'Recordatorios', importance: N.AndroidImportance.HIGH });
  }
  _configurado = true;
}

/** Llamar al abrir la app: muestra el aviso aunque la app esté abierta. */
export async function prepararNotificaciones() {
  try {
    const N = await notif();
    if (N) await configurar(N);
  } catch (e) {
    console.warn('Recordatorio: no se pudo preparar:', e?.message || e);
  }
}

async function cancelarPropias(N) {
  const todas = await N.getAllScheduledNotificationsAsync();
  for (const n of todas || []) {
    const id = n?.identifier ?? n?.request?.identifier;
    if (typeof id === 'string' && id.startsWith(PREFIJO)) await N.cancelScheduledNotificationAsync(id);
  }
}

async function hacerReprogramacion() {
  const N = await notif();
  if (!N) return;
  await configurar(N);
  await cancelarPropias(N);

  const c = await leerConfigRecordatorio();
  if (!c.activo) return;
  if ((await AsyncStorage.getItem('usaPreoperacional')) === '0') return;
  if (!(await leerToken())) return;

  const ahora = new Date();
  const hecho = await preopHechoHoy(ahora);
  // Si ya llegó el aviso de hoy y después se hizo el preoperacional, se quita de la barra
  if (hecho) { try { await N.dismissNotificationAsync(PREFIJO + fechaLocal(ahora)); } catch { /* no estaba */ } }

  for (const a of avisosAProgramar(c, ahora, hecho)) {
    await N.scheduleNotificationAsync({
      identifier: PREFIJO + a.dia,
      content: { title: c.titulo, body: c.mensaje, data: { tipo: TIPO } },
      trigger: { type: N.SchedulableTriggerInputTypes.DATE, date: a.fecha, channelId: CANAL },
    });
  }
}

// Una a la vez: varias pantallas pueden pedirlo casi juntas (sincronización + volver al frente)
let cola = Promise.resolve();
/** Cancela los avisos del recordatorio y programa los de los próximos 7 días. Nunca lanza. */
export function reprogramarRecordatorios() {
  cola = cola.then(hacerReprogramacion).catch((e) => {
    console.warn('Recordatorio: no se pudo reprogramar:', e?.message || e);
  });
  return cola;
}

/** Al cerrar sesión: quita todos los avisos del recordatorio. Nunca lanza. */
export function cancelarRecordatorios() {
  cola = cola.then(async () => {
    const N = await notif();
    if (N) await cancelarPropias(N);
  }).catch((e) => console.warn('Recordatorio: no se pudo cancelar:', e?.message || e));
  return cola;
}

/**
 * Android 13+: pide el permiso de notificaciones UNA sola vez, con un texto previo, si la empresa tiene
 * el recordatorio activo. Si el operador dice que no (aquí o en el diálogo del sistema), no se insiste.
 */
export async function pedirPermisoRecordatorio() {
  try {
    if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return;
    if ((await AsyncStorage.getItem(CLAVE_PERMISO_PEDIDO)) === '1') return;
    const c = await leerConfigRecordatorio();
    if (!c.activo || (await AsyncStorage.getItem('usaPreoperacional')) === '0') return;
    const N = await notif();
    if (!N) return;
    const p = await N.getPermissionsAsync();
    if (p.granted || p.canAskAgain === false) {
      await AsyncStorage.setItem(CLAVE_PERMISO_PEDIDO, '1');
      return;
    }
    const seguir = await new Promise((resolve) => {
      Alert.alert(
        'Recordatorio del preoperacional',
        `Te avisaremos si a las ${c.hora} no has hecho el preoperacional.`,
        [
          { text: 'Ahora no', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Continuar', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) }
      );
    });
    await AsyncStorage.setItem(CLAVE_PERMISO_PEDIDO, '1');
    if (seguir) await N.requestPermissionsAsync();
  } catch (e) {
    console.warn('Recordatorio: no se pudo pedir el permiso:', e?.message || e);
  }
}

/**
 * Toques en el aviso del recordatorio: `alTocar()` se llama al tocarlo con la app abierta o en segundo
 * plano y, al arrancar en frío desde el aviso, una vez con el último toque. Devuelve la función que deja
 * de escuchar.
 */
export function escucharToques(alTocar) {
  let sub = null;
  let activo = true;
  const vistos = new Set(); // en frío el mismo toque puede llegar por el listener y por el último toque
  const atender = (r, N) => {
    if (!activo || r?.notification?.request?.content?.data?.tipo !== TIPO) return;
    const clave = `${r.notification.request.identifier}|${r.notification.date}`;
    if (vistos.has(clave)) return;
    vistos.add(clave);
    N.clearLastNotificationResponseAsync?.().catch(() => {});
    alTocar();
  };
  (async () => {
    try {
      const N = await notif();
      if (!N || !activo) return;
      sub = N.addNotificationResponseReceivedListener((r) => atender(r, N));
      atender(await N.getLastNotificationResponseAsync(), N);
    } catch (e) {
      console.warn('Recordatorio: no se pudo escuchar los toques:', e?.message || e);
    }
  })();
  return () => { activo = false; sub?.remove?.(); };
}
