// src/combustible.js: tanqueos de hoy (servidor + celular, sin repetir) y datos para validar sin señal.
//   node --import ./scripts/banco/registro.mjs scripts/banco/probar_combustible.mjs
import assert from 'node:assert/strict';

process.env.TZ = 'America/Bogota'; // filas viejas sin fecha_iso: su "fecha" es la hora local del celular
const RAIZ = new URL('../../', import.meta.url);
let ok = 0;
const chk = (c, m) => { assert.ok(c, m); ok++; console.log('  ✔', m); };

const { tanqueosDeHoy, fechaHoraBogota, datosValidacion } = await import(new URL('src/combustible.js', RAIZ).href);
const { advertenciasTanqueo } = await import(new URL('src/combustibleNumeros.js', RAIZ).href);

// ── fechaHoraBogota
chk(fechaHoraBogota(Date.parse('2026-09-30T15:00:00Z')) === '2026-09-30 10:00:00', 'fechaHoraBogota: UTC-5');
chk(fechaHoraBogota(Date.parse('2026-10-01T04:30:00Z')) === '2026-09-30 23:30:00', 'fechaHoraBogota: 23:30 de Bogotá sigue siendo el mismo día');

// ── tanqueosDeHoy (ahora = 2026-09-30 10:00 Bogotá)
const ahora = new Date('2026-09-30T15:00:00Z');
chk(tanqueosDeHoy(null, [], ahora).length === 0, 'sin datos: ningún tanqueo hoy');
chk(tanqueosDeHoy({ fecha: '2026-09-29 18:00:00', galones: 20 }, [], ahora).length === 0, 'último del servidor de ayer: no cuenta');
let hoy = tanqueosDeHoy({ fecha: '2026-09-30 07:15:00', galones: 25.5 }, [], ahora);
chk(hoy.length === 1 && hoy[0].hora === '07:15' && hoy[0].galones === 25.5, 'último del servidor de hoy: 07:15 (25,5 gal)');

hoy = tanqueosDeHoy({ fecha: '2026-09-30 07:15:00', galones: 25.5 }, [
  { fecha_iso: '2026-09-30T07:15:40-05:00', cantidad_galones: 25.5 },   // el mismo, ya enviado
  { fecha_iso: '2026-09-30T09:00:00-05:00', cantidad_galones: 10 },     // otro, sin señal
], ahora);
chk(hoy.length === 2 && hoy[0].hora === '07:15' && hoy[1].hora === '09:00', 'servidor + celular: el mismo tanqueo se cuenta una vez');

hoy = tanqueosDeHoy(null, [
  { fecha_iso: '2026-09-30T07:15:00-05:00', cantidad_galones: 25.5 },
  { fecha_iso: '2026-09-30T07:15:00-05:00', cantidad_galones: 12 },     // misma hora, otros galones
], ahora);
chk(hoy.length === 2, 'misma hora y galones distintos: son dos');

hoy = tanqueosDeHoy(null, [
  { fecha_iso: '2026-09-30T00:30:00+00:00', cantidad_galones: 8 },      // 29 sep 19:30 en Bogotá
  { fecha_iso: '2026-09-30T12:00:00+00:00', cantidad_galones: 9 },      // 30 sep 07:00 en Bogotá
], ahora);
chk(hoy.length === 1 && hoy[0].hora === '07:00', 'fecha_iso con otra zona: se pasa a Bogotá antes de comparar el día');

hoy = tanqueosDeHoy(null, [{ fecha_iso: null, fecha: '2026-09-30 08:00:00', cantidad_galones: 5 }], ahora);
chk(hoy.length === 1 && hoy[0].hora === '08:00', 'fila vieja sin fecha_iso: usa fecha (hora local)');

hoy = tanqueosDeHoy({ fecha: '2026-09-30 23:10:00', galones: 3 }, [], new Date('2026-10-01T04:30:00Z'));
chk(hoy.length === 1, '23:30 de Bogotá (ya 1 oct en UTC): el tanqueo de las 23:10 es de hoy');

