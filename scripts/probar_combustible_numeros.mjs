// Pruebas de src/combustibleNumeros.js (sin celular ni base de datos):
//   node scripts/probar_combustible_numeros.mjs
// 1) Los mismos casos de AppTransporte/scripts/probar_combustible_numeros.js (PWA).
// 2) Si AppTransporte está al lado de este repo, compara la app con la PWA entrada por entrada:
//    las dos deben dar exactamente lo mismo.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as N from '../src/combustibleNumeros.js';

let ok = 0;
function caso(nombre, fn) { fn(); ok++; }

caso('galones: coma o punto decimal', () => {
  assert.equal(N.parseDecimal('16.702'), 16.702);
  assert.equal(N.parseDecimal('16,702'), 16.702);
  assert.equal(N.parseDecimal('25,5'), 25.5);
  assert.equal(N.parseDecimal('16702'), 16702);          // sin separador: la vista previa lo deja ver
  assert.equal(N.parseDecimal('1.234,5'), 1234.5);
  assert.equal(N.parseDecimal('1,234.5'), 1234.5);
  assert.equal(N.parseDecimal(' 7 '), 7);
  assert.ok(Number.isNaN(N.parseDecimal('')));
  assert.ok(Number.isNaN(N.parseDecimal('abc')));
  assert.ok(Number.isNaN(N.parseDecimal('1.2.3')));
  assert.ok(Number.isNaN(N.parseDecimal('-5')));
});

caso('pesos: miles con punto o coma', () => {
  assert.equal(N.parseMoneda('275000'), 275000);
  assert.equal(N.parseMoneda('275.000'), 275000);
  assert.equal(N.parseMoneda('275,000'), 275000);
  assert.equal(N.parseMoneda('$ 27.500.000'), 27500000);
  assert.equal(N.parseMoneda('1.500.000,50'), 1500000.5);
  assert.ok(Number.isNaN(N.parseMoneda('')));
  assert.ok(Number.isNaN(N.parseMoneda('12a')));
});

caso('lectura: miles vs decimal según la anterior', () => {
  // Odómetro alto: "125.430" solo puede ser 125430
  assert.deepEqual(N.parseLectura('125.430', 125000), { valor: 125430, alternativa: null, ambigua: false });
  // Horómetro bajo: las dos sirven → la más cercana, y hay que confirmar
  assert.deepEqual(N.parseLectura('125.430', 100), { valor: 125.43, alternativa: 125430, ambigua: true });
  // Sin lectura anterior: ambigua
  assert.equal(N.parseLectura('3.431', 0).ambigua, true);
  // Sin patrón ambiguo
  assert.deepEqual(N.parseLectura('77088', 77000), { valor: 77088, alternativa: null, ambigua: false });
  assert.deepEqual(N.parseLectura('1234,5', 1000), { valor: 1234.5, alternativa: null, ambigua: false });
  assert.equal(N.parseLectura('1.125.430', 0).valor, 1125430);
});

caso('formato colombiano', () => {
  assert.equal(N.fmtPesos(1078431.37), '$1.078.431');
  assert.equal(N.fmtNum(16.702), '16,702');
  assert.equal(N.fmtNum(16702), '16.702');
  assert.equal(N.fmtNum(125.43), '125,43');
});

caso('advertencias: casos 21 y 22', () => {
  const rango = { min: 10080, max: 12320, precio: 11200, fuente: 'MEDIANA', muestras: 14, dias: 30 };
  const a21 = N.advertenciasTanqueo(25.5, 27500000, rango, null, 5);
  assert.equal(Math.round(a21.precio), 1078431);
  assert.match(a21.avisos[0], /\$1\.078\.431 fuera del rango esperado \$10\.080–\$12\.320/);
  const a22 = N.advertenciasTanqueo(16702, 188148, rango, 60, 5);
  assert.equal(a22.avisos.length, 2);
  assert.match(a22.avisos[1], /16\.702 galones superan la capacidad del tanque \(60 gal\)/);
  assert.equal(N.advertenciasTanqueo(16.702, 188148, rango, 60, 5).avisos.length, 0);
  assert.equal(N.advertenciasTanqueo(25.5, 275000, rango, null, 5).avisos.length, 0);
  // Sin rango: solo el precio obviamente bajo
  assert.equal(N.advertenciasTanqueo(16702, 188148, null, null, 5).avisos.length, 1);
  assert.equal(N.advertenciasTanqueo(25.5, 27500000, null, null, 5).avisos.length, 0);
});

