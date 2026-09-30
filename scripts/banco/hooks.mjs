// Carga src/ como ESM (package.json no tiene "type": "module"), completa las rutas sin
// extensión ('./db' -> './db.js') y reemplaza los módulos nativos por simulaciones.
const SRC = new URL('../../src/', import.meta.url).href;
const MOCKS = {
  'expo-sqlite': new URL('./mock-sqlite.mjs', import.meta.url).href,
  '@react-native-async-storage/async-storage': new URL('./mock-async-storage.mjs', import.meta.url).href,
  '@react-native-community/netinfo': new URL('./mock-netinfo.mjs', import.meta.url).href,
  'expo-file-system': new URL('./mock-file-system.mjs', import.meta.url).href,
  'expo-image-manipulator': new URL('./mock-image-manipulator.mjs', import.meta.url).href,
  'expo-secure-store': new URL('./mock-secure-store.mjs', import.meta.url).href,
};

export async function resolve(spec, ctx, next) {
  if (MOCKS[spec]) return { url: MOCKS[spec], shortCircuit: true };
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\.[mc]?js$/.test(spec) && ctx.parentURL?.startsWith(SRC)) {
    return next(`${spec}.js`, ctx);
  }
  return next(spec, ctx);
}

export async function load(url, ctx, next) {
  if (url.startsWith(SRC)) {
    const r = await next(url, { ...ctx, format: 'module' });
    return { ...r, format: 'module', shortCircuit: true };
  }
  return next(url, ctx);
}
