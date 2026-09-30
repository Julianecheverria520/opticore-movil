// Cola de envío (src/database/syncUp.js) y foto del tiquete (src/tiquetes.js):
//   node --import ./scripts/banco/registro.mjs scripts/banco/probar_cola_fotos.mjs
// - Un tanqueo sin respuesta / con 5xx ya no frena los puntos del viaje (401 sí detiene todo).
// - La foto sube como etapa aparte, solo con el tanqueo enviado, con su propio candado.
// - Reintentos: SIN RESPUESTA → pausa 5 min; 4xx (salvo 408/429) o 5 fallas → error; ya_tiene_foto = enviada.
// - Limpieza de 14 días y de archivos huérfanos de tiquetes/.
import assert from 'node:assert/strict';

const RAIZ = new URL('../../', import.meta.url);
const src = (r) => import(new URL(`src/${r}`, RAIZ).href);
let ok = 0;
const chk = (c, m) => { assert.ok(c, m); ok++; console.log('  ✔', m); };
const titulo = (t) => console.log(`\n${t}`);

globalThis.DB_PATH = ':memory:';
const AS = (await import('@react-native-async-storage/async-storage')).default;
const SS = await import('expo-secure-store');
const FS = await import('expo-file-system');
const { getDb } = await src('database/db.js');
const { enviarPendientes, contarPendientes } = await src('database/syncUp.js');
const T = await src('tiquetes.js');
const db = await getDb();

await SS.setItemAsync('userToken', 'tok');
await AS.setItem('userName', 'cond');

// ── Servidor simulado ──────────────────────────────────────────────────────────
const llamadas = [];
let rutas = {};
const resp = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
  const ruta = url.replace('https://opticore-ia.com', '');
  llamadas.push({ ruta, body: opts.body ? JSON.parse(opts.body) : null });
  for (const [patron, fn] of Object.entries(rutas)) if (ruta.includes(patron)) return fn(ruta, opts);
  return resp(404, { detail: 'sin ruta' });
};
const subidas = [];
let alSubir = async () => ({ status: 200, body: '{"status":"success"}' });
globalThis.__subir = async (url, uri) => { subidas.push({ url, uri }); return alSubir(url, uri); };

const OK_PUNTOS = { '/puntos': () => resp(200, { insertados: 3, ignorados: 0 }) };
const TIQUETES = 'file:///doc/tiquetes/';

async function limpiar() {
  await db.execAsync('DELETE FROM tanqueos_pendientes; DELETE FROM puntos_gps; DELETE FROM viajes_locales; DELETE FROM reportes_pendientes;');
  FS.__archivos.clear();
  llamadas.length = 0;
  subidas.length = 0;
  alSubir = async () => ({ status: 200, body: '{"status":"success"}' });
  await AS.removeItem('tiquetesEnFormulario');
}

async function viajeConPuntos(n = 3) {
  await db.runAsync(`INSERT INTO viajes_locales (uuid, usuario, placa, estado_local, sync_inicio, sync_foto_inicio, sync_status, fecha)
    VALUES ('V1', 'cond', 'JMU965', 'EN_CURSO', 'synced', 'synced', 'pending', datetime('now', 'localtime'))`);
  await agregarPuntos(n);
}
async function agregarPuntos(n) {
  for (let i = 0; i < n; i++) {
    await db.runAsync(`INSERT INTO puntos_gps (viaje_uuid, seq, latitud, longitud, precision, ts_iso, enviado)
      SELECT 'V1', COALESCE(MAX(seq), 0) + 1, 4.6, -74.1, 10, '2026-09-30T10:00:00-05:00', 0 FROM puntos_gps WHERE viaje_uuid = 'V1'`);
  }
}
const puntosPendientes = async () => (await db.getFirstAsync("SELECT COUNT(*) AS n FROM puntos_gps WHERE enviado = 0")).n;

