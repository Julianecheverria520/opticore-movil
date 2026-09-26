// src/gps/simplificar.js · simplificación de la línea del recorrido para el mapa
// Douglas-Peucker iterativo (sin recursión: miles de puntos no revientan la pila).
// Solo afecta lo que se DIBUJA; los puntos guardados y enviados no se tocan.

/** Distancia (en grados "planos", corrigiendo la longitud por la latitud) de p al segmento a-b. */
function distanciaAlSegmento(p, a, b, kLon) {
  const ax = a[0] * kLon, ay = a[1];
  const bx = b[0] * kLon, by = b[1];
  const px = p[0] * kLon, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const largo2 = dx * dx + dy * dy;
  let t = largo2 ? ((px - ax) * dx + (py - ay) * dy) / largo2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function douglasPeucker(coords, tolerancia, kLon) {
  const n = coords.length;
  const conservar = new Uint8Array(n);
  conservar[0] = 1;
  conservar[n - 1] = 1;
  const pila = [[0, n - 1]];
  while (pila.length) {
    const [i, j] = pila.pop();
    let maxD = 0, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = distanciaAlSegmento(coords[k], coords[i], coords[j], kLon);
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (idx !== -1 && maxD > tolerancia) {
      conservar[idx] = 1;
      pila.push([i, idx], [idx, j]);
    }
  }
  return coords.filter((_, k) => conservar[k]);
}

/**
 * coords: [[lon, lat], ...]. Si hay más de `maximo`, simplifica empezando con ~2 m de
 * tolerancia y la duplica hasta quedar por debajo del máximo. Siempre conserva el
 * primer y el último punto.
 */
export function simplificarLinea(coords, maximo = 2000) {
  if (!coords || coords.length <= maximo) return coords || [];
  const latMedia = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const kLon = Math.cos((latMedia * Math.PI) / 180);
  let tolerancia = 0.00002; // ≈ 2 m
  let res = douglasPeucker(coords, tolerancia, kLon);
  while (res.length > maximo && tolerancia < 0.05) {
    tolerancia *= 2;
    res = douglasPeucker(coords, tolerancia, kLon);
  }
  return res;
}
