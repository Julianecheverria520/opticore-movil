// Tanqueo durante un viaje: ubicación del último punto, aviso de movimiento y borrador del formulario.
//   node --import ./scripts/banco/registro.mjs scripts/banco/probar_viaje_tanqueo.mjs
import assert from 'node:assert/strict';

const RAIZ = new URL('../../', import.meta.url);
const src = (r) => import(new URL(`src/${r}`, RAIZ).href);
let ok = 0;
const chk = (c, m) => { assert.ok(c, m); ok++; console.log('  ✔', m); };

globalThis.DB_PATH = ':memory:';
const C = await src('combustible.js');
const B = await src('borrador.js');
const { getDb } = await src('database/db.js');
const db = await getDb();
const iso = (ms) => new Date(ms).toISOString();
const ahora = Date.parse('2026-09-30T15:00:00Z');

console.log('\n1. Ubicación del tanqueo');
chk(C.ubicacionDePunto(null, ahora) === null, 'sin puntos: null (se usa la ubicación actual)');
chk(JSON.stringify(C.ubicacionDePunto({ latitud: 4.6, longitud: -74.1, ts_iso: iso(ahora - 9 * 60000) }, ahora)) === '{"lat":4.6,"lon":-74.1}',
  'último punto de hace 9 min (parado en la bomba): se usa');
chk(C.ubicacionDePunto({ latitud: 4.6, longitud: -74.1, ts_iso: iso(ahora - 11 * 60000) }, ahora) === null, 'último punto de hace 11 min: null (ubicación actual)');
chk(C.ubicacionDePunto({ latitud: 4.6, longitud: -74.1, ts_iso: '2026-09-30T09:55:00-05:00' }, ahora) !== null, 'ts_iso con zona -05:00 (como los guarda la tarea GPS)');

await db.runAsync(`INSERT INTO puntos_gps (viaje_uuid, seq, latitud, longitud, velocidad, ts_iso) VALUES
  ('V1', 1, 4.60, -74.10, 8.0, '2026-09-30T09:50:00-05:00'), ('V1', 2, 4.61, -74.11, 0.5, '2026-09-30T09:58:00-05:00'),
  ('V2', 1, 5.00, -75.00, 1.0, '2026-09-30T09:59:00-05:00')`);
const p = await C.ultimoPuntoViaje(db, 'V1');
chk(p.latitud === 4.61 && p.velocidad === 0.5, 'ultimoPuntoViaje: el de mayor seq de ESE viaje');
chk(await C.ultimoPuntoViaje(db, null) === null, 'sin viaje: null');

console.log('\n2. Aviso "Detén el vehículo" (> 10 km/h)');
const punto = (kmh, hace) => ({ velocidad: kmh / 3.6, ts_iso: iso(ahora - hace * 1000) });
const sistema = (kmh, hace) => ({ coords: { speed: kmh / 3.6 }, timestamp: ahora - hace * 1000 });
chk(C.vaEnMovimiento(C.velocidadReciente(punto(40, 10), null, ahora)), 'punto de hace 10 s a 40 km/h: en movimiento');
chk(!C.vaEnMovimiento(C.velocidadReciente(punto(8, 10), null, ahora)), 'punto a 8 km/h: no');
chk(!C.vaEnMovimiento(C.velocidadReciente(punto(20, 60), null, ahora)), 'punto de hace 60 s a 20 km/h (ya frenó en la bomba): no');
chk(C.vaEnMovimiento(C.velocidadReciente(punto(20, 60), sistema(30, 5), ahora)), 'punto viejo pero el sistema dice 30 km/h hace 5 s: en movimiento');
chk(!C.vaEnMovimiento(C.velocidadReciente(null, sistema(30, 40), ahora)), 'sistema de hace 40 s: no se sabe → sin aviso');
chk(!C.vaEnMovimiento(C.velocidadReciente(null, { coords: { speed: -1 }, timestamp: ahora }, ahora)), 'velocidad -1 (desconocida): sin aviso');
chk(!C.vaEnMovimiento(C.velocidadReciente({ velocidad: null, ts_iso: iso(ahora) }, null, ahora)), 'punto sin velocidad: sin aviso');
chk(C.vaEnMovimiento(10.1 / 3.6) && !C.vaEnMovimiento(10 / 3.6), 'el límite es más de 10 km/h');

console.log('\n3. Borrador del formulario');
chk(await B.leerBorrador('JMU965') === null, 'sin borrador');
await B.guardarBorrador({ placa: 'JMU965', uuid: 'U1', viajeUuid: 'V1', galones: '25,5', valor: '275000', fotoUri: 'file:///doc/tiquetes/U1.jpg' });
let b = await B.leerBorrador('JMU965');
chk(b.uuid === 'U1' && b.galones === '25,5' && b.viajeUuid === 'V1' && B.borradorVigente(b), 'se guarda con uuid, campos y viaje; vigente');
const creado = b.creado;
await new Promise((z) => setTimeout(z, 5));
await B.guardarBorrador({ ...b, valor: '280000' });
b = await B.leerBorrador('JMU965');
chk(b.creado === creado && b.editado >= creado && b.valor === '280000', 'al seguir escribiendo conserva la hora de creación ("de las HH:MM")');
await B.guardarBorrador({ placa: 'ABC123', uuid: 'U2', galones: '10' });
chk((await B.leerBorrador('ABC123')).uuid === 'U2' && (await B.leerBorrador('JMU965')).uuid === 'U1', 'uno por placa');
chk(JSON.stringify(await B.fotosDeBorradoresVigentes()) === '["U1.jpg"]', 'fotos protegidas: solo las de borradores vigentes');
chk(!B.borradorVigente(b, Date.now() + 13 * 3600000), 'a las 13 h deja de estar vigente');
chk((await B.fotosDeBorradoresVigentes(Date.now() + 13 * 3600000)).length === 0, 'vencido: su foto ya no se protege');
await B.borrarBorrador('JMU965');
chk(await B.leerBorrador('JMU965') === null && (await B.leerBorrador('ABC123')) !== null, 'borrar uno no toca el otro');

console.log(`\n${ok} comprobaciones OK`);
