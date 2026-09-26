@AGENTS.md

Al empezar, lee docs/ESTADO_GPS.md.

## Regla: pruebas manuales al final de cada paso

Al terminar CADA paso de trabajo (no solo al final de una fase), la respuesta debe cerrar con una sección
**"Pruebas manuales para Julián"** que diga:

1. **¿Ya se puede probar?** Sí / No / Parcialmente (y por qué, si no).
2. **Dónde:** web, app, PC o celular (y en qué pantalla). En la app, aclarar si sirve Expo Go o si hace falta el development build.
3. **Pasos concretos**, numerados, que Julián pueda seguir sin leer el código.
4. **Resultado esperado** de cada paso (lo que debe verse en pantalla, en la web o en el servidor).

Si la prueba depende de un backend todavía no desplegado, indicar que se hace contra el servidor local (`__DEV__` en `src/config.js`).