async function tanqueo(uuid, { conFoto = false, sync = 'pending', fechaSql = "datetime('now', 'localtime')", fotoEstado } = {}) {
  const uri = conFoto ? `${TIQUETES}${uuid}.jpg` : null;
  if (uri) FS.__crear(uri);
  await db.runAsync(`INSERT INTO tanqueos_pendientes (uuid, usuario, placa, cantidad_galones, valor_total, fecha, fecha_iso,
      foto_uri, foto_estado, sync_status) VALUES (?, 'cond', 'JMU965', 25.5, 275000, ${fechaSql}, '2026-09-30T10:00:00-05:00', ?, ?, ?)`,
  uuid, uri, fotoEstado || (uri ? 'pending' : 'sin_foto'), sync);
  return uri;
}
const fila = (uuid) => db.getFirstAsync('SELECT * FROM tanqueos_pendientes WHERE uuid = ?', uuid);
const pasada = async (op) => { const r = await enviarPendientes(op); await T.esperarFotosTiquete(); return r; };

// ── 1. Un tanqueo no frena los puntos ──────────────────────────────────────────
titulo('1. Cola: el tanqueo no frena los puntos del viaje');
await limpiar(); await viajeConPuntos(3); await tanqueo('T1');
rutas = { ...OK_PUNTOS, '/combustible/guardar': () => resp(503, { detail: 'caído' }) };
let r = await pasada();
chk(await puntosPendientes() === 0, 'tanqueo con 503: los 3 puntos del viaje se enviaron en la misma pasada');
chk((await fila('T1')).sync_status === 'pending' && (await fila('T1')).intentos === 1, 'el tanqueo queda pendiente (1 intento)');
chk(r.servidorNoDisponible === true, 'la pasada informa "servidor no disponible" (Home lo muestra)');

await limpiar(); await viajeConPuntos(3); await tanqueo('T1');
rutas = { ...OK_PUNTOS, '/combustible/guardar': () => { throw new Error('Network request timed out'); } };
r = await pasada();
chk(await puntosPendientes() === 0, 'tanqueo SIN RESPUESTA: los puntos igual se enviaron');
chk(/SIN RESPUESTA/.test((await fila('T1')).ultimo_error), 'el tanqueo guarda el error real');

await limpiar(); await viajeConPuntos(3); await tanqueo('T1');
rutas = { ...OK_PUNTOS, '/combustible/guardar': () => resp(401) };
r = await pasada();
chk(r.sesionExpirada && await puntosPendientes() === 3, '401 en el tanqueo: se detiene todo (la sesión vale para todas)');

await limpiar(); await viajeConPuntos(3); await tanqueo('T1');
rutas = { ...OK_PUNTOS, '/combustible/guardar': () => resp(200, { status: 'success', id: 9 }) };
r = await pasada();
chk((await fila('T1')).sync_status === 'synced' && await puntosPendientes() === 0, 'todo bien: tanqueo y puntos enviados');
const cuerpo = llamadas.find((l) => l.ruta.includes('/combustible/guardar')).body;
chk(cuerpo.uuid_cliente === 'T1' && cuerpo.con_foto === false && cuerpo.advertencia_confirmada === false, 'payload: uuid_cliente, con_foto=false, advertencia_confirmada=false');

// ── 2. Foto del tiquete: etapa aparte ──────────────────────────────────────────
titulo('2. Foto del tiquete: después del tanqueo, aparte');
await limpiar(); const uri2 = await tanqueo('T2', { conFoto: true });
rutas = { '/combustible/guardar': () => resp(503) };
await pasada();
chk(subidas.length === 0 && (await fila('T2')).foto_estado === 'pending', 'tanqueo sin enviar: la foto no se intenta');
let res = await contarPendientes();
chk(res.fotos.pendientes === 1 && res.fotos.esperandoTanqueo === 1 && res.pendientes === 1, 'Home: 1 foto (esperando el tanqueo) aparte del "por enviar" (1 tanqueo)');

rutas = { '/combustible/guardar': () => resp(200, { status: 'success' }) };
await pasada();
chk(llamadas.filter((l) => l.ruta.includes('/guardar')).pop().body.con_foto === true, 'payload con_foto=true');
chk(subidas.length === 1 && subidas[0].url === 'https://opticore-ia.com/movil/combustible/T2/foto' && subidas[0].uri === uri2,
  'foto subida a /movil/combustible/{uuid}/foto');
