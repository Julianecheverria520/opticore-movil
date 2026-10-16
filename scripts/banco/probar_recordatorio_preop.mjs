// Recordatorio del preoperacional (src/recordatorioPreop.js):
//   node --import ./scripts/banco/registro.mjs scripts/banco/probar_recordatorio_preop.mjs
// - Funciones puras: config normalizada, días 1 = lunes … 7 = domingo, hoy se salta (hora pasada / hecho).
// - Bajada: "recordatorio_preop" a AsyncStorage; un servidor viejo no lo borra.
// - preopHechoHoy: fila de hoy en reportes_pendientes (cualquier estado) o ultimo_preop_fecha del equipo recordado.
// - reprogramar: solo toca sus identificadores (no los del GPS); apagado, sin preoperacional o sin sesión → nada.
// - Permiso: se pide una sola vez y solo con el recordatorio activo. Toque: abre una sola vez.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RAIZ = new URL('../../', import.meta.url);
const src = (r) => import(new URL(`src/${r}`, RAIZ).href);
const tmp = mkdtempSync(join(tmpdir(), 'banco-recordatorio-'));
let ok = 0;
const chk = (c, m) => { assert.ok(c, m); ok++; console.log('  ✔', m); };
const titulo = (t) => console.log(`\n${t}`);

