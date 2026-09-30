// expo-file-system (API de clases) en memoria. Las subidas (UploadTask) las responde
// globalThis.__subir(url, uri) → { status, body } (o lanza para simular SIN RESPUESTA).
export const __archivos = new Map(); // uri -> { size, mtime }
const carpetas = new Set();

const base = (x) => (typeof x === 'string' ? x : x.uri);
const conBarra = (u) => (u.endsWith('/') ? u : `${u}/`);

export const Paths = { document: { uri: 'file:///doc/' }, cache: { uri: 'file:///cache/' } };

/** Para las pruebas: crea un archivo (mtime en ms). */
export function __crear(uri, { size = 300 * 1024, mtime = Date.now() } = {}) {
  __archivos.set(uri, { size, mtime });
}

export class Directory {
  constructor(padre, nombre) {
    this.uri = nombre ? `${conBarra(base(padre))}${nombre}/` : conBarra(base(padre));
  }
  get exists() { return carpetas.has(this.uri) || [...__archivos.keys()].some((u) => u.startsWith(this.uri)); }
  create() { carpetas.add(this.uri); }
  list() {
    return [...__archivos.keys()]
      .filter((u) => u.startsWith(this.uri) && !u.slice(this.uri.length).includes('/'))
      .map((u) => new File(u));
  }
}

export class File {
  constructor(a, b) { this.uri = b !== undefined ? `${conBarra(base(a))}${b}` : base(a); }
  get name() { return this.uri.split('/').pop(); }
  get exists() { return __archivos.has(this.uri); }
  get size() { return __archivos.get(this.uri)?.size ?? null; }
  get modificationTime() { return __archivos.get(this.uri)?.mtime ?? null; }
  delete() {
    if (!__archivos.has(this.uri)) throw new Error(`No existe ${this.uri}`);
    __archivos.delete(this.uri);
  }
  copy(destino) {
    const d = destino instanceof File ? destino : new File(destino);
    __archivos.set(d.uri, { ...(__archivos.get(this.uri) || { size: 0 }), mtime: Date.now() });
  }
}

export const UploadType = { BINARY_CONTENT: 0, MULTIPART: 1 };

export class UploadTask {
  constructor(file, url) { this.uri = file.uri; this.url = url; }
  async uploadAsync() { return globalThis.__subir(this.url, this.uri); }
  cancel() {}
  release() {}
}