let f = await fila('T2');
chk(f.foto_estado === 'synced' && !FS.__archivos.has(uri2), 'foto enviada: synced y el archivo se borra del celular');
chk(JSON.parse(f.diag_foto).codigo === 200 && /KB/.test(JSON.parse(f.diag_foto).mensaje), 'diagnóstico con código, KB y segundos');
res = await contarPendientes();
chk(res.fotos.pendientes === 0 && res.fotos.errores === 0 && res.pendientes === 0, 'Home: sin fotos pendientes (la tarjeta se oculta)');

// ── 3. Reintentos ──────────────────────────────────────────────────────────────
titulo('3. Reintentos de la foto');
await limpiar(); await tanqueo('T3', { conFoto: true, sync: 'synced' });
alSubir = async () => { throw new Error('timeout'); };
await pasada();
f = await fila('T3');
chk(f.foto_estado === 'pending' && f.intentos_foto === 0 && JSON.parse(f.diag_foto).codigo === 'SIN RESPUESTA', 'SIN RESPUESTA: sigue pendiente, sin contar intento');
await pasada();
chk(subidas.length === 1, 'SIN RESPUESTA: la siguiente pasada no la reintenta (pausa de 5 min)');
alSubir = async () => ({ status: 200, body: '{"status":"success"}' });
await pasada({ forzarFotos: true });
chk(subidas.length === 2 && (await fila('T3')).foto_estado === 'synced', '"Enviar ahora" (forzarFotos) la sube durante la pausa');

await limpiar(); await tanqueo('T4', { conFoto: true, sync: 'synced' });
alSubir = async () => ({ status: 502, body: '{"detail":"No se pudo guardar la foto (ref ab12)"}' });
for (let i = 0; i < 4; i++) await pasada();
f = await fila('T4');
chk(f.foto_estado === 'pending' && f.intentos_foto === 4, '502 cuatro veces: sigue pendiente (4 intentos)');
await pasada();
f = await fila('T4');
chk(f.foto_estado === 'error' && f.intentos_foto === 5 && /502: No se pudo guardar/.test(JSON.parse(f.diag_foto).mensaje), '5.ª falla → error con el mensaje del servidor');
res = await contarPendientes();
chk(res.fotos.errores === 1 && res.fotos.ultimo.codigo === 502, 'Home: 1 con error y el último diagnóstico');

await T.reintentarFotosTiquete();
alSubir = async () => ({ status: 200, body: '{"status":"success"}' });
await pasada();
chk((await fila('T4')).foto_estado === 'synced', '"Reintentar": vuelve a la cola y sube');

await limpiar(); await tanqueo('T5', { conFoto: true, sync: 'synced' });
alSubir = async () => ({ status: 413, body: '{"detail":"La foto supera 3 MB."}' });
await pasada();
chk((await fila('T5')).foto_estado === 'error', '413 (rechazo): error de inmediato');
await limpiar(); await tanqueo('T6', { conFoto: true, sync: 'synced' });
alSubir = async () => ({ status: 429, body: '{}' });
await pasada();
chk((await fila('T6')).foto_estado === 'pending', '429: se reintenta (no es rechazo)');

await limpiar(); await tanqueo('T7', { conFoto: true, sync: 'synced' });
alSubir = async () => ({ status: 200, body: '{"status":"ya_tiene_foto","id":9}' });
await pasada();
f = await fila('T7');
chk(f.foto_estado === 'synced' && /ya tenía foto/.test(JSON.parse(f.diag_foto).mensaje), 'ya_tiene_foto: cuenta como enviada');

await limpiar(); await tanqueo('T8', { conFoto: true, sync: 'synced' });
FS.__archivos.clear();
await pasada();
chk((await fila('T8')).foto_estado === 'error' && JSON.parse((await fila('T8')).diag_foto).codigo === 'SIN ARCHIVO', 'archivo perdido: error "SIN ARCHIVO"');

await limpiar(); await tanqueo('T9', { conFoto: true, sync: 'synced' });
alSubir = async () => ({ status: 401, body: '{}' });
await pasada();
chk((await fila('T9')).foto_estado === 'pending', '401 en la foto: queda pendiente (sesión por renovar)');

