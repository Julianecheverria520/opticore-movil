// src/borrador.js · borrador del formulario de tanqueo (AsyncStorage, uno por placa).
// Si la app se cierra con el formulario abierto (el sistema la mata, se cierra desde recientes),
// lo digitado y la foto no se pierden: al volver a abrir combustible para esa placa se ofrece
// continuar. Conserva el uuid del formulario: continuar y guardar nunca duplica en el servidor.
// Sin módulos nativos fuera de AsyncStorage: lo usa también la limpieza de tiquetes/ (src/tiquetes.js).
import AsyncStorage from '@react-native-async-storage/async-storage';

const CLAVE = 'borradoresTanqueo'; // { PLACA: { placa, uuid, viajeUuid, lectura, galones, valor, proveedor,
//                                    tanqueLleno, lecturaConfirmada, fotoUri, creado, editado } }
export const VIGENCIA_BORRADOR_MS = 12 * 3600000;

async function leerTodos() {
  try {
    const t = JSON.parse((await AsyncStorage.getItem(CLAVE)) || '{}');
    return t && typeof t === 'object' ? t : {};
  } catch {
    return {};
  }
}

/** Vigente = editado hace menos de 12 h. */
export function borradorVigente(b, ahora = Date.now()) {
  return !!b && Number.isFinite(Number(b.editado)) && ahora - Number(b.editado) < VIGENCIA_BORRADOR_MS;
}

export async function leerBorrador(placa) {
  return (await leerTodos())[placa] || null;
}

export async function guardarBorrador(b) {
  const todos = await leerTodos();
  const antes = todos[b.placa];
  todos[b.placa] = { ...b, creado: antes?.uuid === b.uuid ? antes.creado : Date.now(), editado: Date.now() };
  await AsyncStorage.setItem(CLAVE, JSON.stringify(todos));
}

export async function borrarBorrador(placa) {
  const todos = await leerTodos();
  if (!(placa in todos)) return;
  delete todos[placa];
  await AsyncStorage.setItem(CLAVE, JSON.stringify(todos));
}

/** Nombres de archivo (tiquetes/) de las fotos de borradores vigentes: la limpieza no las toca. */
export async function fotosDeBorradoresVigentes(ahora = Date.now()) {
  return Object.values(await leerTodos())
    .filter((b) => b?.fotoUri && borradorVigente(b, ahora))
    .map((b) => String(b.fotoUri).split(/[/\\]/).pop().split('?')[0]);
}
