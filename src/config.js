// src/config.js
const PRODUCCION = 'https://opticore-ia.com';

// En desarrollo usa producción, salvo que EXPO_PUBLIC_API_URL indique otro servidor
// (por ejemplo tu PC: http://TU_IP:8082 cuando pruebes cambios del backend sin desplegar).
export const API_URL = __DEV__
  ? (process.env.EXPO_PUBLIC_API_URL || PRODUCCION)
  : PRODUCCION;

// Fondos del mapa de "Viaje en curso": los mismos de la web (OSM claro / Carto oscuro),
// sin API key. Para cambiar de proveedor basta con cambiar estas URL ({z}/{x}/{y}).
// Nota: los servidores públicos de OSM son para uso moderado; si el piloto crece, usar
// un proveedor propio o de pago y cambiarlo aquí.
export const MAPA_FONDOS = {
  claro: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap',
  },
  oscuro: {
    tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`),
    attribution: '© OpenStreetMap © CARTO',
  },
};
