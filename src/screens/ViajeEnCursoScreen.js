import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ScrollView, Alert, ActivityIndicator, AppState, Linking,
  Animated, PanResponder, useWindowDimensions, BackHandler,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import NetInfo from '@react-native-community/netinfo';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';

import { enviarPendientes, contarPendientes } from '../database/syncUp';
import { obtenerViaje, viajeEnCurso, guardarFoto, borrarArchivo, finalizarViajeLocal, tieneProblema, reintentarViaje, descartarViaje } from '../viajes';
import { estadoGPS, iniciarGPS, detenerGPS } from '../gps/control';
import { estadisticasRecorrido, PRECISION_MAXIMA_M } from '../gps/puntos';
import { getDb } from '../database/db';
import { datosRutaPlaneada, formatoPesos, categoriaCorta } from '../rutaPlaneada';

// Mapa (MapLibre) a pantalla completa. Se carga con import() dentro de un límite de error:
// si el build no trae el módulo nativo o el mapa falla, la pantalla pasa a la vista sin
// mapa (la de antes). Nunca cierra la app ni bloquea "Finalizar viaje".
const MapaRecorrido = React.lazy(() => import('../components/MapaRecorrido'));

class LimiteMapa extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) {
    console.warn('Mapa:', error?.message || error);
    this.props.alFallar?.();
  }
  render() { return this.state.error ? null : this.props.children; }
}

// Panel inferior: asa + fila de botones grandes (guantes y sol)
const ALTO_ASA = 40;
const ALTO_BOTONES = 96;
const ALTO_PEAJES = 30; // fila "Peajes en esta ruta" (solo si la ruta tiene línea planeada)

// Con el GPS corriendo y buena señal, si no llega ningún punto nuevo en este tiempo es
// porque el vehículo no se mueve (el GPS solo entrega puntos cada 30 m)
const MINUTOS_SIN_MOVIMIENTO = 3;
// Si el último punto ya venía casi quieto (< 5 km/h), basta con 1 minuto sin puntos
const MINUTOS_SIN_MOVIMIENTO_LENTO = 1;
const VELOCIDAD_QUIETO_MS = 1.4;

function hora(iso) { return iso ? String(iso).slice(11, 19) : '—'; }

// Diagnóstico del envío (diag_envio): último intento de cada etapa
const ETAPAS_DIAG = [
  ['inicio', 'Inicio'], ['foto_inicio', 'Foto de carga'], ['puntos', 'Puntos GPS'],
  ['foto_fin', 'Foto de descarga'], ['fin', 'Cierre'],
];
function leerDiag(texto) { try { return JSON.parse(texto || '{}') || {}; } catch { return {}; } }
function colorCodigo(c) {
  const n = Number(c);
  if (n >= 200 && n < 300) return '#10b981';
  if (n >= 500 || c === 'SIN RESPUESTA') return '#f59e0b';
  return '#ef4444';
}

// Cómo se muestra cada estado de una etapa del envío
const ETAPA = {
  synced: { texto: 'Enviado', color: '#10b981', icono: 'check-circle' },
  pending: { texto: 'Pendiente', color: '#f59e0b', icono: 'clock' },
  error: { texto: 'Con error', color: '#ef4444', icono: 'exclamation-circle' },
};

function FilaEtapa({ titulo, estado, nota }) {
  const e = ETAPA[estado] || ETAPA.pending;
  return (
    <View style={styles.filaEtapa}>
      <FontAwesome5 name={e.icono} size={16} color={e.color} style={{ width: 24 }} />
      <Text style={styles.filaEtapaTitulo}>{titulo}</Text>
      <Text style={[styles.filaEtapaEstado, { color: e.color }]}>{nota || e.texto}</Text>
    </View>
  );
}

async function ubicacionConocida() {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const u = await Location.getLastKnownPositionAsync();
    return u ? { lat: u.coords.latitude, lon: u.coords.longitude } : null;
  } catch {
    return null;
  }
}

