// SQLite v11 (tanqueos) y bajada de maestros con "combustible" y "ultimo_tanqueo".
//   node --import ./scripts/banco/registro.mjs scripts/banco/probar_sqlite_v11.mjs
// La base v10 se arma con el db.js de cbfd660 (el del build 1.2.0), sacado con git.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = new URL('../../', import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'banco-v11-'));
let ok = 0;
const chk = (c, m) => { assert.ok(c, m); ok++; console.log('  ✔', m); };

try {
  // 1) Base v10 con un tanqueo pendiente, uno enviado y el equipo
  const dbV10 = join(tmp, 'db_v10.mjs');
  writeFileSync(dbV10, execFileSync('git', ['show', 'cbfd660:src/database/db.js'], { cwd: fileURLToPath(RAIZ) }));
  globalThis.DB_PATH = join(tmp, 'opticore.db');
  const v10 = await (await import(pathToFileURL(dbV10).href)).getDb();
  assert.equal((await v10.getFirstAsync('PRAGMA user_version')).user_version, 10);
  await v10.runAsync(`INSERT INTO tanqueos_pendientes (uuid, placa, cantidad_galones, valor_total, fecha, sync_status)
    VALUES ('u1', 'JMU965', 25.5, 275000, datetime('now', 'localtime'), 'pending')`);
  await v10.runAsync(`INSERT INTO tanqueos_pendientes (uuid, placa, cantidad_galones, valor_total, fecha, sync_status)
    VALUES ('u2', 'JMU965', 10, 110000, datetime('now', 'localtime'), 'synced')`);
  await v10.runAsync("INSERT INTO equipos (id, placa, ultimo_odometro) VALUES (7, 'JMU965', 1000)");

  // 2) La app nueva abre la misma base: v10 -> v11 conservando datos
  const { getDb } = await import(new URL('src/database/db.js', RAIZ).href);
  const db = await getDb();
  chk((await db.getFirstAsync('PRAGMA user_version')).user_version === 11, 'v10 → user_version 11');
  const ct = (await db.getAllAsync('PRAGMA table_info(tanqueos_pendientes)')).map((c) => c.name);
  for (const c of ['advertencia_confirmada', 'foto_uri', 'foto_estado', 'intentos_foto', 'diag_foto',
    'requiere_revision', 'motivo_revision', 'viaje_uuid']) {
    chk(ct.includes(c), `tanqueos_pendientes.${c}`);
  }
  const ce = (await db.getAllAsync('PRAGMA table_info(equipos)')).map((c) => c.name);
  chk(ce.includes('ultimo_tanqueo_fecha') && ce.includes('ultimo_tanqueo_galones'), 'equipos.ultimo_tanqueo_fecha / _galones');
  const filas = await db.getAllAsync(
    'SELECT sync_status, foto_estado, intentos_foto, advertencia_confirmada, requiere_revision FROM tanqueos_pendientes ORDER BY id'
  );
  chk(filas.length === 2 && filas[0].sync_status === 'pending' && filas[1].sync_status === 'synced',
    'los tanqueos de antes siguen (pendiente y enviado)');
  chk(filas.every((f) => f.foto_estado === 'sin_foto' && f.intentos_foto === 0 && f.advertencia_confirmada === 0 && f.requiere_revision === 0),
    'los de antes quedan sin_foto, 0 intentos, sin marca');

  // 3) Bajada de maestros con servidor nuevo
  const AS = (await import('@react-native-async-storage/async-storage')).default;
  const { sincronizarDatosMaestros, leerConfigCombustible } = await import(new URL('src/database/sync.js', RAIZ).href);
  chk((await leerConfigCombustible()) === null, 'sin bajada: config de combustible = null');
  const combustible = {
    margen_tanque_pct: 5, foto_tiquete: 'RECOMENDADA', tolerancia_tipo: 'PORCENTAJE', tolerancia_valor: 10,
    rangos: { DIESEL: { referencia: 11000, minimo: 9900, maximo: 12100 } }, calculado: '2026-09-30 08:00:00',
  };
  let respuesta;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => respuesta });
  respuesta = {
    equipos: [
      { id: 7, placa: 'jmu965 ', ultimo_odometro: 900,
        ultimo_tanqueo: { id: 40, fecha: '2026-09-30 07:15:00', galones: 25.5, odometro: 1000, horometro: 0 } },
      { id: 8, placa: 'ABC123', ultimo_tanqueo: null },
    ],
    preguntas: [{ id: 1, pregunta: 'Frenos' }],
    combustible,
  };
  chk(await sincronizarDatosMaestros('tok', 'http://x') === true, 'bajada nueva OK');
  let e = await db.getFirstAsync("SELECT * FROM equipos WHERE placa = 'JMU965'");
  chk(e.ultimo_tanqueo_fecha === '2026-09-30 07:15:00' && e.ultimo_tanqueo_galones === 25.5, 'JMU965: último tanqueo del servidor guardado');
  chk(e.ultimo_odometro === 1000, 'JMU965: con tanqueo pendiente se conserva el odómetro local mayor (E8)');
  e = await db.getFirstAsync("SELECT * FROM equipos WHERE placa = 'ABC123'");
  chk(e.ultimo_tanqueo_fecha === null && e.ultimo_tanqueo_galones === null, 'ABC123 sin tanqueos: nulos');
  chk(JSON.stringify(await leerConfigCombustible()) === JSON.stringify(combustible), 'config de combustible en AsyncStorage');

  // 4) Servidor viejo (sin combustible ni ultimo_tanqueo): la config guardada no se borra
  respuesta = { equipos: [{ id: 7, placa: 'JMU965' }], preguntas: [{ id: 1, pregunta: 'Frenos' }] };
  chk(await sincronizarDatosMaestros('tok', 'http://x') === true, 'bajada de servidor viejo OK');
  e = await db.getFirstAsync("SELECT * FROM equipos WHERE placa = 'JMU965'");
  chk(e.ultimo_tanqueo_fecha === null, 'servidor viejo: sin último tanqueo (como hoy)');
  chk((await leerConfigCombustible())?.foto_tiquete === 'RECOMENDADA', 'servidor viejo: se conserva la última config');

  // 5) Dato dañado en AsyncStorage no rompe
  await AS.setItem('configCombustible', '{roto');
  chk((await leerConfigCombustible()) === null, 'config dañada → null');

  // 6) Instalación nueva: v0 -> v11 (otra base, módulo recargado)
  globalThis.DB_PATH = ':memory:';
  const { getDb: getDbNueva } = await import(`${new URL('src/database/db.js', RAIZ).href}?nueva`);
  const nueva = await getDbNueva();
  await nueva.runAsync("INSERT INTO tanqueos_pendientes (uuid, placa) VALUES ('n1', 'X')");
  chk((await nueva.getFirstAsync('PRAGMA user_version')).user_version === 11
    && (await nueva.getFirstAsync('SELECT foto_estado FROM tanqueos_pendientes')).foto_estado === 'sin_foto',
  'instalación nueva: v0 → v11 y foto_estado por defecto sin_foto');

  console.log(`\n${ok} comprobaciones OK`);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows puede retener el archivo abierto */ }
}
