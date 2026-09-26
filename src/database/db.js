import * as SQLite from 'expo-sqlite';

const MIGRACIONES = [
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS equipos (
        id INTEGER PRIMARY KEY NOT NULL, placa TEXT, tipo TEXT, estado TEXT,
        ultimo_odometro REAL DEFAULT 0, ultimo_horometro REAL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS categorias (id INTEGER PRIMARY KEY NOT NULL, nombre TEXT);
      CREATE TABLE IF NOT EXISTS preguntas (
        id INTEGER PRIMARY KEY NOT NULL, categoria TEXT, pregunta TEXT,
        es_critica INTEGER, tipo_activo_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS reportes_pendientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, equipo_id TEXT, usuario_id INTEGER,
        odometro REAL DEFAULT 0, horometro REAL DEFAULT 0, estado_equipo TEXT,
        fecha TEXT, respuestas_json TEXT, sync_status TEXT DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS tanqueos_pendientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, placa TEXT, cantidad_galones REAL,
        valor_total REAL, proveedor TEXT, tanque_lleno INTEGER,
        odometro_tanqueo REAL, horometro_tanqueo REAL, fecha TEXT,
        sync_status TEXT DEFAULT 'pending'
      );
    `);
  },
  async (db) => {
    const columnas = async (t) => (await db.getAllAsync(`PRAGMA table_info(${t})`)).map((c) => c.name);
    const agregar = async (tabla, def) => {
      if (!(await columnas(tabla)).includes(def.split(' ')[0])) {
        await db.execAsync(`ALTER TABLE ${tabla} ADD COLUMN ${def}`);
      }
    };
    const comunes = ['uuid TEXT', 'usuario TEXT', 'fecha_iso TEXT', 'observaciones TEXT',
      'latitud REAL', 'longitud REAL', 'intentos INTEGER DEFAULT 0', 'ultimo_error TEXT'];

    for (const d of [...comunes, 'odometro_anterior REAL DEFAULT 0', 'horometro_anterior REAL DEFAULT 0'])
      await agregar('reportes_pendientes', d);
    for (const d of comunes) await agregar('tanqueos_pendientes', d);
    for (const d of ['tiene_horometro INTEGER', 'tiene_odometro INTEGER']) await agregar('equipos', d);

    await db.execAsync(`
      UPDATE reportes_pendientes SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL;
      UPDATE tanqueos_pendientes SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL;
      CREATE INDEX IF NOT EXISTS idx_equipos_placa ON equipos(placa);
      CREATE INDEX IF NOT EXISTS idx_rep_status ON reportes_pendientes(sync_status);
      CREATE INDEX IF NOT EXISTS idx_tanq_status ON tanqueos_pendientes(sync_status);
    `);
  },
  // v3 · Fase 1 offline
  async (db) => {
    const columnas = (await db.getAllAsync('PRAGMA table_info(equipos)')).map((c) => c.name);
    for (const def of ['tipo_activo_id INTEGER', 'capacidad_tanque_gal REAL', 'meta_rendimiento REAL']) {
      if (!columnas.includes(def.split(' ')[0])) await db.execAsync(`ALTER TABLE equipos ADD COLUMN ${def}`);
    }
    // Antes las preguntas generales se guardaban con tipo_activo_id = 0; ahora NULL (igual que el servidor)
    await db.execAsync('UPDATE preguntas SET tipo_activo_id = NULL WHERE tipo_activo_id = 0;');

    // E2 · Los tanqueos capturados con la versión anterior pudieron guardar "150.000" como 150.
    // No se corrigen solos (no hay forma segura de saberlo); se marcan para revisión en la web.
    await db.execAsync(`
      UPDATE tanqueos_pendientes
         SET observaciones = TRIM(COALESCE(observaciones, '') ||
             ' [REVISAR VALOR: posible error de separador de miles en la versión anterior de la app]')
       WHERE sync_status != 'synced' AND cantidad_galones > 0
         AND valor_total / cantidad_galones < 1000;
    `);
  },
  // v4 · Viajes con GPS (pasos 7 y 8 del plan)
  async (db) => {
    const columnas = (await db.getAllAsync('PRAGMA table_info(equipos)')).map((c) => c.name);
    for (const def of ['requiere_cantidad INTEGER', 'capacidad_m3 REAL', 'capacidad_ton REAL', 'ultimo_preop_fecha TEXT']) {
      if (!columnas.includes(def.split(' ')[0])) await db.execAsync(`ALTER TABLE equipos ADD COLUMN ${def}`);
    }
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS materiales (
        id INTEGER PRIMARY KEY NOT NULL, nombre TEXT, unidad TEXT
      );
      CREATE TABLE IF NOT EXISTS rutas (
        id INTEGER PRIMARY KEY NOT NULL, nombre TEXT, distancia_km REAL,
        origen TEXT, destino TEXT,
        origen_lat REAL, origen_lon REAL, destino_lat REAL, destino_lon REAL
      );

      -- Un viaje creado en el celular. uuid = uuid_cliente del servidor (idempotencia).
      -- Cada etapa del envío tiene su propio estado ('pending' | 'synced' | 'error'):
      -- inicio -> foto_inicio -> (puntos, pasos 9-10) -> foto_fin -> fin.
      CREATE TABLE IF NOT EXISTS viajes_locales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT NOT NULL UNIQUE,
        usuario TEXT,
        placa TEXT NOT NULL,
        material TEXT, origen TEXT, destino TEXT, ruta_id INTEGER, ruta_nombre TEXT,
        remision TEXT, cantidad REAL,
        fecha TEXT,                       -- datetime local (limpieza de enviados, igual que las otras colas)
        fecha_inicio_iso TEXT, fecha_fin_iso TEXT,
        lat_inicio REAL, lon_inicio REAL, lat_fin REAL, lon_fin REAL,
        foto_inicio_path TEXT, foto_fin_path TEXT,
        estado_local TEXT NOT NULL DEFAULT 'EN_CURSO',   -- EN_CURSO | FINALIZADO
        id_viaje_servidor TEXT,
        requiere_revision INTEGER DEFAULT 0, motivo_revision TEXT,
        sync_inicio TEXT DEFAULT 'pending',
        sync_foto_inicio TEXT DEFAULT 'pending',
        sync_foto_fin TEXT DEFAULT 'pending',
        sync_fin TEXT DEFAULT 'pending',
        sync_status TEXT DEFAULT 'pending',               -- global: pending | synced | error
        intentos INTEGER DEFAULT 0, ultimo_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_viajes_estado ON viajes_locales(estado_local);
      CREATE INDEX IF NOT EXISTS idx_viajes_status ON viajes_locales(sync_status);

      -- Puntos del recorrido (se llenan en los pasos 9 y 10). seq = consecutivo por viaje.
      CREATE TABLE IF NOT EXISTS puntos_gps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        viaje_uuid TEXT NOT NULL,
        seq INTEGER NOT NULL,
        latitud REAL, longitud REAL, precision REAL, velocidad REAL,
        ts_iso TEXT,
        enviado INTEGER DEFAULT 0,
        UNIQUE (viaje_uuid, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_puntos_envio ON puntos_gps(viaje_uuid, enviado);
    `);
  },
  // v5 · GPS (pasos 9 y 10): contadores del recorrido y marca de ubicación simulada
  async (db) => {
    const cols = async (t) => (await db.getAllAsync(`PRAGMA table_info(${t})`)).map((c) => c.name);
    const cv = await cols('viajes_locales');
    for (const def of ['gps_descartados INTEGER DEFAULT 0', 'gps_simulados INTEGER DEFAULT 0', 'gps_ultimo_evento TEXT']) {
      if (!cv.includes(def.split(' ')[0])) await db.execAsync(`ALTER TABLE viajes_locales ADD COLUMN ${def}`);
    }
    // enviado: 0 pendiente · 1 enviado · -1 rechazado por el servidor (no se reintenta)
    if (!(await cols('puntos_gps')).includes('simulado')) {
      await db.execAsync('ALTER TABLE puntos_gps ADD COLUMN simulado INTEGER DEFAULT 0');
    }
  },
  // v6 · precisión de la última lectura RECIBIDA (aunque se haya descartado por mala):
  // distingue "esperando señal GPS" de "detenido / sin movimiento"
  async (db) => {
    const cv = (await db.getAllAsync('PRAGMA table_info(viajes_locales)')).map((c) => c.name);
    if (!cv.includes('gps_ultima_precision')) await db.execAsync('ALTER TABLE viajes_locales ADD COLUMN gps_ultima_precision REAL');
  },
  // v7 · diagnóstico del envío: por etapa, el resultado del último intento
  //       {"inicio": {"codigo": 200, "mensaje": "OK", "hora": "..."}, "foto_inicio": {...}, ...}
  async (db) => {
    const cv = (await db.getAllAsync('PRAGMA table_info(viajes_locales)')).map((c) => c.name);
    if (!cv.includes('diag_envio')) await db.execAsync('ALTER TABLE viajes_locales ADD COLUMN diag_envio TEXT');
  },
];

