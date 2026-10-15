// src/components/MapaRecorrido.js · mapa del viaje a pantalla completa (MapLibre)
// Solo LEE: los puntos de SQLite (funciona sin señal), la ruta de los maestros (con su ruta
// planeada punteada y los peajes, si el servidor la calculó) y la última ubicación conocida del
// sistema. No toca la tarea 'opticore-gps' ni la cola de envío.
// Modo navegación (viaje EN_CURSO): la cámara sigue al vehículo con el seguimiento nativo de
// MapLibre (inclinada y girando con la marcha). Ese seguimiento enciende la ubicación del mapa,
// por eso SOLO va con la app al frente, la pantalla del viaje visible (prop `activo`) y el modo
// navegación. La posición es una volqueta: en navegación, fija en el punto donde el seguimiento
// pone al usuario (centro del área que deja contentInset; "adelante" = arriba); en los demás
// modos, un Marker en la posición. Sin NativeUserLocation, MapLibre sigue sin dibujar nada.
// Batería: los puntos se releen como máximo cada 10 s y con las mismas condiciones.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, AppState, useColorScheme } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import { FontAwesome5, MaterialCommunityIcons } from '@expo/vector-icons';
import { Map, Camera, GeoJSONSource, Layer, Marker } from '@maplibre/maplibre-react-native';

import { MAPA_FONDOS } from '../config';
import { getDb } from '../database/db';
import { puntosDesde } from '../gps/puntos';
import { simplificarLinea } from '../gps/simplificar';
import { datosRutaPlaneada, formatoPesos } from '../rutaPlaneada';

const REFRESCO_MS = 10000;       // como máximo cada 10 s
const MAX_PUNTOS_LINEA = 2000;   // más que esto se simplifica (solo el dibujo)
const ZOOM_SEGUIR = 15;
const NAV_ZOOM = 17;             // si a velocidad de carretera se ve muy cerca, probar 16
const NAV_PITCH = 55;
const NAV_ANIM_MS = 700;         // inclinar/acercar antes de encender el seguimiento
const INSET_CERO = { top: 0, right: 0, bottom: 0, left: 0 };
const VOLQUETA = 44;             // diámetro del badge de posición

/** Badge de posición: volqueta blanca sobre círculo azul; `adelante` = triangulito arriba. */
function Volqueta({ adelante = false }) {
  return (
    <View style={styles.volqueta} pointerEvents="none">
      {adelante ? <View style={styles.volquetaAdelante} /> : null}
      {adelante ? <View style={styles.volquetaAdelanteRelleno} /> : null}
      <View style={styles.volquetaBadge}>
        <MaterialCommunityIcons name="dump-truck" size={24} color="#fff" />
      </View>
    </View>
  );
}

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

const RUTA_VACIA = { origen: null, destino: null, planeada: [], peajes: [] };

