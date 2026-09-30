// AsyncStorage en memoria
const m = new Map();

export default {
  getItem: async (k) => (m.has(k) ? m.get(k) : null),
  setItem: async (k, v) => { m.set(k, String(v)); },
  removeItem: async (k) => { m.delete(k); },
  clear: async () => { m.clear(); },
};
