import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Modal, FlatList, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { leerToken } from '../sesion';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';

import { API_URL } from '../config';
import { getDb, parseNum } from '../database/db';
import { enviarPendientes } from '../database/syncUp';
import { iniciarGPS, pedirPermisoNotificaciones } from '../gps/control';
import {
  preoperacionalRequerido, ordenarOrigenes, validarCantidad, capacidadEquipo,
  guardarFoto, borrarArchivo, crearViajeLocal, viajeEnCurso, uuidViaje, RADIO_CERCANOS_KM,
  viajesAbiertosAjenos, describirAjenos,
} from '../viajes';

/** Lista desplegable simple (modal) para material, origen y destino. */
function Selector({ etiqueta, valor, placeholder, opciones, onSelect, deshabilitado }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <View style={styles.formGroup}>
      <Text style={styles.formLabel}>{etiqueta} <Text style={{ color: '#ef4444' }}>*</Text></Text>
      <TouchableOpacity
        style={[styles.selector, deshabilitado && { opacity: 0.5 }]}
        onPress={() => !deshabilitado && setAbierto(true)}
        disabled={deshabilitado}
      >
        <Text style={[styles.selectorTexto, !valor && { color: '#94a3b8' }]} numberOfLines={1}>{valor || placeholder}</Text>
        <FontAwesome5 name="chevron-down" size={14} color="#64748b" />
      </TouchableOpacity>
      <Modal visible={abierto} animationType="slide" transparent onRequestClose={() => setAbierto(false)}>
        <View style={styles.modalFondo}>
          <View style={styles.modalCaja}>
            <Text style={styles.modalTitulo}>{etiqueta}</Text>
            <FlatList
              data={opciones}
              keyExtractor={(o, i) => `${o.clave || o.valor}-${i}`}
              renderItem={({ item }) => item.seccion ? (
                <Text style={styles.modalSeccion}>{item.seccion}</Text>
              ) : (
                <TouchableOpacity style={styles.modalOpcion} onPress={() => { onSelect(item.valor); setAbierto(false); }}>
                  <Text style={styles.modalOpcionTexto}>{item.valor}</Text>
                  {item.detalle ? <Text style={styles.modalOpcionDetalle}>{item.detalle}</Text> : null}
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={styles.modalVacio}>No hay opciones. Sincroniza con señal.</Text>}
            />
            <TouchableOpacity style={styles.modalCerrar} onPress={() => setAbierto(false)}>
              <Text style={styles.modalCerrarTexto}>Cerrar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

async function ubicacionConocida() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const ultima = await Location.getLastKnownPositionAsync();
    if (ultima) return { lat: ultima.coords.latitude, lon: ultima.coords.longitude };
    const pos = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise((r) => setTimeout(() => r(null), 5000)),
    ]);
    return pos ? { lat: pos.coords.latitude, lon: pos.coords.longitude } : null;
  } catch {
    return null;
  }
}

