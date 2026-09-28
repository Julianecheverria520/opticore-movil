// src/combustibleNumeros.js · números escritos por un operador en Colombia (coma o punto, con o sin miles).
// Copia de static/js/combustible_numeros.js de AppTransporte (PWA /app): mismas reglas y mismos textos,
// para que el operador vea lo mismo en la app y en la PWA. Si cambia uno, cambiar el otro.
// Funciones puras, sin módulos nativos: node scripts/probar_combustible_numeros.mjs

function limpiar(t) {
  return String(t ?? '').trim().replace(/[\s$]/g, '');
}

/**
 * Galones (u otro decimal): "16,702" = "16.702" = 16,702. Con los dos separadores, el último
 * es el decimal ("1.234,5" = 1234,5). Un separador repetido es de miles ("1.234.567").
 * Devuelve NaN si no es un número.
 */
export function parseDecimal(t) {
  let s = limpiar(t);
  if (!s) return NaN;
  if (!/^\d[\d.,]*$/.test(s) && !/^[.,]\d+$/.test(s)) return NaN;
  const ultPunto = s.lastIndexOf('.'), ultComa = s.lastIndexOf(',');
  if (ultPunto >= 0 && ultComa >= 0) {
    const dec = ultPunto > ultComa ? '.' : ',';
    const mil = dec === '.' ? ',' : '.';
    s = s.split(mil).join('');
    if (s.split(dec).length > 2) return NaN;
    s = s.replace(dec, '.');
  } else {
    const sep = ultPunto >= 0 ? '.' : (ultComa >= 0 ? ',' : null);
    if (sep) {
      const partes = s.split(sep);
      if (partes.length > 2) {
        if (!partes.slice(1).every((p) => p.length === 3)) return NaN;
        s = partes.join('');
      } else {
        s = partes.join('.');
      }
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Pesos: "275000", "275.000", "275,000", "27.500.000", "$ 275.000", "1.500.000,50".
 * Un punto o coma seguido de exactamente 3 dígitos es de miles (en pesos no hay centavos de 3).
 */
export function parseMoneda(t) {
  let s = limpiar(t);
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) {
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
    s = s.replace(/[.,]/g, '');
  } else {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) && /^\d*\.?\d+$/.test(s) ? n : NaN;
}

/**
 * Odómetro / horómetro. "125.430" puede ser 125430 (miles) o 125,43 (decimal): se elige la que
 * queda en o por encima de la lectura anterior y más cerca de ella. `ambigua` = las dos
 * interpretaciones son posibles (ambas ≥ anterior): hay que confirmar con el operador.
 * → { valor, alternativa, ambigua }  (valor NaN si no es un número)
 */
export function parseLectura(t, anterior) {
  const s = limpiar(t);
  const base = Number(anterior) || 0;
  const m = s.match(/^(\d{1,3})([.,])(\d{3})$/);
  if (!m) return { valor: parseDecimal(s), alternativa: null, ambigua: false };
  const miles = Number(m[1] + m[3]);
  const decimal = Number(`${m[1]}.${m[3]}`);
  const validas = [miles, decimal].filter((v) => v >= base);
  if (validas.length === 2) {
    const [a, b] = Math.abs(miles - base) <= Math.abs(decimal - base) ? [miles, decimal] : [decimal, miles];
    return { valor: a, alternativa: b, ambigua: true };
  }
  if (validas.length === 1) return { valor: validas[0], alternativa: null, ambigua: false };
  return { valor: miles, alternativa: null, ambigua: false };   // las dos son menores: el aviso de lectura decide
}

/** 188148 → "$188.148" (igual que la PWA; src/red.js formatearPesos lleva espacio: "$ 188.148"). */
export function fmtPesos(n) {
  return '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** 16.702 → "16,702"; 125430 → "125.430"; 125.43 → "125,43" (formato colombiano). */
export function fmtNum(n, maxDec = 3) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const [ent, dec] = v.toFixed(maxDec).replace(/0+$/, '').replace(/\.$/, '').split('.');
  return ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (dec ? ',' + dec : '');
}

/**
 * Advertencias antes de guardar (mismas reglas que el servidor, que vuelve a validar).
 * rango = {min, max, precio, fuente, muestras, dias} | null; capacidad en galones | null.
 */
export function advertenciasTanqueo(galones, valor, rango, capacidad, margenPct) {
  const avisos = [];
  const precio = galones > 0 ? valor / galones : NaN;
  if (rango && Number.isFinite(precio) && !(rango.min <= Math.round(precio) && Math.round(precio) <= rango.max)) {
    const fuente = rango.fuente === 'MEDIANA'
      ? `mediana de ${rango.dias} días, ${rango.muestras} tanqueos`
      : `precio de referencia ${fmtPesos(rango.precio)}`;
    avisos.push(`Precio por galón ${fmtPesos(precio)} fuera del rango esperado ${fmtPesos(rango.min)}–${fmtPesos(rango.max)} (${fuente}).`);
  } else if (!rango && Number.isFinite(precio) && precio < 5000) {
    // Sin referencia de la empresa: solo el caso obvio de ceros de menos
    avisos.push(`Precio por galón ${fmtPesos(precio)}: parece muy bajo.`);
  }
  const cap = Number(capacidad) || 0;
  const margen = Number(margenPct ?? 5);
  if (cap > 0 && galones > cap * (1 + margen / 100)) {
    avisos.push(`${fmtNum(galones)} galones superan la capacidad del tanque (${fmtNum(cap)} gal).`);
  }
  return { precio, avisos };
}
