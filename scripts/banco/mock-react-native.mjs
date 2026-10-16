// Lo poco de react-native que usan los módulos sin pantalla. globalThis.ALERTA(titulo, texto, botones)
// decide qué botón se toca (por defecto el último).
export const Platform = { OS: 'android', Version: 34 };
export const Alert = {
  alert: (titulo, texto, botones = []) => {
    const b = globalThis.ALERTA ? globalThis.ALERTA(titulo, texto, botones) : botones[botones.length - 1];
    setTimeout(() => b?.onPress?.(), 0);
  },
};
