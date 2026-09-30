// expo-image-manipulator: "reduce" la foto creando un archivo más pequeño en la caché.
import { __crear } from './mock-file-system.mjs';

let n = 0;
export const SaveFormat = { JPEG: 'jpeg' };
export const ImageManipulator = {
  manipulate() {
    const ctx = {
      resize: () => ctx,
      renderAsync: async () => ({
        width: 1600,
        saveAsync: async () => {
          const uri = `file:///cache/reducida_${++n}.jpg`;
          __crear(uri, { size: 350 * 1024 });
          return { uri };
        },
      }),
    };
    return ctx;
  },
};
