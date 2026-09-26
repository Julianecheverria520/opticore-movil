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

## Regla: credenciales y base de producción

- **NUNCA** mostrar, imprimir ni filtrar el contenido de `.env` ni de variables con credenciales
  (`DATABASE_URL`, `SECRET_KEY`, `OPENAI_API_KEY`, `SUPABASE_KEY`, etc.), ni siquiera en parte o
  con filtros (`grep`, `sed`, `echo`). Si hace falta saber a qué base apunta, preguntarle a Julián.
- **NUNCA** correr `api/tests/test_api.py` ni la suite completa del backend (`pytest` sin archivo,
  `pytest api/tests`): usan la base de **PRODUCCIÓN**. Solo correr, uno por uno, los archivos de
  test que no tocan la base (p. ej. `test_token_movil.py`, `test_usuario_habilitado.py`,
  `test_fallas_preoperacional.py`), y decir antes cuáles se van a correr.