// ── 4. Candado propio: una foto lenta no deja "omitida" la subida de puntos ────
titulo('4. Candado propio de las fotos');
await limpiar(); await viajeConPuntos(2); await tanqueo('T10', { conFoto: true });
rutas = { ...OK_PUNTOS, '/combustible/guardar': () => resp(200, { status: 'success' }) };
let soltar;
alSubir = () => new Promise((res2) => { soltar = () => res2({ status: 200, body: '{"status":"success"}' }); });
await enviarPendientes();
for (let i = 0; i < 50 && !soltar; i++) await new Promise((z) => setTimeout(z, 10));
chk(typeof soltar === 'function', 'la foto está subiendo (sin terminar)');
await agregarPuntos(4);
r = await enviarPendientes();
chk(!r.omitido && await puntosPendientes() === 0, 'mientras la foto sube, otra pasada envía los 4 puntos nuevos (no queda omitida)');
soltar();
await T.esperarFotosTiquete();
chk((await fila('T10')).foto_estado === 'synced' && subidas.length === 1, 'la foto termina y no se subió dos veces');

// ── 5. Limpieza ────────────────────────────────────────────────────────────────
titulo('5. Limpieza (14 días y huérfanas)');
await limpiar();
rutas = { '/combustible/guardar': () => resp(200, { status: 'success' }) };
const viejo = "datetime('now', '-20 days', 'localtime')";
await tanqueo('V-sin', { sync: 'synced', fechaSql: viejo });
await tanqueo('V-pend', { conFoto: true, sync: 'synced', fechaSql: viejo });
await tanqueo('V-err', { conFoto: true, sync: 'synced', fechaSql: viejo, fotoEstado: 'error' });
alSubir = async () => { throw new Error('timeout'); }; // la de V-pend no alcanza a subir
await pasada();
chk(!(await fila('V-sin')), '14 días: se borra el tanqueo enviado sin foto');
chk(!!(await fila('V-pend')), '14 días: NO se borra el que tiene la foto por enviar');
chk(!!(await fila('V-err')), '14 días: NO se borra el que tiene la foto con error');
chk(FS.__archivos.has(`${TIQUETES}V-err.jpg`), 'la foto con error sigue en el celular (la limpieza de huérfanas la respeta)');
chk(await T.descartarFotosTiquete() === 1 && (await fila('V-err')).foto_estado === 'descartada'
  && !FS.__archivos.has(`${TIQUETES}V-err.jpg`), '"Descartar": foto_estado descartada y el archivo se borra');
res = await contarPendientes();
chk(res.fotos.errores === 0 && res.fotos.pendientes === 1, 'Home: la descartada ya no cuenta (queda la pendiente)');
await pasada();
chk(!(await fila('V-err')), 'descartada: la limpieza de 14 días ya la puede borrar');

await limpiar();
const hace2h = Date.now() - 2 * 3600000;
await tanqueo('CON-FILA', { conFoto: true, sync: 'synced', fotoEstado: 'error' });
FS.__archivos.set(`${TIQUETES}CON-FILA.jpg`, { size: 1, mtime: hace2h });
FS.__crear(`${TIQUETES}HUERFANA.jpg`, { mtime: hace2h });
FS.__crear(`${TIQUETES}RECIENTE.jpg`);
FS.__crear('file:///cache/foto_camara.jpg');
const enForm = await T.guardarFotoTiquete('file:///cache/foto_camara.jpg', 'FORMULARIO', 4000);
FS.__archivos.set(enForm, { size: 1, mtime: hace2h }); // formulario abierto hace rato
const n = await T.limpiarTiquetesHuerfanos(db);
chk(n === 1 && !FS.__archivos.has(`${TIQUETES}HUERFANA.jpg`), 'huérfana de más de 1 h: se borra');
chk(FS.__archivos.has(`${TIQUETES}CON-FILA.jpg`), 'con fila en tanqueos_pendientes: se conserva');
chk(FS.__archivos.has(`${TIQUETES}RECIENTE.jpg`), 'huérfana reciente (< 1 h): se conserva por si acaso');
chk(FS.__archivos.has(enForm), 'foto de un formulario abierto: se conserva');
chk(enForm === `${TIQUETES}FORMULARIO.jpg` && !FS.__archivos.has('file:///cache/reducida_1.jpg'), 'guardarFotoTiquete: tiquetes/{uuid}.jpg y borra la reducida temporal');
await T.soltarFotoFormulario(enForm, { borrar: true });
chk(!FS.__archivos.has(enForm), 'salir sin guardar: la foto del formulario se borra');

console.log(`\n${ok} comprobaciones OK`);
