// Banco de pruebas en Node: módulos reales de la app (src/) con los nativos simulados.
//   node --import ./scripts/banco/registro.mjs scripts/banco/<prueba>.mjs   (desde la raíz del repo)
// Node 22.5+ (node:sqlite). Detecta errores de lógica; NO detecta permisos ni módulos nativos que
// falten en el build (eso solo se ve en el celular).
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