// ── datosValidacion (SQLite + config de maestros)
globalThis.DB_PATH = ':memory:';
const { getDb } = await import(new URL('src/database/db.js', RAIZ).href);
const AS = (await import('@react-native-async-storage/async-storage')).default;
const db = await getDb();
const hoyBog = fechaHoraBogota(Date.now()).slice(0, 10);
await db.runAsync(`INSERT INTO equipos (id, placa, capacidad_tanque_gal, ultimo_tanqueo_fecha, ultimo_tanqueo_galones)
  VALUES (7, 'JMU965', 60, ?, 25.5), (8, 'ABC123', 0, NULL, NULL)`, `${hoyBog} 06:05:00`);

let v = await datosValidacion(db, 'JMU965');
chk(v.rango === null && v.margen === 5 && v.fotoModo === 'OPCIONAL', 'sin config de maestros: sin rango, margen 5 %, foto opcional (como antes)');
chk(v.capacidad === 60 && v.hoy.length === 1 && v.hoy[0].hora === '06:05', 'capacidad del equipo y tanqueo de hoy del servidor');

const rango = { precio: 11000, min: 9900, max: 12100, fuente: 'MANUAL', muestras: 2, dias: 30 };
await AS.setItem('configCombustible', JSON.stringify({
  margen_tanque_pct: 8, foto_tiquete: 'OBLIGATORIA', tolerancia_tipo: 'PORCENTAJE', tolerancia_valor: 10,
  rangos: { DIESEL: rango, GASOLINA: { precio: 16000, min: 14400, max: 17600 } },
}));
await db.runAsync(`INSERT INTO tanqueos_pendientes (uuid, placa, cantidad_galones, fecha, fecha_iso, sync_status)
  VALUES ('t1', 'JMU965', 10, datetime('now', 'localtime'), ?, 'pending')`, new Date().toISOString());
v = await datosValidacion(db, 'JMU965');
chk(v.rango?.min === 9900 && v.rango?.max === 12100, 'rango DIESEL de maestros');
chk(v.margen === 8 && v.fotoModo === 'OBLIGATORIA', 'margen y foto de la empresa');
chk(v.hoy.length === 2, 'tanqueo del servidor + uno del celular sin enviar');
v = await datosValidacion(db, 'ABC123');
chk(v.capacidad === null && v.hoy.length === 0, 'capacidad 0 = sin capacidad; sin tanqueos hoy');
chk((await datosValidacion(db, 'NOEXISTE')).capacidad === null, 'placa desconocida: no se cae');

await AS.setItem('configCombustible', JSON.stringify({ rangos: { DIESEL: { precio: 11000 } }, foto_tiquete: 'OTRA' }));
v = await datosValidacion(db, 'JMU965');
chk(v.rango === null && v.fotoModo === 'OPCIONAL' && v.margen === 5, 'config incompleta: sin rango, foto opcional, margen 5 %');

// ── Avisos con el rango de maestros (los mismos casos que motivaron el cambio, ESTADO_COMBUSTIBLE §0)
let a = advertenciasTanqueo(25.5, 27500000, rango, 60, 5);
chk(a.avisos.length === 1 && a.avisos[0].startsWith('Precio por galón $1.078.431 fuera del rango esperado $9.900–$12.100'), 'id 21: $27.500.000 por 25,5 gal → fuera de rango');
a = advertenciasTanqueo(25.5, 275000, rango, 60, 5);
chk(a.avisos.length === 0 && Math.round(a.precio) === 10784, 'id 21 corregido: $275.000 → $10.784/gal, sin aviso');
a = advertenciasTanqueo(16702, 188148, null, null, 5);
chk(a.avisos.length === 1 && /muy bajo/.test(a.avisos[0]), 'id 22 sin rango: $11/gal → "parece muy bajo"');
a = advertenciasTanqueo(70, 770000, rango, 60, 5);
chk(a.avisos.length === 1 && /superan la capacidad del tanque \(60 gal\)/.test(a.avisos[0]), '70 gal en tanque de 60 (+5 %) → aviso de capacidad');
a = advertenciasTanqueo(62, 682000, rango, 60, 5);
chk(a.avisos.length === 0, '62 gal en tanque de 60: dentro del margen de 5 %');

console.log(`\n${ok} comprobaciones OK`);
