// src/components/MapaRecorrido.js · mapa del viaje a pantalla completa (MapLibre)
// Solo LEE: los puntos de SQLite (funciona sin señal), la ruta de los maestros y la última
// ubicación conocida del sistema. No arranca GPS propio ni toca la tarea 'opticore-gps'
// ni la cola de envío.
// Batería: refresca como máximo cada 10 s y SOLO con la app al frente y la pantalla del
// viaje visible (prop `activo`); con la pantalla apagada o en segundo plano no hace nada.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, AppState, useColorScheme } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import { FontAwesome5 } from '@expo/vector-icons';
import { Map, Camera, GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';

import { MAPA_FONDOS } from '../config';
import { getDb } from '../database/db';
import { puntosDesde } from '../gps/puntos';
import { simplificarLinea } from '../gps/simplificar';

const REFRESCO_MS = 10000;       // como máximo cada 10 s
const MAX_PUNTOS_LINEA = 2000;   // más que esto se simplifica (solo el dibujo)
const ZOOM_SEGUIR = 15;

function estiloFondo(tema) {
  const f = MAPA_FONDOS[tema] || MAPA_FONDOS.claro;
  return {
    version: 8,
    sources: { fondo: { type: 'raster', tiles: f.tiles, tileSize: 256, maxzoom: 19, attribution: f.attribution } },
    layers: [
      // Color de base: sin señal (sin fondo) la línea se sigue viendo sobre él
      { id: 'base', type: 'background', paint: { 'background-color': tema === 'oscuro' ? '#1f2937' : '#e5e7eb' } },
      { id: 'fondo', type: 'raster', source: 'fondo' },
    ],
  };
}

async function rutaDelViaje(viaje) {
  const db = await getDb();
  const r = viaje.ruta_id != null
    ? await db.getFirstAsync('SELECT * FROM rutas WHERE id = ?', viaje.ruta_id)
    : await db.getFirstAsync('SELECT * FROM rutas WHERE origen = ? AND destino = ? LIMIT 1', viaje.origen, viaje.destino);
  const ok = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && !(Number(a) === 0 && Number(b) === 0);
  return {
    origen: r && ok(r.origen_lat, r.origen_lon) ? [Number(r.origen_lon), Number(r.origen_lat)] : null,
    destino: r && ok(r.destino_lat, r.destino_lon) ? [Number(r.destino_lon), Number(r.destino_lat)] : null,
  };
}

/** Última ubicación que ya tiene el sistema (no enciende el GPS). */
async function ubicacionConocida() {
  try {
    if ((await Location.getForegroundPermissionsAsync()).status !== 'granted') return null;
    const u = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60000 });
    return u ? { coord: [u.coords.longitude, u.coords.latitude], ts: u.timestamp } : null;
  } catch {
    return null;
  }
}

function vistaInicial(coords, padding) {
  if (!coords.length) return { center: [-74.08, 4.6], zoom: 5 }; // Colombia
  let [w, s, e, n] = [coords[0][0], coords[0][1], coords[0][0], coords[0][1]];
  for (const [lon, lat] of coords) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
  if (e - w < 0.002 && n - s < 0.002) return { center: [(w + e) / 2, (s + n) / 2], zoom: ZOOM_SEGUIR, padding };
  return { bounds: [w, s, e, n], padding };
}

/**
 * Props: viaje · activo (pantalla visible) · margenSup / margenInf (alto de la franja
 * superior y del panel inferior, para no tapar controles ni el encuadre).
 */
