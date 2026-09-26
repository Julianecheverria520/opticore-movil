// src/sesion.js · token de la sesión en expo-secure-store (Android Keystore)
// El token de la app dura días (/auth/token-movil); en AsyncStorage quedaba en texto plano.
// Migración: si el token todavía está en AsyncStorage ('userToken'), se copia a SecureStore
// y solo DESPUÉS de guardarlo bien se borra de AsyncStorage (nunca se pierde la sesión).
// Lo usan también la tarea GPS en segundo plano (syncUp) con la pantalla bloqueada: la
// clave no exige desbloqueo en Android (sin requireAuthentication).
import AsyncStorage from '@react-native-async-storage/async-storage';

const CLAVE = 'userToken';

// Se carga con import() y no con import estático: en un build SIN el módulo nativo
// (development build anterior) el import estático cerraría la app al abrir. Sin módulo,
// todo sigue en AsyncStorage como antes.
let _secure; // undefined = sin intentar · null = no disponible
async function secure() {
  if (_secure === undefined) {
    try {
      _secure = await import('expo-secure-store');
    } catch (e) {
      console.warn('expo-secure-store no está en este build; el token sigue en AsyncStorage:', e?.message || e);
      _secure = null;
    }
  }
  return _secure;
}
const opciones = (S) => ({ keychainAccessible: S.AFTER_FIRST_UNLOCK }); // iOS: también en segundo plano

/** Token guardado (o null). Migra el de AsyncStorage la primera vez. */
export async function leerToken() {
  const S = await secure();
  let token = null;
  if (S) {
    try {
      token = await S.getItemAsync(CLAVE, opciones(S));
    } catch (e) {
      console.warn('SecureStore no disponible:', e?.message || e);
    }
  }
  if (token) return token;

  const viejo = await AsyncStorage.getItem(CLAVE);
  if (!viejo || !S) return viejo;
  try {
    await S.setItemAsync(CLAVE, viejo, opciones(S));
    if ((await S.getItemAsync(CLAVE, opciones(S))) === viejo) await AsyncStorage.removeItem(CLAVE);
  } catch (e) {
    // Si SecureStore falla se sigue usando el de AsyncStorage: la cola no se detiene
    console.warn('No se pudo migrar el token a SecureStore:', e?.message || e);
  }
  return viejo;
}

export async function guardarToken(token) {
  const S = await secure();
  if (S) {
    try {
      await S.setItemAsync(CLAVE, token, opciones(S));
      await AsyncStorage.removeItem(CLAVE);
      return;
    } catch (e) {
      console.warn('SecureStore falló; el token queda en AsyncStorage:', e?.message || e);
    }
  }
  await AsyncStorage.setItem(CLAVE, token);
}

export async function borrarToken() {
  const S = await secure();
  if (S) { try { await S.deleteItemAsync(CLAVE, opciones(S)); } catch { /* no estaba */ } }
  await AsyncStorage.removeItem(CLAVE);
}
