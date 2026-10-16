// plugins/icono-notificacion.js
// Ícono de la notificación del GPS ("Viaje en curso"). expo-location usa el drawable
// `notification_icon` si existe; si no, el ícono de la app, que Android pinta como un cuadrado
// blanco. La clave `notification` de app.json ya no existe en Expo 57, así que este plugin copia
// los PNG (blancos sobre transparente, generados con scripts/generar_icono_notificacion.py) a
// res/drawable-<densidad>/notification_icon.png.
// 1.5.0 · expo-notifications (recordatorio del preoperacional) escribe el mismo drawable a partir
// de assets/notificacion/xxxhdpi.png (reducido a cada densidad): el mismo cubo, gane quien gane.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const DENSIDADES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];

module.exports = function conIconoNotificacion(config) {
  return withDangerousMod(config, ['android', async (cfg) => {
    const origen = path.join(cfg.modRequest.projectRoot, 'assets', 'notificacion');
    const res = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
    for (const d of DENSIDADES) {
      const dir = path.join(res, `drawable-${d}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(origen, `${d}.png`), path.join(dir, 'notification_icon.png'));
    }
    return cfg;
  }]);
};
