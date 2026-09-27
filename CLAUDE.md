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

## Regla: estado de la base y migraciones SQL

- **NUNCA** afirmar el estado de la base de producción (columnas, tablas, datos, "el SQL ya
  está corrido", "el relleno ya se aplicó") sin haberlo verificado. Si solo lo dijo Julián o se
  deduce, decirlo así ("según Julián…") y pedir la verificación; no copiarlo como hecho a
  `ESTADO_GPS.md` ni a las respuestas.
- Todo cambio que dependa de SQL (columnas o tablas nuevas en `database.py`) debe traer una
  **consulta de verificación de solo lectura** (p. ej. `information_schema.columns`) que Julián
  corre en Supabase y **confirma ANTES del push** del backend. Sin esa confirmación no se da por
  lista la migración ni se sugiere desplegar.
- Al arrancar, el backend registra `ESQUEMA: FALTAN … COLUMNA(S)` en el log si el modelo tiene
  columnas que la base no (`core/verificar_esquema.py`). Después de cada despliegue, revisar
  que no aparezca.
