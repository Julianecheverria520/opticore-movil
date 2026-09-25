// app.config.js
// Parte de app.json (que Expo entrega en `config`) y solo cambia lo necesario para
// que el development build se instale AL LADO de la app del piloto, no encima:
//   APP_VARIANT=development  ->  nombre "OptiCore DEV", paquete ...opticoremovil.dev
// Sin APP_VARIANT (perfiles preview y production) todo queda exactamente como en app.json.
const IS_DEV = process.env.APP_VARIANT === 'development';

module.exports = ({ config }) => {
  if (!IS_DEV) return config;

  return {
    ...config,
    name: 'OptiCore DEV',
    android: {
      ...config.android,
      package: 'com.julianecheverria.opticoremovil.dev',
    },
  };
};