async function migrar(db) {
  const { user_version } = await db.getFirstAsync('PRAGMA user_version');
  for (let v = user_version; v < MIGRACIONES.length; v++) {
    await db.withTransactionAsync(async () => {
      await MIGRACIONES[v](db);
      await db.execAsync(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

let _db = null;
let _abriendo = null;

export async function getDb() {
  if (_db) return _db;
  if (!_abriendo) {
    _abriendo = (async () => {
      const db = await SQLite.openDatabaseAsync('opticore_offline.db');
      await db.execAsync('PRAGMA journal_mode = WAL;');
      await migrar(db);
      _db = db;
      return db;
    })().catch((e) => { _abriendo = null; throw e; });
  }
  return _abriendo;
}

export async function iniciarBaseDeDatos() {
  const db = await getDb();
  console.log('Base de datos local lista (offline).');
  return db;
}

export function nuevoUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function ahoraISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const signo = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${signo}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

export function parseNum(t) {
  const n = parseFloat(String(t ?? '').trim().replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

/**
 * Pesos colombianos escritos como los escribe un operador:
 * "150000", "150.000", "150,000", "1.500.000", "1.500.000,50", "$ 150.000"
 */
export function parseMoneda(t) {
  let s = String(t ?? '').trim().replace(/[\s$]/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

export function esMaquinaria(eq) {
  if (!eq) return false;
  if (eq.tiene_horometro !== null && eq.tiene_horometro !== undefined) return eq.tiene_horometro === 1;
  return /retro|excavadora|cargador|compresor/i.test(eq.tipo || '');
}
