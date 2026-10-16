// expo-notifications en memoria: lo programado queda en `programadas` (por identificador).
export const programadas = new Map();
export const quitadas = [];
export const canales = {};
export const estado = { permiso: { granted: false, canAskAgain: true }, pedidos: 0, handler: null, ultimo: null, oyentes: [] };

export const AndroidImportance = { HIGH: 4, MAX: 5 };
export const SchedulableTriggerInputTypes = { DATE: 'date' };

export function setNotificationHandler(h) { estado.handler = h; }
export async function setNotificationChannelAsync(id, c) { canales[id] = c; return c; }
export async function getAllScheduledNotificationsAsync() {
  return [...programadas.values()];
}
export async function cancelScheduledNotificationAsync(id) { programadas.delete(id); }
export async function scheduleNotificationAsync(req) {
  if (estado.fallar) throw new Error('falla simulada del módulo nativo');
  const id = req.identifier || `auto-${programadas.size}`;
  programadas.set(id, { identifier: id, content: req.content, trigger: req.trigger });
  return id;
}
export async function dismissNotificationAsync(id) { quitadas.push(id); }
export async function getPermissionsAsync() { return { ...estado.permiso }; }
export async function requestPermissionsAsync() { estado.pedidos++; estado.permiso = { granted: true, canAskAgain: true }; return estado.permiso; }
export function addNotificationResponseReceivedListener(fn) {
  estado.oyentes.push(fn);
  return { remove: () => { estado.oyentes = estado.oyentes.filter((f) => f !== fn); } };
}
export async function getLastNotificationResponseAsync() { return estado.ultimo; }
export async function clearLastNotificationResponseAsync() { estado.ultimo = null; }
