// expo-sqlite (API async) sobre node:sqlite. globalThis.DB_PATH elige el archivo (':memory:' por defecto).
import { DatabaseSync } from 'node:sqlite';

function envolver(d) {
  const api = {
    execAsync: async (sql) => d.exec(sql),
    runAsync: async (sql, ...p) => d.prepare(sql).run(...p.flat()),
    getFirstAsync: async (sql, ...p) => d.prepare(sql).get(...p.flat()) ?? null,
    getAllAsync: async (sql, ...p) => d.prepare(sql).all(...p.flat()),
    prepareAsync: async (sql) => {
      const st = d.prepare(sql);
      return { executeAsync: async (...p) => st.run(...p.flat()), finalizeAsync: async () => {} };
    },
    withTransactionAsync: async (fn) => {
      d.exec('BEGIN');
      try { await fn(); d.exec('COMMIT'); } catch (e) { d.exec('ROLLBACK'); throw e; }
    },
    withExclusiveTransactionAsync: async (fn) => {
      d.exec('BEGIN EXCLUSIVE');
      try { await fn(api); d.exec('COMMIT'); } catch (e) { d.exec('ROLLBACK'); throw e; }
    },
  };
  return api;
}

export async function openDatabaseAsync() {
  return envolver(new DatabaseSync(globalThis.DB_PATH || ':memory:'));
}
