// expo-secure-store en memoria
const m = new Map();
export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK';
export async function getItemAsync(k) { return m.has(k) ? m.get(k) : null; }
export async function setItemAsync(k, v) { m.set(k, String(v)); }
export async function deleteItemAsync(k) { m.delete(k); }
