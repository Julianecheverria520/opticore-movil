/**
 * Ruta planeada (ruta óptima origen → destino) y peajes sobre ella, leídos de SQLite: funcionan
 * sin señal.
 *
 * El servidor calcula la línea UNA vez al guardar la ruta (api/maestros/rutas_geometria.py) y la
 * manda en /movil/maestros como polyline codificada (precisión 5), junto con los peajes que
 * quedan sobre ella y sus valores por categoría. Aquí solo se decodifica y se arma el resumen
 * con la categoría de peaje del equipo ("Categoria III").
 *
 * Sin geometría (servidor viejo, ruta sin coordenadas o el servicio de rutas falló) todo queda
 * vacío y el mapa se ve como antes.
 */

/** Polyline de Google → [[lon, lat], ...] (orden GeoJSON). Texto vacío o dañado → []. */
export function decodificarPolyline(texto, precision = 5) {
  if (!texto || typeof texto !== 'string') return [];
  const factor = 10 ** precision;
  const coords = [];
  let i = 0, lat = 0, lon = 0;
  try {
    while (i < texto.length) {
      const valores = [];
      for (let k = 0; k < 2; k++) {
        let res = 0, shift = 0, b;
        do {
          if (i >= texto.length) throw new Error('polyline cortada');
          b = texto.charCodeAt(i++) - 63;
          res |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        valores.push(res & 1 ? ~(res >> 1) : res >> 1);
      }
      lat += valores[0];
      lon += valores[1];
      coords.push([lon / factor, lat / factor]);
    }
  } catch {
    return [];
  }
  return coords;
}

/** 35000 → "$ 35.000" (sin depender de Intl). */
export function formatoPesos(n) {
  const v = Math.round(Number(n) || 0);
  return `$ ${String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

/** "Categoria III" → "Cat. III" (para textos cortos). */
export function categoriaCorta(categoria) {
  return categoria ? String(categoria).replace(/^Categor[ií]a\s*/i, 'Cat. ') : '';
}

/**
 * Resumen para el panel. `peajes` ya traen `valor` (número o null) según la categoría del equipo.
 * { cantidad, total, conValor, sinValor, categoria, texto }
 */
export function resumenPeajes(peajes, categoria) {
  const cantidad = peajes.length;
  const conValor = peajes.filter((p) => Number.isFinite(p.valor));
  const total = conValor.reduce((s, p) => s + p.valor, 0);
  const sinValor = cantidad - conValor.length;
  let texto;
  if (!cantidad) texto = 'Sin peajes en esta ruta';
  else if (!categoria) texto = `Peajes en esta ruta: ${cantidad} · categoría del vehículo sin configurar`;
  else if (!conValor.length) texto = `Peajes en esta ruta: ${cantidad} · sin valor para ${categoriaCorta(categoria)}`;
  else texto = `Peajes en esta ruta: ${cantidad} · ${formatoPesos(total)}${sinValor ? ` (+${sinValor} sin valor)` : ''}`;
  return { cantidad, total, conValor: conValor.length, sinValor, categoria: categoria || null, texto };
}

async function rutaDe(db, viaje) {
  if (viaje.ruta_id != null) {
    const r = await db.getFirstAsync('SELECT * FROM rutas WHERE id = ?', viaje.ruta_id);
    if (r) return r;
  }
  return db.getFirstAsync('SELECT * FROM rutas WHERE origen = ? AND destino = ? LIMIT 1', viaje.origen, viaje.destino);
}

/**
 * Todo lo del viaje: fila de la ruta, línea planeada [[lon, lat]], peajes con el valor de la
 * categoría del equipo y el resumen. `resumen` es null si la ruta no tiene línea (mapa como antes).
 */
export async function datosRutaPlaneada(db, viaje) {
  const ruta = await rutaDe(db, viaje);
  const linea = decodificarPolyline(ruta?.geometria);
  if (!ruta || linea.length < 2) return { ruta: ruta || null, linea: [], peajes: [], categoria: null, resumen: null };

  const eq = await db.getFirstAsync('SELECT categoria_peaje FROM equipos WHERE placa = ?', (viaje.placa || '').trim().toUpperCase());
  const categoria = eq?.categoria_peaje || null;
  const filas = await db.getAllAsync('SELECT * FROM peajes_ruta WHERE ruta_id = ? ORDER BY orden', ruta.id);
  const peajes = filas
    .filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
    .map((p) => {
      let valores = {};
      try { valores = JSON.parse(p.valores_json || '{}') || {}; } catch { /* sin valores */ }
      const v = categoria != null ? Number(valores[categoria]) : NaN;
      return {
        id: p.peaje_id, nombre: p.nombre || 'Peaje', lat: Number(p.lat), lon: Number(p.lon),
        sentido: p.sentido || '', orden: p.orden, km: p.km, valor: Number.isFinite(v) && v > 0 ? v : null,
      };
    });
  return { ruta, linea, peajes, categoria, resumen: resumenPeajes(peajes, categoria) };
}

/**
 * Bajada de maestros (sync.js, dentro de su transacción): reemplaza los peajes de TODAS las rutas.
 * Solo si el servidor es nuevo (cada ruta trae la lista `peajes`); si no, no toca nada.
 */
export async function guardarPeajesRutas(tx, rutas) {
  if (!rutas.length || !rutas.every((r) => Array.isArray(r.peajes))) return false;
  await tx.runAsync('DELETE FROM peajes_ruta');
  const st = await tx.prepareAsync(
    `INSERT OR REPLACE INTO peajes_ruta (ruta_id, peaje_id, orden, nombre, lat, lon, sentido, km, valores_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  try {
    for (const r of rutas) {
      for (const p of r.peajes) {
        if (p?.id == null) continue;
        await st.executeAsync(
          r.id, p.id, p.orden ?? null, p.nombre || '', p.lat ?? null, p.lon ?? null,
          p.sentido || '', p.km_desde_origen ?? null, JSON.stringify(p.valores || {})
        );
      }
    }
  } finally { await st.finalizeAsync(); }
  return true;
}