async function rutaDelViaje(viaje) {
  const db = await getDb();
  // Ruta planeada y peajes (v10): vacíos si la ruta no tiene geometría → mapa como antes
  const { ruta: r, linea, peajes } = await datosRutaPlaneada(db, viaje);
  const ok = (a, b) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && !(Number(a) === 0 && Number(b) === 0);
  return {
    origen: r && ok(r.origen_lat, r.origen_lon) ? [Number(r.origen_lon), Number(r.origen_lat)] : null,
    destino: r && ok(r.destino_lat, r.destino_lon) ? [Number(r.destino_lon), Number(r.destino_lat)] : null,
    planeada: linea,
    peajes,
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
  const enCurso = viaje.estado_local === 'EN_CURSO';
  const temaSistema = useColorScheme();
  const [tema, setTema] = useState(temaSistema === 'dark' ? 'oscuro' : 'claro');
  const [listo, setListo] = useState(false);
  const [version, setVersion] = useState(0);     // cambia cuando llegan puntos nuevos
  const [sinSenal, setSinSenal] = useState(false);
  const [falloFondo, setFalloFondo] = useState(false);
  const [appActiva, setAppActiva] = useState(AppState.currentState === 'active');
  // navegacion: sigue al vehículo · libre: el conductor movió el mapa · general: toda la ruta
  const [modo, setModo] = useState(enCurso ? 'navegacion' : 'general');
  const [permiso, setPermiso] = useState(null);          // ubicación en primer plano
  const [estiloListo, setEstiloListo] = useState(false);
  const [trackListo, setTrackListo] = useState(false);   // ya se inclinó/acercó la cámara
  const [pedidoGeneral, setPedidoGeneral] = useState(0); // "Ver ruta completa" pendiente
  const [alto, setAlto] = useState(0);
  const [altoLeyenda, setAltoLeyenda] = useState(0);

  const linea = useRef([]);          // [[lon, lat], ...] acumulado
  const ultimoSeq = useRef(0);
  const ultimoTsPunto = useRef(0);
  const ruta = useRef(RUTA_VACIA);
  const posicion = useRef(null);
  const vista = useRef(null);
  const camara = useRef(null);
  const encuadreNav = useRef(false);   // inclinar/acercar al entrar en navegación
  const generalHecho = useRef(0);
  const viajeRef = useRef(viaje); // la pantalla crea un objeto nuevo cada 10 s: solo importa el uuid
  viajeRef.current = viaje;

  const padding = useMemo(() => ({ top: margenSup + 30, right: 40, bottom: margenInf + 30, left: 40 }), [margenSup, margenInf]);
  // Navegación: el vehículo en el tercio inferior para ver el trayecto por delante
  const insetNav = useMemo(() => {
    const visible = Math.max(0, alto - margenSup - margenInf);
    return { top: Math.round(margenSup + visible * 0.4), right: 0, bottom: margenInf + 30, left: 0 };
  }, [alto, margenSup, margenInf]);

  const navegable = enCurso && permiso !== false;
  // El seguimiento nativo espera a que el estilo cargue: si la cámara se monta ya siguiendo,
  // MapLibre deja encendida una ubicación propia que no apaga al dejar de seguir
  const navActiva = navegable && permiso === true && modo === 'navegacion' && estiloListo && activo && appActiva;
  const seguir = navActiva && trackListo;
  const seguirRef = useRef(false);
  seguirRef.current = seguir;

  const mover = useCallback((fn) => {
    try { fn(camara.current)?.catch?.(() => {}); } catch { /* cámara aún no lista */ }
  }, []);

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

  // Primera carga: ruta + puntos. En curso se abre en navegación sobre la posición; si no,
  // encuadra todo (recorrido, ruta planeada, origen, destino y posición)
  useEffect(() => {
    let vivo = true;
    (async () => {
      ruta.current = await rutaDelViaje(viajeRef.current).catch(() => RUTA_VACIA);
      await cargar();
      if (!vivo) return;
      const todo = [...linea.current, ...ruta.current.planeada, ruta.current.origen, ruta.current.destino, posicion.current].filter(Boolean);
      const nav = viajeRef.current.estado_local === 'EN_CURSO';
      vista.current = nav && posicion.current
        ? { center: posicion.current, zoom: NAV_ZOOM, pitch: NAV_PITCH }
        : vistaInicial(todo, padding);
      encuadreNav.current = nav && !posicion.current;
      setListo(true);
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viaje.uuid]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActiva(s === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    Location.getForegroundPermissionsAsync()
      .then((p) => setPermiso(p.status === 'granted'))
      .catch(() => setPermiso(false));
  }, []);

  // Respaldo por si el evento de estilo cargado no llega
  useEffect(() => {
    if (!listo) return undefined;
    const t = setTimeout(() => setEstiloListo(true), 2000);
    return () => clearTimeout(t);
  }, [listo]);

  // Refresco cada 10 s, solo con la app al frente y la pantalla visible (dibuja la línea)
  useEffect(() => {
    if (!listo || !activo || !appActiva) return undefined;
    cargar();
    const t = setInterval(cargar, REFRESCO_MS);
    return () => clearInterval(t);
  }, [listo, activo, appActiva, cargar]);

  // Entrar en navegación: primero inclina y acerca, después enciende el seguimiento (si se
  // encendiera a la vez, cada paso de la flecha cortaría la animación a medias)
  useEffect(() => {
    if (!navActiva) { setTrackListo(false); return undefined; }
    if (!encuadreNav.current) { setTrackListo(true); return undefined; }
    encuadreNav.current = false;
    setTrackListo(false);
    const op = { zoom: NAV_ZOOM, pitch: NAV_PITCH, duration: NAV_ANIM_MS };
    const c = posicion.current;
    mover((cam) => (c ? cam.easeTo({ ...op, center: c }) : cam.setStop({ ...op, easing: 'ease' })));
    const t = setTimeout(() => setTrackListo(true), NAV_ANIM_MS + 100);
    return () => clearTimeout(t);
  }, [navActiva, mover]);

  // Sin permiso de ubicación o viaje que ya no está en curso: vista general
  useEffect(() => {
    if (listo && !navegable && modo !== 'general') {
      setModo('general');
      setPedidoGeneral((x) => x + 1);
    }
  }, [listo, navegable, modo]);

  // Ver ruta completa: plana y al norte, con el padding de siempre
  useEffect(() => {
    if (!estiloListo || pedidoGeneral === generalHecho.current) return;
    generalHecho.current = pedidoGeneral;
    const todo = [...linea.current, ...ruta.current.planeada, ruta.current.origen, ruta.current.destino, posicion.current].filter(Boolean);
    const v = vistaInicial(todo, padding);
    const op = { padding, pitch: 0, bearing: 0, duration: 1000, easing: 'ease' };
    mover((cam) => (v.bounds ? cam.fitBounds(v.bounds, op) : cam.easeTo({ ...op, center: v.center, zoom: v.zoom })));
  }, [pedidoGeneral, estiloListo, padding, mover]);

  // El conductor movió el mapa con el dedo: MapLibre suelta el seguimiento → modo libre
  const alCambiarSeguimiento = useCallback((e) => {
    if (seguirRef.current && e?.nativeEvent?.trackUserLocation !== 'course') setModo('libre');
  }, []);

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

  // La posición no va aquí: es la volqueta (fija en navegación o Marker)
  const datosPuntos = useMemo(() => {
    const f = [];
    const add = (c, tipo) => { if (c) f.push({ type: 'Feature', properties: { tipo }, geometry: { type: 'Point', coordinates: c } }); };
    add(ruta.current.origen, 'origen');
    add(ruta.current.destino, 'destino');
    return { type: 'FeatureCollection', features: f };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo]);

  // Ruta planeada: no cambia durante el viaje (se lee una vez)
  const datosPlaneada = useMemo(() => ({
    type: 'FeatureCollection',
    features: ruta.current.planeada.length >= 2
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ruta.current.planeada } }]
      : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [listo]);

  // Peajes como vistas de React: el estilo del mapa no trae fuentes (glyphs) y sin señal no se
  // podrían bajar, así que una capa de texto de MapLibre no mostraría los nombres.
  const marcasPeajes = useMemo(() => ruta.current.peajes.map((p) => (
    <Marker key={`peaje-${p.id}`} id={`peaje-${p.id}`} lngLat={[p.lon, p.lat]} anchor="bottom">
      <View style={styles.peaje} pointerEvents="none">
        <View style={styles.peajeRotulo}>
          <Text style={styles.peajeNombre} numberOfLines={1}>{p.nombre}</Text>
          {p.valor != null ? <Text style={styles.peajeValor}>{formatoPesos(p.valor)}</Text> : null}
        </View>
        <View style={styles.peajeIcono}><FontAwesome5 name="coins" size={12} color="#fff" /></View>
      </View>
    </Marker>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  )), [listo]);

  const estilo = useMemo(() => estiloFondo(tema), [tema]);
  const hayPlaneada = ruta.current.planeada.length >= 2;

  if (!listo) {
    return <View style={[StyleSheet.absoluteFill, styles.centro]}><ActivityIndicator color="#f59e0b" size="large" /></View>;
  }

  const volquetaFija = navActiva && !!posicion.current;
  const yFija = insetNav.top + (alto - insetNav.top - insetNav.bottom) / 2;

  const navegar = () => {
    encuadreNav.current = true;
    setModo('navegacion');
  };
  const verRutaCompleta = () => {
    setModo('general');
    setPedidoGeneral((x) => x + 1);
  };

  return (
    <View style={StyleSheet.absoluteFill} onLayout={(e) => setAlto(Math.round(e.nativeEvent.layout.height))}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={estilo}
        logo={false}
        compass={false}
        attribution
        attributionPosition={{ bottom: margenInf + 6, right: 8 }}
        contentInset={navegable && modo !== 'general' ? insetNav : INSET_CERO}
        onDidFinishLoadingStyle={() => setEstiloListo(true)}
        onDidFailLoadingMap={() => setFalloFondo(true)}
        onDidFinishLoadingMap={() => setFalloFondo(false)}
      >
        <Camera
          ref={camara}
          initialViewState={vista.current}
          trackUserLocation={seguir ? 'course' : undefined}
          onTrackUserLocationChange={alCambiarSeguimiento}
        />
        {/* Ruta planeada: punteada violeta, DEBAJO del recorrido real (va antes en el orden) */}
        <GeoJSONSource id="planeada" data={datosPlaneada}>
          <Layer id="planeada-linea" type="line" layout={{ 'line-cap': 'butt', 'line-join': 'round' }}
            paint={{ 'line-color': '#7c3aed', 'line-width': 4, 'line-opacity': 0.85, 'line-dasharray': [2, 1.5] }} />
        </GeoJSONSource>
        <GeoJSONSource id="recorrido" data={datosLinea}>
          <Layer id="recorrido-borde" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.8 }} />
          <Layer id="recorrido-linea" type="line" layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#1d4ed8', 'line-width': 5 }} />
        </GeoJSONSource>
        <GeoJSONSource id="marcas" data={datosPuntos}>
          <Layer id="marcas-circulo" type="circle" paint={{
            'circle-radius': 10,
            'circle-color': ['match', ['get', 'tipo'], 'origen', '#16a34a', '#dc2626'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 3,
          }} />
        </GeoJSONSource>
        {marcasPeajes}
        {!volquetaFija && posicion.current ? (
          <Marker id="actual" lngLat={posicion.current} anchor="center"><Volqueta /></Marker>
        ) : null}
      </Map>

      {/* Navegación: el seguimiento pone al usuario en el centro del área que deja contentInset
          (con o sin inclinación) y gira el mapa con la marcha → la volqueta va fija ahí, mirando arriba */}
      {volquetaFija ? (
        <View style={[styles.volquetaFija, { top: yFija - VOLQUETA / 2 }]} pointerEvents="none">
          <Volqueta adelante />
        </View>
      ) : null}

      {/* Avisos, centrados bajo la franja superior */}
      <View style={[styles.avisos, { top: margenSup + 8 }]} pointerEvents="none">
        {sinSenal || falloFondo ? <Text style={styles.aviso}>Mapa sin fondo (sin señal)</Text> : null}
        {linea.current.length < 2 ? <Text style={styles.aviso}>Aún no hay recorrido para dibujar</Text> : null}
      </View>

      {/* Controles a la derecha: fondo claro/oscuro y Ver ruta completa / Navegar (grandes, para guantes) */}
      <View style={[styles.controles, { top: margenSup + 8 }]}>
        <TouchableOpacity style={styles.btnControl} onPress={() => setTema((t) => (t === 'oscuro' ? 'claro' : 'oscuro'))}
          accessibilityLabel={tema === 'oscuro' ? 'Fondo claro' : 'Fondo oscuro'}>
          <FontAwesome5 name={tema === 'oscuro' ? 'sun' : 'moon'} size={20} color="#0f172a" />
        </TouchableOpacity>
        {navegable && modo === 'general' ? (
          <TouchableOpacity style={[styles.btnControl, styles.btnControlActivo]} onPress={navegar} accessibilityLabel="Navegar">
            <FontAwesome5 name="location-arrow" size={20} color="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.btnControl} onPress={verRutaCompleta} accessibilityLabel="Ver ruta completa">
            <FontAwesome5 name="route" size={20} color="#1d4ed8" />
          </TouchableOpacity>
        )}
      </View>

      {/* Recentrar (estilo Waze): solo después de mover el mapa con el dedo */}
      {navegable && modo === 'libre' ? (
        <TouchableOpacity style={[styles.btnRecentrar, { bottom: margenInf + 18 + altoLeyenda }]} onPress={navegar}
          accessibilityLabel="Recentrar">
          <FontAwesome5 name="location-arrow" size={18} color="#fff" style={{ marginRight: 10 }} />
          <Text style={styles.btnRecentrarTexto}>Recentrar</Text>
        </TouchableOpacity>
      ) : null}

      <View style={[styles.leyenda, { bottom: margenInf + 8 }]} pointerEvents="none"
        onLayout={(e) => setAltoLeyenda(Math.round(e.nativeEvent.layout.height))}>
        <Text style={styles.leyendaTexto}><Text style={{ color: '#16a34a' }}>●</Text> Origen  <Text style={{ color: '#dc2626' }}>●</Text> Destino  <MaterialCommunityIcons name="dump-truck" size={12} color="#1d4ed8" /> Actual</Text>
        {hayPlaneada ? (
          <Text style={styles.leyendaTexto}><Text style={{ color: '#7c3aed', fontWeight: '900' }}>- - -</Text> Ruta planeada{ruta.current.peajes.length ? '  ' : ''}{ruta.current.peajes.length ? <Text style={{ color: '#b45309' }}>● Peaje</Text> : null}</Text>
        ) : null}
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
  btnRecentrar: { position: 'absolute', left: 8, height: 54, paddingHorizontal: 22, borderRadius: 27, backgroundColor: '#1d4ed8', flexDirection: 'row', alignItems: 'center', elevation: 6 },
  btnRecentrarTexto: { color: '#fff', fontSize: 17, fontWeight: '900' },
  volquetaFija: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  volqueta: { width: VOLQUETA, height: VOLQUETA },
  volquetaBadge: { width: VOLQUETA, height: VOLQUETA, borderRadius: VOLQUETA / 2, backgroundColor: '#1d4ed8', borderWidth: 3, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
  // Triángulo "hacia adelante": borde blanco con relleno azul, pegado arriba del badge
  volquetaAdelante: { position: 'absolute', top: -13, left: VOLQUETA / 2 - 10, width: 0, height: 0, borderLeftWidth: 10, borderRightWidth: 10, borderBottomWidth: 14, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#fff' },
  volquetaAdelanteRelleno: { position: 'absolute', top: -8, left: VOLQUETA / 2 - 6, width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 9, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: '#1d4ed8' },
  leyenda: { position: 'absolute', left: 8, backgroundColor: 'rgba(255,255,255,0.92)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  leyendaTexto: { color: '#0f172a', fontSize: 11, fontWeight: '700' },
  peaje: { alignItems: 'center' },
  peajeRotulo: { backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 8, borderWidth: 1, borderColor: '#f59e0b', paddingHorizontal: 6, paddingVertical: 2, maxWidth: 150, alignItems: 'center', marginBottom: 2 },
  peajeNombre: { color: '#0f172a', fontSize: 10, fontWeight: '800' },
  peajeValor: { color: '#b45309', fontSize: 11, fontWeight: '900' },
  peajeIcono: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#d97706', borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
});
