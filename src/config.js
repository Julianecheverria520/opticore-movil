const LOCAL = 'http://192.168.3.176:8082';
const PRODUCCION = 'https://opticore-ia.com';

export const API_URL = __DEV__ ? LOCAL : PRODUCCION;