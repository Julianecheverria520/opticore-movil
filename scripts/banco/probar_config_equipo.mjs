// Configuración de activos en la app (src/configEquipo.js), paquete Viajes:
//   node --import ./scripts/banco/registro.mjs scripts/banco/probar_config_equipo.mjs
// - SQLite v11 → v12 (equipos.config_json) conservando datos; el db.js de 1.4.0 abre la base v12 (rollback OTA).
// - Bajada: config de cada equipo a config_json y config_conectados a AsyncStorage; servidor viejo → NULL.
// - configPaquete: null si no hay config, si el paquete no está conectado o si el JSON está dañado.
// - Viaje sin foto de carga / descarga: la cola no espera la foto, no es "problema" y la fila se cierra.
// - mostrar_ruta_peajes = false: sin línea, sin peajes y sin resumen ("Sin peajes en esta ruta").
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = new URL('../../', import.meta.url);
const src = (r) => import(new URL(`src/${r}`, RAIZ).href);
const tmp = mkdtempSync(join(tmpdir(), 'banco-v12-'));
let ok = 0;
const chk = (c, m) => { assert.ok(c, m); ok++; console.log('  ✔', m); };
const titulo = (t) => console.log(`\n${t}`);

// db.js del último commit (v11, el de 1.4.0): base de partida y prueba de rollback
const dbV11 = join(tmp, 'db_v11.mjs');
writeFileSync(dbV11, execFileSync('git', ['show', 'HEAD:src/database/db.js'], { cwd: fileURLToPath(RAIZ) }));