export default function ViajeEnCursoScreen({ route, navigation }) {
  const [viaje, setViaje] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [enviando, setEnviando] = useState(false);
  const [finalizando, setFinalizando] = useState(false);
  const [gps, setGps] = useState(null);
  const [recorrido, setRecorrido] = useState(null);
  const [problema, setProblema] = useState(false);

  // ── Presentación (no cambia la lógica del viaje, del GPS ni de la cola)
  const [mapaFalla, setMapaFalla] = useState(false);
  const [porEnviar, setPorEnviar] = useState(0);
  const [sinRed, setSinRed] = useState(false);
  const [altoFranja, setAltoFranja] = useState(110);
  const [panelAbierto, setPanelAbierto] = useState(false);
  const [rutaPlan, setRutaPlan] = useState(null); // { peajes, categoria, resumen } · resumen null = sin línea
  const enfocada = useIsFocused(); // el mapa no refresca con otra pantalla encima
  const insets = useSafeAreaInsets();
  const { height: altoVentana } = useWindowDimensions();
  const conPeajes = !!rutaPlan?.resumen;
  const panelMin = ALTO_ASA + (conPeajes ? ALTO_PEAJES : 0) + ALTO_BOTONES + insets.bottom;
  const altoPanel = Math.max(panelMin + 120, Math.round(altoVentana * 0.88));
  const cerrado = altoPanel - panelMin; // desplazamiento con el panel abajo
  const desplazamiento = useRef(new Animated.Value(cerrado)).current;
  const posPanel = useRef(cerrado);

  const moverPanel = useCallback((abrir) => {
    const destino = abrir ? 0 : cerrado;
    posPanel.current = destino;
    setPanelAbierto(abrir);
    Animated.spring(desplazamiento, { toValue: destino, useNativeDriver: true, bounciness: 0, speed: 16 }).start();
  }, [cerrado, desplazamiento]);

  // Si cambia el alto de la pantalla (rotación, barra de navegación), el panel se reubica
  useEffect(() => {
    const destino = posPanel.current === 0 ? 0 : cerrado;
    posPanel.current = destino;
    desplazamiento.setValue(destino);
  }, [cerrado, desplazamiento]);

  // Arrastre del asa: sigue el dedo y al soltar queda arriba o abajo; un toque alterna
  const arrastre = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
    onPanResponderMove: (_, g) => {
      desplazamiento.setValue(Math.min(cerrado, Math.max(0, posPanel.current + g.dy)));
    },
    onPanResponderRelease: (_, g) => {
      if (Math.abs(g.dy) < 6 && Math.abs(g.dx) < 6) { moverPanel(posPanel.current !== 0); return; }
      const actual = Math.min(cerrado, Math.max(0, posPanel.current + g.dy));
      moverPanel(g.vy < -0.3 || (g.vy <= 0.3 && actual < cerrado / 2));
    },
    onPanResponderTerminate: () => moverPanel(posPanel.current === 0),
  }), [cerrado, desplazamiento, moverPanel]);

  // Botón Atrás de Android con el panel arriba: lo baja en vez de salir
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!panelAbierto || mapaFalla) return false;
      moverPanel(false);
      return true;
    });
    return () => sub.remove();
  }, [panelAbierto, mapaFalla, moverPanel]);

  useEffect(() => {
    const quitar = NetInfo.addEventListener((e) => setSinRed(!e.isConnected || e.isInternetReachable === false));
    return () => quitar();
  }, []);

  const recargar = useCallback(async () => {
    const v = route.params?.uuid ? await obtenerViaje(route.params.uuid) : await viajeEnCurso();
    setViaje(v);
    if (v) {
      setRecorrido(await estadisticasRecorrido(v.uuid));
      setGps(await estadoGPS());
      setProblema(await tieneProblema(v.uuid));
      try { setPorEnviar((await contarPendientes()).pendientes); } catch { /* solo informativo */ }
    }
    setCargando(false);
  }, [route.params?.uuid]);

  // Ruta planeada y peajes (v10): se leen una vez por viaje, de SQLite (sin señal)
  const uuidViaje = viaje?.uuid;
  useEffect(() => {
    if (!uuidViaje || !viaje) return undefined;
    let vivo = true;
    (async () => {
      try {
        const info = await datosRutaPlaneada(await getDb(), viaje);
        if (vivo) setRutaPlan(info);
      } catch { /* sin ruta planeada: el panel queda como antes */ }
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuidViaje]);

  const enviarAhora = useCallback(async () => {
    setEnviando(true);
    try { await enviarPendientes({ forzarFotos: true }); } finally { await recargar(); setEnviando(false); }
  }, [recargar]);

  useEffect(() => {
    recargar();
    enviarAhora();
    const t = setInterval(recargar, 10000); // refleja lo que la cola y el GPS van guardando
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') recargar(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [recargar, enviarAhora]);

  const finalizar = async () => {
    Alert.alert('Finalizar viaje', 'Toma la foto de la descarga para cerrar el viaje.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Tomar foto',
        onPress: async () => {
          let fotoFin = null;
          try {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== 'granted') { Alert.alert('Cámara', 'Se necesita permiso de cámara para la foto de descarga.'); return; }
            const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.5 });
            if (r.canceled || !r.assets?.length) return;
            setFinalizando(true);
            fotoFin = await guardarFoto(r.assets[0].uri, viaje.uuid, 'fin', r.assets[0].width);
            const pos = await ubicacionConocida();
            await finalizarViajeLocal(viaje.uuid, { fotoFinPath: fotoFin, lat: pos?.lat, lon: pos?.lon });
            // Primero se guarda el cierre y después se apaga el GPS: si guardar falla, el viaje
            // sigue EN_CURSO con el GPS encendido (antes quedaba en curso y sin GPS).
            // Los puntos que falten se suben antes del cierre.
            await detenerGPS();
            enviarPendientes().catch(() => {});
            Alert.alert('✅ Viaje finalizado', 'Quedó guardado en el celular y se enviará automáticamente cuando haya señal.', [
              { text: 'OK', onPress: () => navigation.navigate('Home') },
            ]);
          } catch (e) {
            if (fotoFin) borrarArchivo(fotoFin);
            Alert.alert('Error', 'No se pudo finalizar el viaje en el celular.');
          } finally {
            setFinalizando(false);
          }
        },
      },
    ]);
  };

  const reintentar = async () => {
    setEnviando(true);
    try {
      await reintentarViaje(viaje.uuid);
      await enviarPendientes({ forzarFotos: true });
    } finally { await recargar(); setEnviando(false); }
  };

  const descartar = () => {
    const enServidor = viaje.sync_inicio === 'synced';
    const numero = viaje.id_viaje_servidor ? ` (#${viaje.id_viaje_servidor})` : '';
    Alert.alert(
      'Descartar envío',
      (enServidor
        ? `El viaje ya está en el sistema${numero}. Descartar solo deja de enviar lo que falta (fotos, puntos o cierre). Si hay que anularlo, lo hace el administrador en la web.`
        : 'El viaje NO llegó al sistema y ya no se enviará. Se borran del celular sus fotos y su recorrido.')
        + '\n\nEsto no se puede deshacer.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Descartar', style: 'destructive',
          onPress: async () => {
            if (viaje.estado_local === 'EN_CURSO') await detenerGPS();
            await descartarViaje(viaje.uuid);
            navigation.navigate('Home');
          },
        },
      ]
    );
  };

  if (cargando) {
    return <View style={styles.centro}><ActivityIndicator size="large" color="#f59e0b" /></View>;
  }

  if (!viaje) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centro}>
          <Text style={styles.vacio}>No hay un viaje en curso en este celular.</Text>
          <TouchableOpacity style={styles.btnSecundario} onPress={() => navigation.navigate('Home')}>
            <Text style={styles.btnSecundarioTexto}>Volver</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const enCurso = viaje.estado_local === 'EN_CURSO';
  const descartado = viaje.sync_status === 'descartado';
  const inicioConError = viaje.sync_inicio === 'error';

  // Estado del GPS para el conductor
  const minutosSinPunto = recorrido?.ultimoTs ? (Date.now() - Date.parse(recorrido.ultimoTs)) / 60000 : null;
  const ultimoLento = recorrido?.ultimaVelocidad != null && recorrido.ultimaVelocidad < VELOCIDAD_QUIETO_MS;
  let estadoGps = enCurso
    ? { texto: 'Consultando…', color: '#64748b', icono: 'satellite-dish' }
    : { texto: 'Recorrido terminado', color: '#64748b', icono: 'flag-checkered' };
  if (enCurso && gps) {
    if (!gps.permisoPrimerPlano) estadoGps = { texto: 'Sin permiso de ubicación', color: '#ef4444', icono: 'ban' };
    else if (!gps.ubicacionActivada) estadoGps = { texto: 'Ubicación del celular apagada', color: '#ef4444', icono: 'map-marker-alt' };
    else if (!gps.corriendo) estadoGps = { texto: 'GPS detenido', color: '#ef4444', icono: 'exclamation-circle' };
    // "Esperando señal": nunca ha llegado un punto, o la última lectura tuvo mala precisión
    else if (minutosSinPunto === null || (viaje.gps_ultima_precision != null && viaje.gps_ultima_precision > PRECISION_MAXIMA_M)) {
      estadoGps = { texto: 'Esperando señal GPS', color: '#f59e0b', icono: 'satellite-dish' };
    } else if (minutosSinPunto > MINUTOS_SIN_MOVIMIENTO || (ultimoLento && minutosSinPunto > MINUTOS_SIN_MOVIMIENTO_LENTO)) {
      // GPS funcionando con buena señal, pero sin puntos nuevos: la volqueta está quieta
      estadoGps = { texto: 'Detenido / sin movimiento', color: '#64748b', icono: 'pause-circle' };
    } else estadoGps = { texto: 'Activo · en movimiento', color: '#10b981', icono: 'satellite-dish' };
  }
  const reintentarGps = async () => { await iniciarGPS(viaje.placa); recargar(); };

  // Estado de envío para la franja: en línea / sin señal y cuánto falta por enviar
  let envio = sinRed ? { texto: 'Sin señal', color: '#f59e0b' } : { texto: 'En línea', color: '#10b981' };
  if (porEnviar > 0) envio = { texto: `${envio.texto} · ${porEnviar} por enviar`, color: '#f59e0b' };
  else if (recorrido?.pendientes > 0) envio = { texto: `${envio.texto} · ${recorrido.pendientes} puntos por enviar`, color: '#f59e0b' };
  const titulo = descartado ? 'Envío descartado' : enCurso ? 'Viaje en curso' : 'Viaje finalizado';

  // ── Todo el detalle del viaje (el mismo de antes): en el panel deslizable o, sin mapa, en la pantalla
  const detalle = (
    <>
      <View style={[styles.tarjeta, { borderLeftColor: enCurso ? '#f59e0b' : '#10b981' }]}>
        <Text style={styles.placa}>{viaje.placa}</Text>
        <Text style={styles.ruta}>{viaje.origen} ➔ {viaje.destino}</Text>
        {viaje.ruta_nombre ? <Text style={styles.detalle}>Ruta: {viaje.ruta_nombre}</Text> : null}
        <Text style={styles.detalle}>Material: {viaje.material}{viaje.cantidad ? ` • ${viaje.cantidad}` : ''}</Text>
        <Text style={styles.detalle}>Remisión: {viaje.remision}</Text>
        <Text style={styles.detalle}>Inicio: {String(viaje.fecha_inicio_iso || '').replace('T', ' ').slice(0, 16)}</Text>
        {viaje.id_viaje_servidor ? <Text style={styles.detalle}>ID en el sistema: #{viaje.id_viaje_servidor}</Text> : null}
      </View>

      {rutaPlan?.resumen?.cantidad ? (
        <>
          <Text style={styles.subtitulo}>Peajes en esta ruta{rutaPlan.categoria ? ` · ${categoriaCorta(rutaPlan.categoria)}` : ''}</Text>
          <View style={styles.tarjetaEtapas}>
            {rutaPlan.peajes.map((p) => (
              <View key={p.id} style={styles.filaPeaje}>
                <Text style={styles.peajeOrden}>{p.orden}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.peajeNombre}>{p.nombre}</Text>
                  <Text style={styles.detalle}>{p.km != null ? `km ${Number(p.km).toFixed(1)}` : ''}{p.sentido ? `${p.km != null ? ' · ' : ''}${p.sentido}` : ''}</Text>
                </View>
                <Text style={styles.peajeValor}>{p.valor != null ? formatoPesos(p.valor) : 'sin valor'}</Text>
              </View>
            ))}
            <Text style={styles.peajeTotal}>{rutaPlan.resumen.texto}</Text>
          </View>
        </>
      ) : null}

      <Text style={styles.subtitulo}>GPS del recorrido</Text>
      <View style={styles.tarjetaEtapas}>
        <View style={styles.filaEtapa}>
          <FontAwesome5 name={estadoGps.icono} size={16} color={estadoGps.color} style={{ width: 24 }} />
          <Text style={styles.filaEtapaTitulo}>Estado</Text>
          <Text style={[styles.filaEtapaEstado, { color: estadoGps.color }]}>{estadoGps.texto}</Text>
        </View>
        <View style={styles.filaDato}><Text style={styles.datoEtiqueta}>Puntos capturados / enviados</Text><Text style={styles.datoValor}>{recorrido?.capturados ?? 0} / {recorrido?.enviados ?? 0}</Text></View>
        <View style={styles.filaDato}><Text style={styles.datoEtiqueta}>Último punto</Text><Text style={styles.datoValor}>{hora(recorrido?.ultimoTs)}{recorrido?.ultimaPrecision != null ? ` • ±${Math.round(recorrido.ultimaPrecision)} m` : ''}</Text></View>
        <View style={[styles.filaDato, { borderBottomWidth: 0 }]}><Text style={styles.datoEtiqueta}>Distancia aproximada</Text><Text style={styles.datoValor}>{(recorrido?.distanciaKm ?? 0).toFixed(1)} km</Text></View>
      </View>

      {viaje.gps_simulados > 0 ? (
        <View style={[styles.aviso, { backgroundColor: '#fef2f2' }]}>
          <FontAwesome5 name="user-secret" size={14} color="#b91c1c" style={{ marginRight: 8 }} />
          <Text style={[styles.avisoTexto, { color: '#b91c1c' }]}>Se detectaron {viaje.gps_simulados} ubicaciones simuladas (app de GPS falso). Quedan registradas en el viaje.</Text>
        </View>
      ) : null}
      {enCurso && gps && !gps.permisoPrimerPlano ? (
        <View style={[styles.aviso, { backgroundColor: '#fef2f2' }]}>
          <FontAwesome5 name="ban" size={14} color="#b91c1c" style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.avisoTexto, { color: '#b91c1c' }]}>Sin permiso de ubicación el recorrido no se registra. El viaje sigue, pero sin GPS.</Text>
            <TouchableOpacity onPress={() => Linking.openSettings()}><Text style={styles.enlace}>Abrir ajustes → Permisos → Ubicación</Text></TouchableOpacity>
          </View>
        </View>
      ) : null}
      {enCurso && gps && gps.permisoPrimerPlano && !gps.permisoSegundoPlano ? (
        <View style={styles.aviso}>
          <FontAwesome5 name="moon" size={14} color="#92400e" style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.avisoTexto}>Sin "Permitir todo el tiempo": con la pantalla apagada el recorrido puede quedar incompleto.</Text>
            <TouchableOpacity onPress={() => Linking.openSettings()}><Text style={styles.enlace}>Abrir ajustes → Permisos → Ubicación → Permitir todo el tiempo</Text></TouchableOpacity>
          </View>
        </View>
      ) : null}
      {enCurso && gps && gps.corriendo && !gps.notificaciones ? (
        <View style={styles.aviso}>
          <FontAwesome5 name="bell-slash" size={14} color="#92400e" style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.avisoTexto}>Sin permiso de notificaciones no verás el aviso "Viaje en curso" en la barra. El recorrido se registra igual.</Text>
            <TouchableOpacity onPress={() => Linking.openSettings()}><Text style={styles.enlace}>Abrir ajustes → Notificaciones → Permitir</Text></TouchableOpacity>
          </View>
        </View>
      ) : null}
      {enCurso && gps && gps.permisoPrimerPlano && !gps.corriendo ? (
        <TouchableOpacity style={styles.btnSecundario} onPress={reintentarGps}>
          <Text style={styles.btnSecundarioTexto}>Reintentar GPS</Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.subtitulo}>Estado de envío</Text>
      <View style={styles.tarjetaEtapas}>
        <FilaEtapa titulo="Inicio del viaje" estado={viaje.sync_inicio} />
        <FilaEtapa titulo="Foto de carga" estado={viaje.sync_foto_inicio} />
        <FilaEtapa titulo="Recorrido GPS" estado={recorrido?.pendientes ? 'pending' : 'synced'}
          nota={recorrido?.pendientes ? `${recorrido.pendientes} por enviar` : (recorrido?.capturados ? 'Al día' : 'Sin puntos aún')} />
        <FilaEtapa titulo="Foto de descarga" estado={enCurso ? 'pending' : viaje.sync_foto_fin} nota={enCurso ? 'Al finalizar' : null} />
        <FilaEtapa titulo="Cierre del viaje" estado={enCurso ? 'pending' : viaje.sync_fin} nota={enCurso ? 'Al finalizar' : null} />
      </View>

      <Text style={styles.subtitulo}>Diagnóstico de envío (último intento)</Text>
      <View style={styles.tarjetaEtapas}>
        {ETAPAS_DIAG.map(([clave, tituloEtapa]) => {
          const d = leerDiag(viaje.diag_envio)[clave];
          return (
            <View key={clave} style={styles.filaDiag}>
              <View style={styles.filaDiagCabeza}>
                <Text style={styles.filaEtapaTitulo}>{tituloEtapa}</Text>
                <Text style={[styles.diagCodigo, { color: d ? colorCodigo(d.codigo) : '#94a3b8' }]}>{d ? String(d.codigo) : 'sin intentos'}</Text>
                <Text style={styles.diagHora}>{d ? hora(d.hora) : ''}</Text>
              </View>
              {d && d.mensaje ? <Text style={styles.diagMensaje} selectable>{d.mensaje}</Text> : null}
            </View>
          );
        })}
      </View>

      {viaje.requiere_revision ? (
        <View style={styles.aviso}>
          <FontAwesome5 name="exclamation-triangle" size={14} color="#92400e" style={{ marginRight: 8 }} />
          <Text style={styles.avisoTexto}>El sistema lo marcó para revisión del administrador: {viaje.motivo_revision}</Text>
        </View>
      ) : null}
      {viaje.ultimo_error ? (
        <View style={[styles.aviso, { backgroundColor: '#fef2f2' }]}>
          <FontAwesome5 name="info-circle" size={14} color="#b91c1c" style={{ marginRight: 8 }} />
          <Text style={[styles.avisoTexto, { color: '#b91c1c' }]}>
            {inicioConError ? 'El servidor rechazó el viaje: ' : 'Último error: '}{viaje.ultimo_error}
          </Text>
        </View>
      ) : null}

      {problema && !descartado ? (
        <View style={styles.tarjetaProblema}>
          <Text style={styles.problemaTitulo}><FontAwesome5 name="exclamation-triangle" size={14} color="#b91c1c" />  Problema de envío</Text>
          <Text style={styles.problemaTexto}>Parte de este viaje no se pudo enviar (ver el diagnóstico). Si el problema ya se corrigió, reintenta. Si el viaje no debe quedar en el sistema, descártalo.</Text>
          <TouchableOpacity style={styles.btnReintentar} onPress={reintentar} disabled={enviando}>
            {enviando ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnReintentarTexto}>Reintentar envío</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnDescartar} onPress={descartar} disabled={enviando}>
            <Text style={styles.btnDescartarTexto}>Descartar</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {descartado ? (
        <View style={styles.aviso}>
          <FontAwesome5 name="ban" size={14} color="#92400e" style={{ marginRight: 8 }} />
          <Text style={styles.avisoTexto}>Envío descartado en este celular: ya no se envía nada más de este viaje.</Text>
        </View>
      ) : (
        <TouchableOpacity style={styles.btnSecundario} onPress={enviarAhora} disabled={enviando}>
          {enviando ? <ActivityIndicator color="#0f172a" /> : <Text style={styles.btnSecundarioTexto}>Enviar ahora</Text>}
        </TouchableOpacity>
      )}

      {enCurso ? (
        <View style={styles.tarjetaBateria}>
          <Text style={styles.bateriaTitulo}><FontAwesome5 name="battery-half" size={14} color="#1e40af" />  ¿El recorrido se corta con la pantalla apagada?</Text>
          <Text style={styles.bateriaTexto}>Algunos celulares cierran las apps para ahorrar batería. Deja OptiCore sin restricción:</Text>
          <Text style={styles.bateriaTexto}>• <Text style={styles.negrita}>Samsung:</Text> Batería → Sin restricciones.</Text>
          <Text style={styles.bateriaTexto}>• <Text style={styles.negrita}>Xiaomi / Redmi:</Text> Ahorro de batería → Sin restricciones, y activa Inicio automático.</Text>
          <Text style={styles.bateriaTexto}>• <Text style={styles.negrita}>Huawei:</Text> Batería → Inicio de aplicaciones → gestionar manualmente y activar todo.</Text>
          <TouchableOpacity style={styles.btnBateria} onPress={() => Linking.openSettings()}>
            <Text style={styles.btnBateriaTexto}>Abrir ajustes de la app</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </>
  );

  const irPreoperacional = () => navigation.navigate('Preoperacional', { placa: viaje.placa });

  // ── Respaldo SIN mapa: la pantalla de antes (el módulo del mapa no existe o falló)
  if (mapaFalla) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.mobileHeader}>
          <TouchableOpacity onPress={() => navigation.navigate('Home')} style={styles.backBtn}>
            <FontAwesome5 name="arrow-left" size={20} color="#ffffff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{titulo}</Text>
          <View style={{ width: 20 }} />
        </View>
        <ScrollView contentContainerStyle={styles.contenido}>
          {detalle}
          <TouchableOpacity style={[styles.btnSecundario, { marginTop: 4 }]} onPress={irPreoperacional}>
            <Text style={styles.btnSecundarioTexto}>Preoperacional / Novedad</Text>
          </TouchableOpacity>
          {enCurso ? (
            <TouchableOpacity style={[styles.btnFinalizar, finalizando && { backgroundColor: '#94a3b8' }]} onPress={finalizar} disabled={finalizando}>
              {finalizando ? <ActivityIndicator color="#fff" /> : (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <FontAwesome5 name="flag-checkered" size={18} color="#fff" style={{ marginRight: 10 }} />
                  <Text style={styles.btnFinalizarTexto}>Finalizar viaje</Text>
                </View>
              )}
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Mapa a pantalla completa + franja superior + panel inferior deslizable
  return (
    <View style={styles.pantallaMapa}>
      <LimiteMapa alFallar={() => setMapaFalla(true)}>
        <Suspense fallback={<View style={[StyleSheet.absoluteFill, styles.mapaCargando]}><ActivityIndicator color="#f59e0b" size="large" /></View>}>
          <MapaRecorrido viaje={viaje} activo={enfocada} margenSup={altoFranja} margenInf={panelMin} />
        </Suspense>
      </LimiteMapa>

      {/* Franja superior compacta */}
      <View style={[styles.franja, { paddingTop: insets.top + 6 }]} onLayout={(e) => setAltoFranja(Math.round(e.nativeEvent.layout.height))}>
        <View style={styles.franjaFila}>
          <TouchableOpacity onPress={() => navigation.navigate('Home')} style={styles.franjaVolver} accessibilityLabel="Volver">
            <FontAwesome5 name="arrow-left" size={20} color="#ffffff" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.franjaPlaca} numberOfLines={1}>{viaje.placa}<Text style={styles.franjaTitulo}>  {titulo}</Text></Text>
            <Text style={styles.franjaRuta} numberOfLines={1}>{viaje.material} • {viaje.origen} → {viaje.destino}</Text>
          </View>
        </View>
        <View style={styles.franjaChips}>
          <View style={styles.chip}>
            <View style={[styles.chipPunto, { backgroundColor: estadoGps.color }]} />
            <Text style={styles.chipTexto} numberOfLines={1}>{estadoGps.texto}</Text>
          </View>
          <View style={styles.chip}>
            <View style={[styles.chipPunto, { backgroundColor: envio.color }]} />
            <Text style={styles.chipTexto} numberOfLines={1}>{envio.texto}</Text>
          </View>
        </View>
      </View>

      {/* Panel inferior: botones grandes; se desliza hacia arriba para ver el detalle */}
      <Animated.View style={[styles.panel, { height: altoPanel, transform: [{ translateY: desplazamiento }] }]}>
        <View style={styles.asa} {...arrastre.panHandlers}>
          <View style={styles.asaBarra} />
          <Text style={styles.asaTexto}>{panelAbierto ? 'Deslizar hacia abajo para ver el mapa' : 'Deslizar hacia arriba para ver detalles'}</Text>
        </View>
        {conPeajes ? (
          <View style={styles.filaResumenPeajes}>
            <FontAwesome5 name="coins" size={13} color="#b45309" style={{ marginRight: 6 }} />
            <Text style={styles.textoResumenPeajes} numberOfLines={1}>{rutaPlan.resumen.texto}</Text>
          </View>
        ) : null}
        <View style={styles.botonesPanel}>
          <TouchableOpacity style={styles.btnPanelPreop} onPress={irPreoperacional}>
            <FontAwesome5 name="clipboard-check" size={20} color="#1e40af" style={{ marginRight: 8 }} />
            <Text style={styles.btnPanelPreopTexto} numberOfLines={2}>Preoperacional / Novedad</Text>
          </TouchableOpacity>
          {enCurso ? (
            <TouchableOpacity style={[styles.btnPanelFinalizar, finalizando && { backgroundColor: '#94a3b8' }]} onPress={finalizar} disabled={finalizando}>
              {finalizando ? <ActivityIndicator color="#fff" /> : (
                <>
                  <FontAwesome5 name="flag-checkered" size={20} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={styles.btnPanelFinalizarTexto} numberOfLines={2}>Finalizar viaje</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.btnPanelFinalizar, { backgroundColor: '#334155' }]} onPress={() => navigation.navigate('Home')}>
              <FontAwesome5 name="home" size={20} color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.btnPanelFinalizarTexto} numberOfLines={2}>Volver al inicio</Text>
            </TouchableOpacity>
          )}
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.contenidoPanel, { paddingBottom: insets.bottom + 30 }]}>
          {detalle}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0f172a' },
  centro: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a', padding: 20 },
  vacio: { color: '#cbd5e1', fontSize: 16, marginBottom: 20, textAlign: 'center' },
  mobileHeader: { backgroundColor: '#0f172a', paddingVertical: 15, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backBtn: { padding: 5 },
  headerTitle: { color: '#ffffff', fontSize: 18, fontWeight: '700' },
  contenido: { padding: 20, paddingBottom: 50, backgroundColor: '#f8fafc', flexGrow: 1 },
  tarjeta: { backgroundColor: '#fff', borderRadius: 12, padding: 18, borderLeftWidth: 6, marginBottom: 20 },
  placa: { fontSize: 26, fontWeight: '900', color: '#0f172a', letterSpacing: 1 },
  ruta: { fontSize: 17, fontWeight: '800', color: '#1e40af', marginTop: 6, marginBottom: 8 },
  detalle: { fontSize: 14, color: '#475569', marginTop: 3 },
  subtitulo: { fontSize: 13, color: '#475569', fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' },
  tarjetaEtapas: { backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 6, marginBottom: 16 },
  filaEtapa: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderColor: '#f1f5f9' },
  filaEtapaTitulo: { flex: 1, fontSize: 15, color: '#0f172a', fontWeight: '600' },
  filaEtapaEstado: { fontSize: 13, fontWeight: '800' },
  filaDato: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#f1f5f9' },
  datoEtiqueta: { fontSize: 14, color: '#475569' },
  datoValor: { fontSize: 14, color: '#0f172a', fontWeight: '800' },
  filaDiag: { paddingVertical: 10, borderBottomWidth: 1, borderColor: '#f1f5f9' },
  filaDiagCabeza: { flexDirection: 'row', alignItems: 'center' },
  diagCodigo: { fontSize: 13, fontWeight: '900', marginRight: 10 },
  diagHora: { fontSize: 12, color: '#64748b', minWidth: 60, textAlign: 'right' },
  diagMensaje: { fontSize: 12, color: '#475569', marginTop: 4 },
  enlace: { color: '#1d4ed8', fontWeight: '900', fontSize: 13, marginTop: 6, textDecorationLine: 'underline' },
  negrita: { fontWeight: '900' },
  tarjetaBateria: { backgroundColor: '#eff6ff', borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#bfdbfe' },
  bateriaTitulo: { color: '#1e40af', fontWeight: '900', fontSize: 14, marginBottom: 6 },
  bateriaTexto: { color: '#1e3a8a', fontSize: 13, marginBottom: 3 },
  btnBateria: { marginTop: 10, backgroundColor: '#1d4ed8', padding: 12, borderRadius: 8, alignItems: 'center' },
  btnBateriaTexto: { color: '#fff', fontWeight: '900' },
  aviso: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#fffbeb', padding: 12, borderRadius: 8, marginBottom: 12 },
  avisoTexto: { flex: 1, color: '#92400e', fontSize: 13, fontWeight: '600' },
  btnSecundario: { backgroundColor: '#e2e8f0', padding: 15, borderRadius: 8, alignItems: 'center', marginBottom: 12 },
  btnSecundarioTexto: { color: '#0f172a', fontWeight: '900', fontSize: 15 },
  // Mapa a pantalla completa
  pantallaMapa: { flex: 1, backgroundColor: '#1f2937' },
  mapaCargando: { backgroundColor: '#1f2937', justifyContent: 'center', alignItems: 'center' },
  franja: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: 'rgba(15,23,42,0.92)', paddingHorizontal: 12, paddingBottom: 10 },
  franjaFila: { flexDirection: 'row', alignItems: 'center' },
  franjaVolver: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center', marginRight: 6 },
  franjaPlaca: { color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: 1 },
  franjaTitulo: { color: '#fbbf24', fontSize: 13, fontWeight: '800', letterSpacing: 0 },
  franjaRuta: { color: '#cbd5e1', fontSize: 14, fontWeight: '700', marginTop: 2 },
  franjaChips: { flexDirection: 'row', marginTop: 8 },
  chip: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, marginRight: 8 },
  chipPunto: { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
  chipTexto: { flexShrink: 1, color: '#fff', fontSize: 13, fontWeight: '800' },
  panel: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#f8fafc', borderTopLeftRadius: 18, borderTopRightRadius: 18, elevation: 16, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: -3 } },
  asa: { height: ALTO_ASA, alignItems: 'center', justifyContent: 'center' },
  asaBarra: { width: 48, height: 5, borderRadius: 3, backgroundColor: '#94a3b8', marginBottom: 4 },
  asaTexto: { fontSize: 11, color: '#64748b', fontWeight: '700' },
  botonesPanel: { height: ALTO_BOTONES, flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 12, paddingTop: 4 },
  btnPanelPreop: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#dbeafe', borderRadius: 12, marginRight: 10, paddingHorizontal: 10, borderWidth: 2, borderColor: '#93c5fd' },
  btnPanelPreopTexto: { flexShrink: 1, color: '#1e3a8a', fontWeight: '900', fontSize: 16, textAlign: 'center' },
  btnPanelFinalizar: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#dc2626', borderRadius: 12, paddingHorizontal: 10 },
  btnPanelFinalizarTexto: { flexShrink: 1, color: '#fff', fontWeight: '900', fontSize: 18, textAlign: 'center' },
  contenidoPanel: { paddingHorizontal: 16, paddingTop: 8 },
  filaResumenPeajes: { height: ALTO_PEAJES, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  textoResumenPeajes: { fontSize: 14, fontWeight: '800', color: '#92400e' },
  filaPeaje: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  peajeOrden: { width: 24, fontSize: 13, fontWeight: '900', color: '#b45309' },
  peajeNombre: { fontSize: 14, fontWeight: '800', color: '#0f172a' },
  peajeValor: { fontSize: 14, fontWeight: '900', color: '#b45309', marginLeft: 8 },
  peajeTotal: { fontSize: 13, fontWeight: '800', color: '#92400e', marginTop: 8 },
  tarjetaProblema: { backgroundColor: '#fef2f2', borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#fecaca' },
  problemaTitulo: { color: '#b91c1c', fontWeight: '900', fontSize: 14, marginBottom: 6 },
  problemaTexto: { color: '#7f1d1d', fontSize: 13, marginBottom: 10 },
  btnReintentar: { backgroundColor: '#1d4ed8', padding: 13, borderRadius: 8, alignItems: 'center', marginBottom: 8 },
  btnReintentarTexto: { color: '#fff', fontWeight: '900', fontSize: 15 },
  btnDescartar: { borderWidth: 1, borderColor: '#b91c1c', padding: 12, borderRadius: 8, alignItems: 'center' },
  btnDescartarTexto: { color: '#b91c1c', fontWeight: '900', fontSize: 15 },
  btnFinalizar: { backgroundColor: '#ef4444', padding: 18, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  btnFinalizarTexto: { color: '#fff', fontWeight: '900', fontSize: 19 },
});