export default function ViajeScreen({ route, navigation }) {
  const placa = (route.params?.placa || '').trim().toUpperCase();

  const [cargando, setCargando] = useState(true);
  const [equipo, setEquipo] = useState(null);
  const [materiales, setMateriales] = useState([]);
  const [rutas, setRutas] = useState([]);
  const [posicion, setPosicion] = useState(null);

  const [material, setMaterial] = useState('');
  const [origen, setOrigen] = useState('');
  const [destino, setDestino] = useState('');
  const [remision, setRemision] = useState('');
  const [cantidad, setCantidad] = useState('');
  const [fotoInicio, setFotoInicio] = useState(null);
  const [guardando, setGuardando] = useState(false);

  // uuid del viaje desde que se abre el formulario: la foto se guarda con ese nombre
  const uuid = useRef(uuidViaje()).current;
  const iniciado = useRef(false);
  const fotoRef = useRef(null);
  const ajenosRef = useRef([]); // viajes abiertos en el servidor que este celular no tiene

  useEffect(() => {
    let activo = true;
    (async () => {
      // 1. Un solo viaje en curso por celular
      const abierto = await viajeEnCurso();
      if (abierto) {
        navigation.replace('ViajeEnCurso', { uuid: abierto.uuid });
        return;
      }

      // 2. Preoperacional del día (decisión 1)
      const token = await leerToken();
      const preop = await preoperacionalRequerido(placa, { token, apiUrl: API_URL });
      if (!activo) return;
      // En paralelo, sin esperar: ¿hay viajes abiertos en el servidor que este celular no tiene?
      viajesAbiertosAjenos({ token, apiUrl: API_URL }).then((l) => { ajenosRef.current = l || []; });
      if (preop.requerido) {
        Alert.alert(
          'Preoperacional pendiente',
          `Debes hacer el preoperacional de hoy de ${placa} antes de iniciar el viaje.\n\n${preop.motivo}`,
          [
            { text: 'Volver', style: 'cancel', onPress: () => navigation.goBack() },
            { text: 'Hacer preoperacional', onPress: () => navigation.replace('Preoperacional', { placa }) },
          ],
          { cancelable: false }
        );
        return;
      }

      // 3. Datos locales (sin señal)
      const db = await getDb();
      const [eq, mats, rts] = await Promise.all([
        db.getFirstAsync('SELECT * FROM equipos WHERE placa = ?', placa),
        db.getAllAsync('SELECT * FROM materiales ORDER BY nombre'),
        db.getAllAsync('SELECT * FROM rutas ORDER BY origen, destino'),
      ]);
      if (!activo) return;
      setEquipo(eq);
      setMateriales(mats);
      setRutas(rts);
      setCargando(false);

      // 4. Ubicación conocida para ordenar los orígenes cercanos (no bloquea el formulario)
      const pos = await ubicacionConocida();
      if (activo) setPosicion(pos);
    })();

    // Si el conductor sale sin iniciar, la foto tomada no queda huérfana en el celular
    return () => { activo = false; if (!iniciado.current && fotoRef.current) borrarArchivo(fotoRef.current); };
  }, [placa, navigation]);

  const opcionesMaterial = materiales.map((m) => ({ valor: m.nombre, detalle: m.unidad }));

  const opcionesOrigen = useMemo(() => {
    const { cercanos, otros } = ordenarOrigenes(rutas, posicion);
    const lista = [];
    if (cercanos.length) {
      lista.push({ seccion: `📍 CERCANOS (a menos de ${RADIO_CERCANOS_KM} km)`, clave: 'sec-cerca' });
      cercanos.forEach((o) => lista.push({ valor: o.nombre, detalle: `${o.distanciaKm.toFixed(1)} km` }));
      lista.push({ seccion: 'OTROS ORÍGENES', clave: 'sec-otros' });
    }
    otros.forEach((o) => lista.push({ valor: o.nombre }));
    return lista;
  }, [rutas, posicion]);

  const opcionesDestino = useMemo(
    () => rutas.filter((r) => r.origen === origen).map((r) => ({ valor: r.destino, clave: `d-${r.id}` })),
    [rutas, origen]
  );

  const ruta = rutas.find((r) => r.origen === origen && r.destino === destino) || null;

  const requiereCantidad = !!equipo?.requiere_cantidad;
  const { capacidad, unidad } = capacidadEquipo(equipo);
  const cantidadNum = parseNum(cantidad);
  const chequeo = validarCantidad(cantidadNum, equipo);

  const tomarFoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Cámara', 'Se necesita permiso de cámara para la foto de carga.'); return; }
      const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.5 });
      if (r.canceled || !r.assets?.length) return;
      const uri = await guardarFoto(r.assets[0].uri, uuid, 'inicio', r.assets[0].width);
      fotoRef.current = uri;
      setFotoInicio(`${uri}?v=${Date.now()}`); // evita que la vista previa muestre la foto anterior
    } catch (e) {
      Alert.alert('Error', 'No se pudo guardar la foto en el celular.');
    }
  };

  const confirmar = (titulo, mensaje) => new Promise((resolve) => {
    Alert.alert(titulo, mensaje, [
      { text: 'Corregir', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Sí, es correcto', onPress: () => resolve(true) },
    ], { cancelable: false });
  });

  const iniciar = async () => {
    if (!material) return Alert.alert('Falta el material', 'Selecciona el tipo de material.');
    if (!origen || !destino) return Alert.alert('Falta la ruta', 'Selecciona origen y destino.');
    if (!remision.trim()) return Alert.alert('Falta la remisión', 'Ingresa el número de remisión.');
    if (requiereCantidad && !(cantidadNum > 0)) return Alert.alert('Falta la cantidad', 'Este equipo exige registrar la cantidad cargada.');
    if (chequeo.nivel === 'bloquear') {
      return Alert.alert('Cantidad no permitida', `La cantidad supera el máximo permitido (${chequeo.maximo} ${unidad}).`);
    }
    if (chequeo.nivel === 'advertir') {
      const ok = await confirmar('Revisa la cantidad', `Registraste ${cantidadNum} ${unidad} y la capacidad nominal es ${capacidad} ${unidad}.\n\n¿Es correcto?`);
      if (!ok) return;
    }
    if (!fotoRef.current) return Alert.alert('Falta la foto', 'Toma la foto de la carga antes de iniciar.');
    if (ajenosRef.current.length) {
      const seguir = await new Promise((resolve) => {
        Alert.alert('Tienes un viaje abierto en el sistema', describirAjenos(ajenosRef.current), [
          { text: 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Iniciar de todas formas', onPress: () => resolve(true) },
        ], { cancelable: false });
      });
      if (!seguir) return;
    }

    setGuardando(true);
    try {
      const pos = posicion || (await ubicacionConocida());
      await crearViajeLocal({
        uuid, placa, material, origen, destino,
        rutaId: ruta?.id ?? null, rutaNombre: ruta?.nombre ?? null,
        remision: remision.trim().toUpperCase(),
        cantidad: requiereCantidad || cantidadNum > 0 ? cantidadNum : null,
        lat: pos?.lat, lon: pos?.lon, fotoInicioPath: fotoRef.current,
      });
      iniciado.current = true;
      // 1) Permiso en primer plano + GPS como servicio en primer plano. Tiene que arrancar
      //    AHORA, con la app visible: Android no deja crearlo desde segundo plano.
      await pedirPermisoNotificaciones(); // aviso "Viaje en curso" en la barra (Android 13+); si lo niega, sigue
      const gps = await iniciarGPS(placa);
      enviarPendientes().catch(() => {});
      // 2) Si falta "Permitir todo el tiempo", pantalla propia que explica por qué y luego
      //    el permiso del sistema. Si no lo da, el viaje sigue igual (con aviso).
      const bg = await Location.getBackgroundPermissionsAsync().catch(() => ({ status: 'denied' }));
      if (gps.ok && bg.status !== 'granted') navigation.replace('PermisoUbicacion', { uuid });
      else navigation.replace('ViajeEnCurso', { uuid });
    } catch (e) {
      Alert.alert('No se pudo iniciar', e?.message || 'Error guardando el viaje en el celular.');
    } finally {
      setGuardando(false);
    }
  };

  if (cargando) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#f59e0b" />
        <Text style={{ color: '#64748b', marginTop: 10 }}>Verificando preoperacional...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.mobileHeader}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <FontAwesome5 name="arrow-left" size={20} color="#ffffff" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <FontAwesome5 name="route" size={18} color="#f59e0b" style={{ marginRight: 8 }} />
          <Text style={styles.headerTitle}>Iniciar Viaje</Text>
        </View>
        <View style={{ width: 20 }} />
      </View>

      <ScrollView contentContainerStyle={styles.formContainer} keyboardShouldPersistTaps="handled">
        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Vehículo</Text>
          <TextInput style={[styles.formInput, styles.placaInput]} value={placa} editable={false} />
        </View>

        <Selector etiqueta="Material" valor={material} placeholder="Selecciona el material" opciones={opcionesMaterial} onSelect={setMaterial} />
        <Selector etiqueta="Origen" valor={origen} placeholder={posicion ? 'Selecciona el origen' : 'Selecciona el origen (sin ubicación)'}
          opciones={opcionesOrigen} onSelect={(v) => { setOrigen(v); setDestino(''); }} />
        <Selector etiqueta="Destino" valor={destino} placeholder={origen ? 'Selecciona el destino' : 'Primero el origen'}
          opciones={opcionesDestino} onSelect={setDestino} deshabilitado={!origen} />

        {ruta ? (
          <View style={styles.rutaBadge}>
            <FontAwesome5 name="map-signs" size={14} color="#1e40af" style={{ marginRight: 8 }} />
            <Text style={styles.rutaBadgeTexto}>Ruta: {ruta.nombre}{ruta.distancia_km ? ` • ${ruta.distancia_km} km` : ''}</Text>
          </View>
        ) : null}

        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Remisión <Text style={{ color: '#ef4444' }}>*</Text></Text>
          <TextInput style={[styles.formInput, { textTransform: 'uppercase' }]} placeholder="Ej: 999123" placeholderTextColor="#94a3b8"
            autoCapitalize="characters" value={remision} onChangeText={setRemision} />
        </View>

        {requiereCantidad ? (
          <View style={styles.formGroup}>
            <Text style={styles.formLabel}>Cantidad {unidad ? `(${unidad})` : ''} <Text style={{ color: '#ef4444' }}>*</Text></Text>
            <TextInput
              style={[styles.formInput, chequeo.nivel === 'bloquear' && styles.inputError, chequeo.nivel === 'advertir' && styles.inputAviso]}
              keyboardType="numeric" placeholder={capacidad ? `Máx nominal: ${capacidad}` : '0.00'} placeholderTextColor="#94a3b8"
              value={cantidad} onChangeText={setCantidad}
            />
            {chequeo.nivel === 'bloquear' ? <Text style={styles.textoError}>Supera el máximo permitido ({chequeo.maximo} {unidad}).</Text> : null}
            {chequeo.nivel === 'advertir' ? <Text style={styles.textoAviso}>Supera la capacidad nominal ({capacidad} {unidad}). Verifica el tiquete.</Text> : null}
          </View>
        ) : null}

        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Foto de la carga <Text style={{ color: '#ef4444' }}>*</Text></Text>
          {fotoInicio ? <Image source={{ uri: fotoInicio }} style={styles.fotoPreview} /> : null}
          <TouchableOpacity style={[styles.btnFoto, fotoInicio && { backgroundColor: '#10b981' }]} onPress={tomarFoto}>
            <FontAwesome5 name={fotoInicio ? 'check-circle' : 'camera'} size={18} color="#fff" style={{ marginRight: 10 }} />
            <Text style={styles.btnFotoTexto}>{fotoInicio ? 'Foto lista (tocar para repetir)' : 'Tomar foto de carga'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={[styles.submitBtn, guardando && styles.submitBtnDisabled]} onPress={iniciar} disabled={guardando}>
          {guardando ? <ActivityIndicator color="#fff" /> : (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <FontAwesome5 name="play-circle" size={18} color="#fff" style={{ marginRight: 10 }} />
              <Text style={styles.submitBtnText}>Iniciar Viaje</Text>
            </View>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0f172a' },
  container: { flex: 1, backgroundColor: '#f8fafc' },
  mobileHeader: { backgroundColor: '#0f172a', paddingVertical: 15, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backBtn: { padding: 5 },
  headerTitleWrap: { flexDirection: 'row', alignItems: 'center' },
  headerTitle: { color: '#ffffff', fontSize: 18, fontWeight: '700' },
  formContainer: { padding: 20, paddingBottom: 50, backgroundColor: '#f8fafc', flexGrow: 1 },
  formGroup: { marginBottom: 18 },
  formLabel: { fontSize: 13, color: '#475569', fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' },
  formInput: { width: '100%', padding: 15, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, fontSize: 18, backgroundColor: '#ffffff', color: '#0f172a' },
  placaInput: { fontSize: 28, fontWeight: '900', textAlign: 'center', letterSpacing: 2, backgroundColor: '#f1f5f9' },
  inputError: { borderColor: '#ef4444', backgroundColor: '#fef2f2' },
  inputAviso: { borderColor: '#f59e0b', backgroundColor: '#fffbeb' },
  textoError: { marginTop: 6, color: '#b91c1c', fontWeight: '800', fontSize: 13 },
  textoAviso: { marginTop: 6, color: '#b45309', fontWeight: '800', fontSize: 13 },
  selector: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 15, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, backgroundColor: '#fff' },
  selectorTexto: { fontSize: 17, color: '#0f172a', flex: 1, marginRight: 10 },
  rutaBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#dbeafe', padding: 12, borderRadius: 8, marginBottom: 18 },
  rutaBadgeTexto: { color: '#1e40af', fontWeight: '800', flex: 1 },
  fotoPreview: { width: '100%', height: 180, borderRadius: 8, marginBottom: 10, backgroundColor: '#e2e8f0' },
  btnFoto: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#475569', padding: 16, borderRadius: 8 },
  btnFotoTexto: { color: '#fff', fontWeight: '900', fontSize: 15 },
  submitBtn: { backgroundColor: '#f59e0b', width: '100%', padding: 18, borderRadius: 8, marginTop: 10, justifyContent: 'center', alignItems: 'center' },
  submitBtnDisabled: { backgroundColor: '#94a3b8' },
  submitBtnText: { color: '#ffffff', fontSize: 19, fontWeight: '900' },
  modalFondo: { flex: 1, backgroundColor: 'rgba(15,23,42,0.6)', justifyContent: 'flex-end' },
  modalCaja: { backgroundColor: '#fff', borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '75%', padding: 16 },
  modalTitulo: { fontSize: 16, fontWeight: '900', color: '#0f172a', marginBottom: 10, textTransform: 'uppercase' },
  modalSeccion: { fontSize: 11, fontWeight: '900', color: '#64748b', marginTop: 12, marginBottom: 4, letterSpacing: 0.5 },
  modalOpcion: { paddingVertical: 14, borderBottomWidth: 1, borderColor: '#f1f5f9', flexDirection: 'row', justifyContent: 'space-between' },
  modalOpcionTexto: { fontSize: 16, color: '#0f172a', fontWeight: '600', flex: 1 },
  modalOpcionDetalle: { fontSize: 13, color: '#64748b', marginLeft: 10 },
  modalVacio: { color: '#64748b', textAlign: 'center', padding: 20 },
  modalCerrar: { marginTop: 10, backgroundColor: '#e2e8f0', padding: 14, borderRadius: 8, alignItems: 'center' },
  modalCerrarTexto: { fontWeight: '900', color: '#0f172a' },
});
