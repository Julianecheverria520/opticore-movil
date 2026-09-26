// src/config.js
const PRODUCCION = 'https://opticore-ia.com';

// En desarrollo usa producción, salvo que EXPO_PUBLIC_API_URL indique otro servidor
// (por ejemplo tu PC: http://TU_IP:8082 cuando pruebes cambios del backend sin desplegar).
export const API_URL = __DEV__
  ? (process.env.EXPO_PUBLIC_API_URL || PRODUCCION)
  : PRODUCCION;