try {
  globalThis.DB_PATH = join(tmp, 'opticore.db');
  const R = await src('recordatorioPreop.js');
  const N = await import('expo-notifications');
  const AS = (await import('@react-native-async-storage/async-storage')).default;
  const { guardarToken } = await src('sesion.js');
  const { getDb } = await src('database/db.js');
  const { sincronizarDatosMaestros } = await src('database/sync.js');
  const db = await getDb();

  // ── 1. Funciones puras ───────────────────────────────────────────────────
  titulo('1. Config y fechas');
  const d = R.normalizarConfig(null);
  chk(d.activo === false && d.hora === '09:00' && d.dias.join() === '1,2,3,4,5,6', 'sin config: apagado, 09:00, lunes a sábado');
  const raro = R.normalizarConfig({ activo: 'si', hora: '25:00', dias: [7, 7, 0, 3, '2'], titulo: '  ', mensaje: 5 });
  chk(raro.activo === false && raro.hora === '09:00' && raro.dias.join() === '2,3,7', 'valores raros: por defecto; días válidos sin repetir y ordenados');
  chk(raro.titulo === R.DEFECTO.titulo && raro.mensaje === R.DEFECTO.mensaje, 'textos vacíos: los de por defecto');

  const lunes8 = new Date(2026, 9, 12, 8, 0); // lunes 12-oct-2026, 8:00
  chk(lunes8.getDay() === 1, '(el 12-oct-2026 es lunes)');
  const cfg = { activo: true, hora: '09:00', dias: [1, 2, 3, 4, 5, 6] };
  let a = R.avisosAProgramar(cfg, lunes8, false);
  chk(a.length === 6 && a[0].dia === '2026-10-12' && a[5].dia === '2026-10-17', 'lunes 8:00: hoy y hasta el sábado (6 avisos, sin domingo)');
  chk(a[0].fecha.getHours() === 9 && a[0].fecha.getMinutes() === 0, 'a las 9:00 locales');
  a = R.avisosAProgramar(cfg, lunes8, true);
  chk(a.length === 5 && a[0].dia === '2026-10-13', 'con preoperacional hoy: empieza mañana');
  a = R.avisosAProgramar(cfg, new Date(2026, 9, 12, 9, 0), false);
  chk(a[0].dia === '2026-10-13', 'a las 9:00 en punto: el de hoy ya pasó');
  a = R.avisosAProgramar({ ...cfg, dias: [7] }, new Date(2026, 9, 12, 8, 0), false);
  chk(a.length === 1 && a[0].dia === '2026-10-18', 'solo domingo (7) → el domingo 18');
  chk(R.avisosAProgramar({ ...cfg, activo: false }, lunes8, false).length === 0, 'apagado: ninguno');
  a = R.avisosAProgramar({ ...cfg, hora: '06:30', dias: [1, 2, 3, 4, 5, 6, 7] }, new Date(2026, 9, 31, 7, 0), false);
  chk(a.length === 6 && a[0].dia === '2026-11-01' && a[5].dia === '2026-11-06', 'cambio de mes: 1 al 6 de noviembre');

  // ── 2. Bajada ────────────────────────────────────────────────────────────
  titulo('2. Bajada de maestros');
  let respuesta;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => respuesta });
  const base = { equipos: [{ id: 7, placa: 'JMU965' }], preguntas: [{ id: 1, pregunta: 'Frenos' }], usa_preoperacional: true };
  respuesta = base;
  await sincronizarDatosMaestros('tok', 'http://x');
  chk((await R.leerConfigRecordatorio()).activo === false, 'servidor sin la clave y nunca llegó: apagado');
  const todosLosDias = [1, 2, 3, 4, 5, 6, 7];
  respuesta = { ...base, recordatorio_preop: { activo: true, hora: '23:59', dias: todosLosDias, titulo: 'T', mensaje: 'M' } };
  await sincronizarDatosMaestros('tok', 'http://x');
  const guardada = await R.leerConfigRecordatorio();
  chk(guardada.activo && guardada.hora === '23:59' && guardada.titulo === 'T', 'clave guardada en AsyncStorage');
  respuesta = base;
  await sincronizarDatosMaestros('tok', 'http://x');
  chk((await R.leerConfigRecordatorio()).hora === '23:59', 'servidor viejo después: queda la guardada');

  // ── 3. preopHechoHoy ─────────────────────────────────────────────────────
  titulo('3. preopHechoHoy');
  const hoy = R.fechaLocal(new Date());
  chk(await R.preopHechoHoy() === false, 'sin nada: no');
  await db.runAsync(`INSERT INTO reportes_pendientes (equipo_id, fecha, fecha_iso, sync_status)
                     VALUES ('ABC123', datetime('now','-2 days','localtime'), '2000-01-01T08:00:00-05:00', 'synced')`);
  chk(await R.preopHechoHoy() === false, 'uno de otro día: no');
  await AS.setItem('equipoRecordado', 'JMU965');
  await db.runAsync('UPDATE equipos SET ultimo_preop_fecha = ? WHERE placa = ?', hoy, 'JMU965');
  chk(await R.preopHechoHoy() === true, 'ultimo_preop_fecha = hoy del equipo recordado (otro celular): sí');
  await db.runAsync('UPDATE equipos SET ultimo_preop_fecha = ? WHERE placa = ?', '2000-01-01', 'JMU965');
  chk(await R.preopHechoHoy() === false, 'ultimo_preop_fecha viejo: no');

  // ── 4. Reprogramar ───────────────────────────────────────────────────────
  titulo('4. reprogramarRecordatorios');
  N.programadas.set('gps-viaje', { identifier: 'gps-viaje', content: {}, trigger: null });
  await R.reprogramarRecordatorios();
  chk(N.programadas.size === 1, 'sin sesión: nada (y la del GPS sigue)');
  await guardarToken('tok');
  await R.reprogramarRecordatorios();
  const propias = () => [...N.programadas.keys()].filter((k) => k.startsWith('recordatorio-preop-'));
  chk(propias().length === 7 && propias()[0] === `recordatorio-preop-${hoy}`, '23:59 todos los días: hoy y 6 más');
  const una = N.programadas.get(`recordatorio-preop-${hoy}`);
  chk(una.trigger.type === 'date' && una.trigger.channelId === 'recordatorios' && una.content.title === 'T'
    && una.content.data.tipo === 'recordatorio_preop', 'fecha fija, canal Recordatorios, título y tipo');
  chk(N.canales.recordatorios?.importance === N.AndroidImportance.HIGH && N.canales.recordatorios.name === 'Recordatorios',
    'canal "Recordatorios" con importancia alta');
  chk(N.estado.handler != null, 'handler para mostrarlo con la app abierta');
  await R.reprogramarRecordatorios();
  chk(propias().length === 7 && N.programadas.has('gps-viaje'), 'reprogramar otra vez: sin duplicados; la del GPS intacta');

  await db.runAsync(`INSERT INTO reportes_pendientes (equipo_id, fecha, fecha_iso, sync_status)
                     VALUES ('OTRA1', datetime('now','localtime'), ?, 'pending')`, `${hoy}T07:00:00-05:00`);
  await R.reprogramarRecordatorios();
  chk(propias().length === 6 && !N.programadas.has(`recordatorio-preop-${hoy}`), 'preoperacional de hoy SIN enviar: se salta hoy');
  chk(N.quitadas.includes(`recordatorio-preop-${hoy}`), 'y se quita de la barra el aviso de hoy si ya había llegado');

  await AS.setItem('usaPreoperacional', '0');
  await R.reprogramarRecordatorios();
  chk(propias().length === 0, 'la empresa no usa preoperacional: ninguno');
  await AS.setItem('usaPreoperacional', '1');
  await R.reprogramarRecordatorios();
  chk(propias().length === 6, 'vuelve a usarlo: se programan otra vez');
  await R.cancelarRecordatorios();
  chk(propias().length === 0 && N.programadas.has('gps-viaje'), 'cerrar sesión: cancela solo los del recordatorio');

  // Falla del módulo nativo: no sale el error, y la siguiente vez vuelve a funcionar
  const avisos = [];
  const warn = console.warn;
  console.warn = (...x) => avisos.push(x.join(' '));
  try {
    N.estado.fallar = true;
    await R.reprogramarRecordatorios();
  } finally { console.warn = warn; N.estado.fallar = false; }
  chk(avisos.some((t) => t.includes('Recordatorio')), 'si el módulo falla: console.warn y sigue (no lanza)');
  await R.reprogramarRecordatorios();
  chk(propias().length === 6, 'la siguiente reprogramación funciona');
  await R.cancelarRecordatorios();

  // ── 5. Permiso ───────────────────────────────────────────────────────────
  titulo('5. Permiso (Android 13+)');
  let alertas = 0;
  globalThis.ALERTA = (t, texto, botones) => { alertas++; chk(texto.includes('23:59'), 'texto previo con la hora de la empresa'); return botones[1]; };
  await AS.setItem(R.CLAVE_RECORDATORIO, JSON.stringify({ activo: false }));
  await R.pedirPermisoRecordatorio();
  chk(alertas === 0 && N.estado.pedidos === 0, 'recordatorio apagado: no se pide');
  await AS.setItem(R.CLAVE_RECORDATORIO, JSON.stringify({ activo: true, hora: '23:59', dias: todosLosDias }));
  await R.pedirPermisoRecordatorio();
  chk(alertas === 1 && N.estado.pedidos === 1, 'activo: texto previo y diálogo del sistema');
  N.estado.permiso = { granted: false, canAskAgain: true }; // lo negó después en Ajustes
  await R.pedirPermisoRecordatorio();
  chk(alertas === 1 && N.estado.pedidos === 1, 'segunda vez: no se insiste');

  // ── 6. Toque ─────────────────────────────────────────────────────────────
  titulo('6. Toque en el aviso');
  const resp = (tipo, id = 'recordatorio-preop-x') => ({ notification: { date: 1, request: { identifier: id, content: { data: { tipo } } } } });
  N.estado.ultimo = resp('recordatorio_preop'); // arranque en frío desde el aviso
  let toques = 0;
  const dejar = R.escucharToques(() => { toques++; });
  await new Promise((r) => setTimeout(r, 20));
  N.estado.oyentes.forEach((f) => f(resp('recordatorio_preop'))); // el mismo toque llega también por el listener
  chk(toques === 1, 'arranque en frío: abre una sola vez');
  N.estado.oyentes.forEach((f) => f(resp('otra_cosa', 'gps')));
  chk(toques === 1, 'otra notificación: no abre nada');
  N.estado.oyentes.forEach((f) => f(resp('recordatorio_preop', 'recordatorio-preop-y')));
  chk(toques === 2, 'otro aviso con la app abierta: abre');
  dejar();
  chk(N.estado.oyentes.length === 0, 'deja de escuchar');

  console.log(`\n${ok} comprobaciones OK`);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows: la base sigue abierta */ }
}