try {
  // ── 1. Migración ─────────────────────────────────────────────────────────────
  titulo('1. SQLite v11 → v12');
  globalThis.DB_PATH = join(tmp, 'opticore.db');
  const v11 = await (await import(pathToFileURL(dbV11).href)).getDb();
  assert.equal((await v11.getFirstAsync('PRAGMA user_version')).user_version, 11);
  await v11.runAsync("INSERT INTO equipos (id, placa, requiere_cantidad) VALUES (7, 'JMU965', 1)");
  await v11.closeAsync?.();

  const { getDb } = await src('database/db.js');
  const db = await getDb();
  chk((await db.getFirstAsync('PRAGMA user_version')).user_version === 12, 'v11 → user_version 12');
  const e0 = await db.getFirstAsync("SELECT * FROM equipos WHERE placa = 'JMU965'");
  chk(e0 && e0.requiere_cantidad === 1 && e0.config_json === null, 'el equipo de antes sigue, con config_json NULL');

  // ── 2. Bajada de maestros ────────────────────────────────────────────────────
  titulo('2. Bajada: config y config_conectados');
  const AS = (await import('@react-native-async-storage/async-storage')).default;
  const { sincronizarDatosMaestros } = await src('database/sync.js');
  const C = await src('configEquipo.js');
  chk((await C.leerConfigConectados()).length === 0, 'sin bajada: ningún paquete conectado');

  const cfg = (viajes) => ({ contadores: { tiene_odometro: true, aplica: true }, viajes });
  let respuesta;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => respuesta });
  respuesta = {
    equipos: [
      { id: 7, placa: 'JMU965', requiere_cantidad: true,
        config: cfg({ aplica: true, foto_carga: 'OPCIONAL', foto_descarga: 'NO', requiere_cantidad: false, mostrar_ruta_peajes: false }) },
      { id: 8, placa: 'ABC123', config: cfg({ aplica: false, foto_carga: 'OBLIGATORIA', foto_descarga: 'OBLIGATORIA',
        requiere_cantidad: false, mostrar_ruta_peajes: true }) },
      { id: 9, placa: 'SIN001' },
    ],
    preguntas: [{ id: 1, pregunta: 'Frenos' }],
    config_conectados: ['alquiler', 'contadores', 'lecturas', 'viajes'],
  };
  chk(await sincronizarDatosMaestros('tok', 'http://x') === true, 'bajada nueva OK');
  const eq = (p) => db.getFirstAsync('SELECT * FROM equipos WHERE placa = ?', p);
  chk(JSON.parse((await eq('JMU965')).config_json).viajes.foto_carga === 'OPCIONAL', 'JMU965: config_json guardado');
  chk((await eq('SIN001')).config_json === null, 'equipo sin "config": NULL');
  chk((await C.leerConfigConectados()).includes('viajes'), 'config_conectados en AsyncStorage');

  // ── 3. Lectura ───────────────────────────────────────────────────────────────
  titulo('3. configPaquete');
  const vJ = await C.configPaquete(await eq('JMU965'), 'viajes');
  chk(vJ?.foto_carga === 'OPCIONAL' && vJ.foto_descarga === 'NO', 'JMU965: valores de viajes');
  chk(C.nivelFoto(vJ, 'foto_carga') === 'OPCIONAL' && C.nivelFoto(vJ, 'foto_descarga') === 'NO', 'nivelFoto OPCIONAL / NO');
  chk(C.pideCantidad(vJ, await eq('JMU965')) === false, 'requiere_cantidad de la config (false) le gana a la columna (1)');
  chk(C.muestraRutaPeajes(vJ) === false && C.haceViajes(vJ) === true, 'JMU965: hace viajes, sin ruta ni peajes');
  chk(C.haceViajes(await C.configPaquetePorPlaca('abc123 ', 'viajes')) === false, 'ABC123 (por placa): no hace viajes');
  chk(await C.configPaquete(await eq('JMU965'), 'combustible') === null, 'paquete sin conectar (combustible) → null');
  chk(C.paqueteDe(await eq('JMU965'), 'viajes', ['contadores']) === null, 'viajes fuera de config_conectados → null');
  chk(await C.configPaquete(await eq('SIN001'), 'viajes') === null, 'equipo sin config → null');
  chk(await C.configPaquete(null, 'viajes') === null, 'placa que no está → null');
  chk(C.paqueteDe({ config_json: '{roto' }, 'viajes', ['viajes']) === null, 'JSON dañado → null');
  // null = como siempre
  chk(C.nivelFoto(null, 'foto_carga') === 'OBLIGATORIA' && C.nivelFoto({ foto_carga: 'X' }, 'foto_carga') === 'OBLIGATORIA',
    'sin config o valor raro: foto OBLIGATORIA');
  chk(C.haceViajes(null) && C.muestraRutaPeajes(null), 'sin config: hace viajes y muestra ruta');
  chk(C.pideCantidad(null, { requiere_cantidad: 1 }) === true && C.pideCantidad({}, { requiere_cantidad: 0 }) === false,
    'sin requiere_cantidad en la config: la columna');

  await AS.setItem(C.CLAVE_CONFIG_CONECTADOS, '{roto');
  chk((await C.leerConfigConectados()).length === 0, 'config_conectados dañado → []');

  // Servidor viejo: equipos sin config → NULL; config_conectados que no llega no se borra
  await AS.setItem(C.CLAVE_CONFIG_CONECTADOS, JSON.stringify(['viajes']));
  respuesta = { equipos: [{ id: 7, placa: 'JMU965', requiere_cantidad: true }], preguntas: [{ id: 1, pregunta: 'Frenos' }] };
  chk(await sincronizarDatosMaestros('tok', 'http://x') === true, 'bajada de servidor viejo OK');
  chk((await eq('JMU965')).config_json === null && await C.configPaquetePorPlaca('JMU965', 'viajes') === null,
    'servidor viejo: config_json NULL → la app como antes');

  // ── 4. Viaje sin fotos: la cola ──────────────────────────────────────────────
  titulo('4. Viaje sin foto de carga ni de descarga');
  const SS = await import('expo-secure-store');
  await SS.setItemAsync('userToken', 'tok');
  await AS.setItem('userName', 'cond');
  const V = await src('viajes.js');
  const { enviarPendientes, contarPendientes } = await src('database/syncUp.js');
  const llamadas = [];
  const subidas = [];
  globalThis.__subir = async (url) => { subidas.push(url); return { status: 200, body: '{}' }; };
  globalThis.fetch = async (url, opts = {}) => {
    const ruta = url.replace('https://app.opticore-ia.com', '');
    llamadas.push(ruta);
    const r = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (ruta.endsWith('/iniciar')) return r(200, { status: 'success', id_viaje: 'AB12' });
    if (ruta.endsWith('/puntos')) return r(200, { insertados: 1, ignorados: 0 });
    if (ruta.endsWith('/finalizar')) return r(200, { status: 'success' });
    return r(404, { detail: 'sin ruta' });
  };

  let v = await V.crearViajeLocal({ uuid: 'V1', placa: 'JMU965', material: 'ARENA', origen: 'A', destino: 'B', remision: 'R1' });
  chk(v.sync_foto_inicio === V.FOTO_OMITIDA && V.FOTO_OMITIDA === 'sin_foto', 'iniciado sin foto: foto de carga = sin_foto');
  await db.runAsync(`INSERT INTO puntos_gps (viaje_uuid, seq, latitud, longitud, precision, ts_iso, enviado)
    VALUES ('V1', 1, 4.6, -74.1, 10, '2026-10-15T10:00:00-05:00', 0)`);
  await enviarPendientes();
  v = await V.obtenerViaje('V1');
  chk(v.sync_inicio === 'synced' && v.sync_foto_inicio === 'sin_foto' && subidas.length === 0, 'en curso: inicio enviado, ninguna foto subida');
  chk(!(await V.tieneProblema('V1')) && (await contarPendientes()).errores === 0, 'no cuenta como viaje con problema');

  v = await V.finalizarViajeLocal('V1', { lat: 4.7, lon: -74.2 });
  chk(v.sync_foto_fin === 'sin_foto', 'finalizado sin foto: foto de descarga = sin_foto');
  await enviarPendientes();
  v = await V.obtenerViaje('V1');
  chk(v.sync_fin === 'synced' && v.sync_status === 'synced', 'cierre enviado y la fila queda synced (no espera fotos)');
  chk(subidas.length === 0 && !llamadas.some((l) => l.includes('/foto')), 'nunca intentó subir una foto');
  chk((await V.viajesConProblema()).length === 0 && (await contarPendientes()).pendientes === 0, 'Home: nada por enviar ni con problema');
  await V.reintentarViaje('V1');
  chk((await V.obtenerViaje('V1')).sync_foto_inicio === 'sin_foto', '"Reintentar" no reabre una foto omitida');

  // Mixto: foto de carga sí, descarga no
  const FS = await import('expo-file-system');
  FS.__crear('file:///doc/viajes/V2_inicio.jpg');
  await V.crearViajeLocal({ uuid: 'V2', placa: 'JMU965', material: 'ARENA', origen: 'A', destino: 'B', remision: 'R2',
    fotoInicioPath: 'file:///doc/viajes/V2_inicio.jpg' });
  await V.finalizarViajeLocal('V2', {});
  await enviarPendientes();
  v = await V.obtenerViaje('V2');
  chk(v.sync_foto_inicio === 'synced' && v.sync_foto_fin === 'sin_foto' && v.sync_status === 'synced',
    'con foto de carga y sin la de descarga: sube la de carga y cierra');

  // ── 5. Ruta planeada y peajes ────────────────────────────────────────────────
  titulo('5. mostrar_ruta_peajes');
  const { datosRutaPlaneada } = await src('rutaPlaneada.js');
  await db.runAsync("INSERT INTO rutas (id, nombre, origen, destino, geometria) VALUES (1, 'A-B', 'A', 'B', '_p~iF~ps|U_ulLnnqC_mqNvxq`@')");
  await db.runAsync("INSERT INTO peajes_ruta (ruta_id, peaje_id, orden, nombre, lat, lon, valores_json) VALUES (1, 1, 1, 'P1', 40, -120, '{}')");
  const viaje = { placa: 'JMU965', ruta_id: 1, origen: 'A', destino: 'B' };
  let d = await datosRutaPlaneada(db, viaje);
  chk(d.linea.length >= 2 && d.peajes.length === 1 && d.resumen, 'sin config: línea, peajes y resumen (como antes)');
  await db.runAsync("UPDATE equipos SET config_json = ? WHERE placa = 'JMU965'",
    JSON.stringify(cfg({ aplica: true, mostrar_ruta_peajes: false })));
  d = await datosRutaPlaneada(db, viaje);
  chk(d.linea.length === 0 && d.peajes.length === 0 && d.resumen === null, 'mostrar_ruta_peajes = false: nada que dibujar ni resumen');
  await db.runAsync("UPDATE equipos SET config_json = ? WHERE placa = 'JMU965'",
    JSON.stringify(cfg({ aplica: true, mostrar_ruta_peajes: true })));
  chk((await datosRutaPlaneada(db, viaje)).resumen !== null, 'mostrar_ruta_peajes = true: vuelve');

  // ── 6. Rollback OTA: el db.js de 1.4.0 abre la base v12 ──────────────────────
  titulo('6. Rollback a 1.4.0');
  const vieja = await (await import(`${pathToFileURL(dbV11).href}?rollback`)).getDb();
  chk((await vieja.getFirstAsync('PRAGMA user_version')).user_version === 12, 'el JS viejo no toca user_version 12');
  await vieja.runAsync(`INSERT OR REPLACE INTO equipos (id, placa, tipo, estado, ultimo_odometro, ultimo_horometro,
      tiene_horometro, tiene_odometro, tipo_activo_id, capacidad_tanque_gal, meta_rendimiento,
      requiere_cantidad, capacidad_m3, capacidad_ton, ultimo_preop_fecha, categoria_peaje,
      ultimo_tanqueo_fecha, ultimo_tanqueo_galones)
    VALUES (20, 'OLD001', 'VEHICULO', 'ACTIVO', 0, 0, 0, 1, NULL, NULL, NULL, 0, 0, 0, NULL, NULL, NULL, NULL)`);
  chk((await vieja.getFirstAsync("SELECT config_json FROM equipos WHERE placa = 'OLD001'")).config_json === null,
    'el INSERT de equipos de 1.4.0 (con lista de columnas) funciona: config_json NULL');

  console.log(`\n${ok} comprobaciones OK`);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows puede retener el archivo abierto */ }
}