// Solo de la app: lo que escribe el teclado del celular (decimal-pad / number-pad)
caso('app: teclados del celular', () => {
  // decimal-pad muestra "." o "," según el idioma del teléfono: las dos dan lo mismo
  assert.equal(N.parseDecimal('16.702'), N.parseDecimal('16,702'));
  assert.equal(N.parseDecimal(',5'), 0.5);
  // number-pad: solo dígitos, pesos completos
  assert.equal(N.parseMoneda('188148'), 188148);
  assert.equal(N.fmtPesos(N.parseMoneda('188148')), '$188.148');
  // Precio en vivo del ejemplo: 188.148 / 16,702
  assert.equal(N.fmtPesos(188148 / 16.702), '$11.265');
  // Precio de referencia manual (fuente distinta de MEDIANA)
  const manual = { min: 10080, max: 12320, precio: 11200, fuente: 'MANUAL' };
  assert.match(N.advertenciasTanqueo(10, 1000, manual, null, 5).avisos[0], /\(precio de referencia \$11\.200\)\.$/);
  // Margen de capacidad que viene de maestros (no fijo en 5 %)
  assert.equal(N.advertenciasTanqueo(62, 700000, null, 60, 5).avisos.length, 0);
  assert.equal(N.advertenciasTanqueo(62, 700000, null, 60, 0).avisos.length, 1);
});

// ── Comparación con la PWA ────────────────────────────────────────────────────
const aqui = path.dirname(fileURLToPath(import.meta.url));
const rutaPwa = path.resolve(aqui, '../../AppTransporte/static/js/combustible_numeros.js');
let comparados = 0;
if (existsSync(rutaPwa)) {
  const P = createRequire(import.meta.url)(rutaPwa);
  const igual = (a, b, que) => assert.deepEqual(a, b, `App y PWA difieren en ${que}`);

  const textos = ['', ' ', 'abc', '-5', '0', '7', ' 7 ', '16702', '16.702', '16,702', '25,5', ',5', '.5', '1.2.3',
    '1.234,5', '1,234.5', '1.234.567', '1,234,567', '1.23.456', '12a', '$ 275.000', '275,000', '27.500.000',
    '1.500.000,50', '1,500,000.50', '125.430', '125,430', '3.431', '1.125.430', '77088', '1234,5', '999.999', '0,001'];
  const anteriores = [0, 100, 125, 125.43, 1000, 3431, 125000, 125430, 200000];
  for (const t of textos) {
    igual(N.parseDecimal(t), P.parseDecimal(t), `parseDecimal("${t}")`);
    igual(N.parseMoneda(t), P.parseMoneda(t), `parseMoneda("${t}")`);
    for (const a of anteriores) { igual(N.parseLectura(t, a), P.parseLectura(t, a), `parseLectura("${t}", ${a})`); comparados++; }
    comparados += 2;
  }
  for (const n of [0, 1, 11.4999, 11.5, 999, 1000, 16.702, 16702, 125.43, 1078431.37, -2500, NaN, 'x']) {
    igual(N.fmtPesos(n), P.fmtPesos(n), `fmtPesos(${n})`);
    igual(N.fmtNum(n), P.fmtNum(n), `fmtNum(${n})`);
    comparados += 2;
  }
  const rangos = [null,
    { min: 10080, max: 12320, precio: 11200, fuente: 'MEDIANA', muestras: 14, dias: 30 },
    { min: 10080, max: 12320, precio: 11200, fuente: 'MANUAL' }];
  for (const r of rangos) for (const g of [0, 9.783, 16.702, 25.5, 62, 16702]) for (const v of [110, 188148, 275000, 27500000]) {
    for (const cap of [null, 0, 60]) for (const m of [undefined, 0, 5, 10]) {
      igual(N.advertenciasTanqueo(g, v, r, cap, m), P.advertenciasTanqueo(g, v, r, cap, m), `advertenciasTanqueo(${g}, ${v}, ${r?.fuente ?? null}, ${cap}, ${m})`);
      comparados++;
    }
  }
  console.log(`OK · ${ok} grupos de pruebas · ${comparados} comparaciones iguales a la PWA (${rutaPwa})`);
} else {
  console.log(`OK · ${ok} grupos de pruebas · sin comparar con la PWA (no está ${rutaPwa})`);
}