export default function MapaRecorrido({ viaje, activo = true, margenSup = 0, margenInf = 0 }) {
  const temaSistema = useColorScheme();
  const [tema, setTema] = useState(temaSistema === 'dark' ? 'oscuro' : 'claro');
  const [listo, setListo] = useState(false);
  const [version, setVersion] = useState(0);     // cambia cuando llegan puntos nuevos
  const [sinSenal, setSinSenal] = useState(false);
  const [falloFondo, setFalloFondo] = useState(false);
  const [siguiendo, setSiguiendo] = useState(viaje.estado_local === 'EN_CURSO');
  const [appActiva, setAppActiva] = useState(AppState.currentState === 'active');

  const linea = useRef([]);          // [[lon, lat], ...] acumulado
  const ultimoSeq = useRef(0);
  const ultimoTsPunto = useRef(0);
  const ruta = useRef({ origen: null, destino: null });
  const posicion = useRef(null);
  const vista = useRef(null);
  const seqCentrado = useRef(0);     // último punto al que ya se recentró
  const camara = useRef(null);
  const siguiendoRef = useRef(siguiendo);
  siguiendoRef.current = siguiendo;
  const viajeRef = useRef(viaje); // la pantalla crea un objeto nuevo cada 10 s: solo importa el uuid
  viajeRef.current = viaje;

  const padding = useMemo(() => ({ top: margenSup + 30, right: 40, bottom: margenInf + 30, left: 40 }), [margenSup, margenInf]);

  // zoom = null: solo mueve el centro y respeta el zoom que eligió el conductor
  const centrarEn = useCallback((coord, zoom = null) => {
    if (!coord) return;
    const op = { center: coord, duration: 800, padding };
    if (zoom != null) op.zoom = zoom;
    try { camara.current?.easeTo(op); } catch { /* cámara aún no lista */ }
  }, [padding]);

  const cargar = useCallback(async () => {
    try {
      const v = viajeRef.current;
      const nuevos = await puntosDesde(v.uuid, ultimoSeq.current);
      if (nuevos.length) {
        for (const p of nuevos) linea.current.push([p.longitud, p.latitud]);
        ultimoSeq.current = nuevos[nuevos.length - 1].seq;
        ultimoTsPunto.current = Date.parse(nuevos[nuevos.length - 1].ts_iso) || 0;
      }
      // Posición actual: la ubicación del sistema si es más reciente que el último punto
      const u = v.estado_local === 'EN_CURSO' ? await ubicacionConocida() : null;
      const ultimoPunto = linea.current[linea.current.length - 1] || null;
      posicion.current = u && u.ts > ultimoTsPunto.current ? u.coord : ultimoPunto;
      setVersion((x) => x + 1);
    } catch (e) {
      console.warn('Mapa: no se pudieron leer los puntos:', e?.message || e);
    }
  }, []);

  // Primera carga: ruta + puntos, y con eso el encuadre inicial (todo el recorrido)
  useEffect(() => {
    let vivo = true;
    (async () => {
      ruta.current = await rutaDelViaje(viajeRef.current).catch(() => ({ origen: null, destino: null }));
      await cargar();
      if (!vivo) return;
      const todo = [...linea.current, ruta.current.origen, ruta.current.destino, posicion.current].filter(Boolean);
      vista.current = vistaInicial(todo, padding);
      seqCentrado.current = ultimoSeq.current; // al abrir se ve todo el recorrido
      setListo(true);
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viaje.uuid]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActiva(s === 'active'));
    return () => sub.remove();
  }, []);

  // Refresco cada 10 s, solo con la app al frente y la pantalla visible
  useEffect(() => {
    if (!listo || !activo || !appActiva) return undefined;
    cargar();
    const t = setInterval(cargar, REFRESCO_MS);
    return () => clearInterval(t);
  }, [listo, activo, appActiva, cargar]);

  // Seguir la posición actual (hasta que el conductor mueva el mapa con el dedo): solo
  // cuando llega un punto nuevo, sin cambiar el zoom
  useEffect(() => {
    if (!listo || !siguiendoRef.current || ultimoSeq.current === seqCentrado.current) return;
    seqCentrado.current = ultimoSeq.current;
    centrarEn(posicion.current);
  }, [version, listo, centrarEn]);

  // Sin señal: el fondo no carga, la línea sí
  useEffect(() => {
    const quitar = NetInfo.addEventListener((s) => setSinSenal(!s.isConnected || s.isInternetReachable === false));
    return () => quitar();
  }, []);

  const datosLinea = useMemo(() => {
    const coords = simplificarLinea(linea.current, MAX_PUNTOS_LINEA);
    return {
      type: 'FeatureCollection',
      features: coords.length >= 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const datosPuntos = useMemo(() => {
    const f = [];
    const add = (c, tipo) => { if (c) f.push({ type: 'Feature', properties: { tipo }, geometry: { type: 'Point', coordinates: c } }); };
    add(ruta.current.origen, 'origen');
    add(ruta.current.destino, 'destino');
    add(posicion.current, 'actual');
    return { type: 'FeatureCollection', features: f };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const estilo = useMemo(() => estiloFondo(tema), [tema]);

  if (!listo) {
    return <View style={[StyleSheet.absoluteFill, styles.centro]}><ActivityIndicator color="#f59e0b" size="large" /></View>;
  }

  const centrarEnMi = () => {
    setSiguiendo(true);
    centrarEn(posicion.current, ZOOM_SEGUIR);
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={estilo}
        logo={false}
        compass={false}
        attribution
        attributionPosition={{ bottom: margenInf + 6, right: 8 }}
        onRegionWillChange={(e) => { if (e?.nativeEvent?.userInteraction) setSiguiendo(false); }}
        onDidFailLoadingMap={() => setFalloFondo(true)}
        onDidFinishLoadingMap={() => setFalloFondo(false)}
      >
        <Camera ref={camara} initialViewState={vista.current} />
        <GeoJSONSource id="recorrido" data={datosLinea}>
          <Layer id="recorrido-borde" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.8 }} />
          <Layer id="recorrido-linea" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#1d4ed8', 'line-width': 5 }} />
        </GeoJSONSource>
        <GeoJSONSource id="marcas" data={datosPuntos}>
          <Layer id="marcas-circulo" type="circle" paint={{
            'circle-radius': ['match', ['get', 'tipo'], 'actual', 9, 10],
            'circle-color': ['match', ['get', 'tipo'], 'origen', '#16a34a', 'destino', '#dc2626', '#2563eb'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 3,
          }} />
        </GeoJSONSource>
      </Map>

      {/* Avisos, centrados bajo la franja superior */}
      <View style={[styles.avisos, { top: margenSup + 8 }]} pointerEvents="none">
        {sinSenal || falloFondo ? <Text style={styles.aviso}>Mapa sin fondo (sin señal)</Text> : null}
        {linea.current.length < 2 ? <Text style={styles.aviso}>Aún no hay recorrido para dibujar</Text> : null}
      </View>

      {/* Controles a la derecha: fondo claro/oscuro y centrar en mí (grandes, para guantes) */}
      <View style={[styles.controles, { top: margenSup + 8 }]}>
        <TouchableOpacity style={styles.btnControl} onPress={() => setTema((t) => (t === 'oscuro' ? 'claro' : 'oscuro'))}
          accessibilityLabel={tema === 'oscuro' ? 'Fondo claro' : 'Fondo oscuro'}>
          <FontAwesome5 name={tema === 'oscuro' ? 'sun' : 'moon'} size={20} color="#0f172a" />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btnControl, siguiendo && styles.btnControlActivo]} onPress={centrarEnMi}
          accessibilityLabel="Centrar en mí">
          <FontAwesome5 name="location-arrow" size={20} color={siguiendo ? '#fff' : '#1d4ed8'} />
        </TouchableOpacity>
      </View>

      <View style={[styles.leyenda, { bottom: margenInf + 8 }]} pointerEvents="none">
        <Text style={styles.leyendaTexto}><Text style={{ color: '#16a34a' }}>●</Text> Origen  <Text style={{ color: '#dc2626' }}>●</Text> Destino  <Text style={{ color: '#2563eb' }}>●</Text> Actual</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  centro: { justifyContent: 'center', alignItems: 'center', backgroundColor: '#1f2937' },
  avisos: { position: 'absolute', left: 70, right: 70, alignItems: 'center' },
  aviso: { backgroundColor: 'rgba(15,23,42,0.85)', color: '#fff', fontSize: 12, fontWeight: '800', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, marginBottom: 6, overflow: 'hidden' },
  controles: { position: 'absolute', right: 10 },
  btnControl: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.95)', alignItems: 'center', justifyContent: 'center', marginBottom: 10, elevation: 4 },
  btnControlActivo: { backgroundColor: '#1d4ed8' },
  leyenda: { position: 'absolute', left: 8, backgroundColor: 'rgba(255,255,255,0.92)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  leyendaTexto: { color: '#0f172a', fontSize: 11, fontWeight: '700' },
});
