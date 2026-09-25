// src/red.js · utilidades de red y formato compartidas por las pantallas

/**
 * fetch con tiempo límite. Con señal débil (conectado pero sin datos útiles) un fetch
 * normal puede quedarse esperando minutos; aquí se aborta y se trata como "sin red".
 */
export async function fetchConTimeout(url, opciones = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opciones, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** true si el error viene de la red (sin señal, timeout) y no del servidor */
export function esErrorDeRed(e) {
  return e?.name === 'AbortError' || e instanceof TypeError;
}

/** 150000 -> "$ 150.000" (formato colombiano, sin depender de Intl) */
export function formatearPesos(n) {
  const v = Math.round(Number(n) || 0);
  return `$ ${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}
