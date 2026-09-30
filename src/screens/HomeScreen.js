import React, { useState, useEffect, useRef, useCallback } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Alert, Modal, ActivityIndicator, ScrollView, AppState } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, Camera } from 'expo-camera';
import { FontAwesome5 } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { borrarToken, guardarToken, leerToken } from '../sesion';
import * as Updates from 'expo-updates';

import LoginScreen from './LoginScreen';
import { getDb, esMaquinaria } from '../database/db';
import { sincronizarDatosMaestros, ultimoMotivoSync } from '../database/sync';
import { enviarPendientes, contarPendientes, iniciarAutoSync } from '../database/syncUp';
import { API_URL } from '../config';
import { fetchConTimeout } from '../red';
import { viajeEnCurso, viajesConProblema, viajesAbiertosAjenos, describirAjenos } from '../viajes';
import { asegurarGPS } from '../gps/control';
import { esperarFotosTiquete, reintentarFotosTiquete } from '../tiquetes';

// Equipo recordado: la última placa validada en este celular (se borra con "Cambiar" y "Salir")
const CLAVE_EQUIPO = 'equipoRecordado';

// R7 · Estado de conexión con tres causas distintas, para que el operador sepa qué hacer
const ESTADOS = {
  ok: { texto: 'EN LÍNEA', color: '#10b981' },
  sin_red: { texto: 'SIN SEÑAL', color: '#ef4444' },
  servidor: { texto: 'SERVIDOR NO DISPONIBLE', color: '#f59e0b' },
  sesion: { texto: 'SESIÓN POR RENOVAR', color: '#f59e0b' },
};

export default function HomeScreen({ navigation }) {
  const [hasPermission, setHasPermission] = useState(null);
  const [equipoActual, setEquipoActual] = useState(null); // { placa, tipo, usaHoras }
  const equipoRef = useRef(null);
  equipoRef.current = equipoActual;
  const [placaInput, setPlacaInput] = useState('');

  const [scanned, setScanned] = useState(false);
  const [showCamera, setShowCamera] = useState(false);

  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('Nunca');
  const [estadoRed, setEstadoRed] = useState('ok');
  const [pedirLogin, setPedirLogin] = useState(false);

  // Estado de la cola de envíos
  const [pendientes, setPendientes] = useState({ pendientes: 0, errores: 0 });
  const sincronizando = useRef(false);

  // Viaje en curso en este celular (solo puede haber uno)
  const [viajeActivo, setViajeActivo] = useState(null);
  // Viaje con problema de envío (error permanente): la franja lleva a reintentar o descartar
  const [viajeProblema, setViajeProblema] = useState(null);
  // Viajes abiertos en el servidor que este celular no tiene (se consulta con cada sincronización)
  const [ajenos, setAjenos] = useState([]);
  const refrescarViaje = useCallback(async () => {
    try { setViajeActivo(await viajeEnCurso()); } catch {}
    try { setViajeProblema((await viajesConProblema())[0] || null); } catch {}
  }, []);

  const sincronizarFondo = useCallback(async () => {
    if (sincronizando.current) return;
    sincronizando.current = true;
    setIsSyncing(true);
    try {
      const envio = await enviarPendientes(); // 1. Sube

      // E3 · Sesión vencida: NO se borra el token ni se saca al operador. Puede seguir
      // capturando; se le pide iniciar sesión solo para enviar.
      if (envio.sesionExpirada) {
        setEstadoRed('sesion');
        return;
      }

      const token = await leerToken();
      const exito = await sincronizarDatosMaestros(token, API_URL); // 2. Baja

      if (exito || ultimoMotivoSync === 'vacio') {
        setEstadoRed('ok');
        const l = await viajesAbiertosAjenos({ token, apiUrl: API_URL });
        if (l) setAjenos(l); // null = no se pudo consultar: se deja lo último conocido
        const nuevaFecha = await AsyncStorage.getItem('lastSyncDate');
        if (nuevaFecha) setLastSync(nuevaFecha);
      } else if (ultimoMotivoSync === 'sesion') {
        setEstadoRed('sesion');
      } else if (ultimoMotivoSync === 'sin_red' || envio.sinRed) {
        setEstadoRed('sin_red');
      } else {
        setEstadoRed('servidor');
      }
    } catch (e) {
      setEstadoRed('sin_red');
    } finally {
      try { setPendientes(await contarPendientes()); } catch {}
      refrescarViaje();
      setIsSyncing(false);
      sincronizando.current = false;
    }
  }, [refrescarViaje]);

  useEffect(() => {
    async function inicializar() {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');

      const fechaGuardada = await AsyncStorage.getItem('lastSyncDate');
      if (fechaGuardada) setLastSync(fechaGuardada);

      // Si hay un viaje en curso y el GPS no está corriendo (reinicio del celular, cierre
      // forzado), se reanuda ahora: Android solo lo permite con la app abierta.
      asegurarGPS().catch(() => {});

      // Equipo recordado: entra directo al panel del equipo (el preoperacional se sigue
      // exigiendo al iniciar el viaje, igual que antes)
      const restaurado = await restaurarEquipo();

      // Sincronización inicial al abrir (única; el listener ya no dispara otra en paralelo)
      await sincronizarFondo();
      // Primer uso sin equipos descargados: se reintenta con la lista recién bajada
      if (!restaurado && !equipoRef.current) await restaurarEquipo();
    }

    inicializar();

    // Sube apenas el celular recupera señal
    const cancelar = iniciarAutoSync(sincronizarFondo);

    // Al volver la app al frente: si el sistema mató el servicio GPS (ahorro de batería del
    // fabricante) y hay viaje en curso, se reanuda; y se sube lo acumulado.
    const subApp = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      asegurarGPS().catch(() => {});
      refrescarViaje();
      enviarPendientes().then(async () => setPendientes(await contarPendientes())).catch(() => {});
    });

    return () => { cancelar(); subApp.remove(); }; // Limpia los listeners si la pantalla se desmonta
  }, [sincronizarFondo]);

  // Mientras hay un viaje en curso, la cola (puntos GPS) se sube cada 60 s con la app abierta
  useEffect(() => {
    if (!viajeActivo) return undefined;
    // Solo sube (no vuelve a bajar los maestros cada minuto)
    const t = setInterval(() => {
      enviarPendientes().then(async () => setPendientes(await contarPendientes())).catch(() => {});
    }, 60000);
    return () => clearInterval(t);
  }, [viajeActivo]);

  // Al volver de un formulario, actualizar el contador de pendientes
  useEffect(() => {
    const unsub = navigation.addListener('focus', async () => {
      try { setPendientes(await contarPendientes()); } catch {}
      refrescarViaje();
    });
    return unsub;
  }, [navigation, refrescarViaje]);

  // Re-login desde el aviso de sesión vencida: guarda el token nuevo y reintenta el envío
  const reloginExitoso = async (token, username) => {
    await guardarToken(token);
    if (username) await AsyncStorage.setItem('userName', username.trim());
    setPedirLogin(false);
    setEstadoRed('ok');
    sincronizarFondo();
  };

  const cerrarSesion = async () => {
    const { pendientes: n } = await contarPendientes();
    Alert.alert(
      'Cerrar Sesión',
      n > 0 ? `Tienes ${n} registro(s) sin enviar. Se conservarán en el celular. ¿Salir?` : '¿Deseas salir?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Salir', style: 'destructive', onPress: async () => {
            // El token de la app dura días: se revoca en el servidor si hay señal (sin esperar más de 5 s)
            const token = await leerToken();
            if (token) {
              await fetchConTimeout(`${API_URL}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, 5000).catch(() => {});
            }
            await borrarToken();
            await AsyncStorage.removeItem(CLAVE_EQUIPO);
            Updates.reloadAsync();
          },
        },
      ]
    );
  };

  /**
   * Al abrir: si hay viaje en curso manda su placa; si no, la placa recordada. Solo se usa
   * si existe en los equipos descargados (sin alertas). Si la lista existe y la placa ya no
   * está (equipo retirado), se olvida. Devuelve true si entró al panel.
   */
  async function restaurarEquipo() {
    try {
      const viaje = await viajeEnCurso();
      const guardada = await AsyncStorage.getItem(CLAVE_EQUIPO);
      const placa = viaje?.placa || guardada;
      if (!placa) return false;
      const db = await getDb();
      const eq = await db.getFirstAsync('SELECT * FROM equipos WHERE placa = ?', placa);
      if (eq) {
        if (!equipoRef.current) setEquipoActual({ placa: eq.placa, tipo: eq.tipo || 'VEHÍCULO', usaHoras: esMaquinaria(eq) });
        return true;
      }
      const { n } = await db.getFirstAsync('SELECT COUNT(*) AS n FROM equipos');
      if (n > 0 && guardada === placa) await AsyncStorage.removeItem(CLAVE_EQUIPO);
    } catch { /* sin equipo recordado: se muestra la selección como siempre */ }
    return false;
  }

  const cambiarEquipo = async () => {
    setEquipoActual(null);
    setPlacaInput('');
    try { await AsyncStorage.removeItem(CLAVE_EQUIPO); } catch { /* no bloquea */ }
  };

  // E7 · Solo se aceptan placas que existen en los equipos descargados
  const seleccionarEquipo = async (placaTexto) => {
    const placaClean = placaTexto ? placaTexto.trim().toUpperCase() : '';
    if (placaClean.length < 3) { Alert.alert('Aviso', 'Placa no válida.'); return; }
    setShowCamera(false);

    try {
      const db = await getDb();
      const eq = await db.getFirstAsync('SELECT * FROM equipos WHERE placa = ?', placaClean);
      if (eq) {
        setEquipoActual({ placa: eq.placa, tipo: eq.tipo || 'VEHÍCULO', usaHoras: esMaquinaria(eq) });
        await AsyncStorage.setItem(CLAVE_EQUIPO, eq.placa);
        return;
      }

      const { n } = await db.getFirstAsync('SELECT COUNT(*) AS n FROM equipos');
      if (n === 0) {
        Alert.alert('Sin equipos descargados', 'Conéctate a internet y toca el botón de sincronizar para descargar la lista de equipos.');
        return;
      }

      const parecidas = await db.getAllAsync(
        'SELECT placa FROM equipos WHERE placa LIKE ? ORDER BY placa LIMIT 4',
        `%${placaClean.slice(0, 3)}%`
      );
      Alert.alert(
        'Placa no registrada',
        `La placa ${placaClean} no está en la lista de equipos de tu empresa.` +
          (parecidas.length ? `\n\n¿Quisiste decir: ${parecidas.map((p) => p.placa).join(', ')}?` : '') +
          '\n\nSi es un equipo nuevo, pide que lo registren y sincroniza de nuevo.'
      );
    } catch (e) {
      Alert.alert('Error', 'No se pudo consultar la lista de equipos del celular.');
    }
  };

  const handleBarCodeScanned = ({ data }) => {
    setScanned(true);
    let placaDetectada = data;
    if (data.includes('placa=')) {
      const urlParams = new URLSearchParams(data.split('?')[1]);
      placaDetectada = urlParams.get('placa') || data;
    }
    seleccionarEquipo(placaDetectada);
  };

  const estado = ESTADOS[estadoRed] || ESTADOS.ok;

  const avisoSesion = estadoRed === 'sesion' ? (
    <TouchableOpacity style={styles.bannerSesion} onPress={() => setPedirLogin(true)}>
      <FontAwesome5 name="user-lock" size={16} color="#0f172a" />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={styles.bannerTitulo}>Inicia sesión para enviar</Text>
        <Text style={styles.bannerTexto}>Puedes seguir registrando. Todo queda guardado en el celular.</Text>
      </View>
      <FontAwesome5 name="chevron-right" size={12} color="#0f172a" />
    </TouchableOpacity>
  ) : null;

  // Aviso de viaje en curso: visible en la selección de equipo y en el panel
  const avisoViaje = viajeActivo ? (
    <TouchableOpacity style={styles.bannerViaje} onPress={() => navigation.navigate('ViajeEnCurso', { uuid: viajeActivo.uuid })}>
      <FontAwesome5 name="route" size={16} color="#0f172a" />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={styles.bannerTitulo}>Viaje en curso • {viajeActivo.placa}</Text>
        <Text style={styles.bannerTexto}>{viajeActivo.origen} ➔ {viajeActivo.destino} • toca para ver o finalizar</Text>
      </View>
      <FontAwesome5 name="chevron-right" size={12} color="#0f172a" />
    </TouchableOpacity>
  ) : null;

  const avisoProblema = viajeProblema && viajeProblema.uuid !== viajeActivo?.uuid ? (
    <TouchableOpacity style={styles.bannerProblema} onPress={() => navigation.navigate('ViajeEnCurso', { uuid: viajeProblema.uuid })}>
      <FontAwesome5 name="exclamation-triangle" size={16} color="#fff" />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={[styles.bannerTitulo, { color: '#fff' }]}>Viaje con problema de envío • {viajeProblema.placa}</Text>
        <Text style={[styles.bannerTexto, { color: '#fee2e2' }]}>Remisión {viajeProblema.remision} • toca para reintentar o descartar</Text>
      </View>
      <FontAwesome5 name="chevron-right" size={12} color="#fff" />
    </TouchableOpacity>
  ) : null;

  // Fotos de tiquetes (v11): tarjeta propia, solo si hay alguna por enviar o con error
  const [enviandoFotos, setEnviandoFotos] = useState(false);
  const fotos = pendientes.fotos;
  const enviarFotos = async (reintentar) => {
    setEnviandoFotos(true);
    try {
      if (reintentar) await reintentarFotosTiquete();
      await enviarPendientes({ forzarFotos: true });
      await esperarFotosTiquete();
    } catch { /* el diagnóstico queda en la tarjeta */ }
    finally {
      try { setPendientes(await contarPendientes()); } catch {}
      setEnviandoFotos(false);
    }
  };
  let diagFotos = null;
  if (fotos?.ultimo) {
    const d = fotos.ultimo;
    diagFotos = `Último intento ${String(d.hora || '').slice(11, 16)} (${d.placa}): ${d.codigo} · ${d.mensaje}`;
  } else if (fotos?.esperandoTanqueo) {
    diagFotos = 'Se envían después de que llegue el tanqueo.';
  }
  const avisoFotos = fotos && (fotos.pendientes > 0 || fotos.errores > 0) ? (
    <View style={styles.tarjetaFotos}>
      <View style={styles.rowCenter}>
        <FontAwesome5 name="receipt" size={15} color="#0f172a" />
        <Text style={[styles.bannerTitulo, { marginLeft: 8, flex: 1 }]}>
          Fotos de tiquetes{fotos.pendientes > 0 ? ` · ${fotos.pendientes} por enviar` : ''}{fotos.errores > 0 ? ` · ${fotos.errores} con error` : ''}
        </Text>
      </View>
      {diagFotos ? <Text style={styles.bannerTexto} selectable>{diagFotos}</Text> : null}
      <View style={[styles.row, { marginTop: 10, marginBottom: 0 }]}>
        {fotos.pendientes > 0 ? (
          <TouchableOpacity style={styles.btnFotos} onPress={() => enviarFotos(false)} disabled={enviandoFotos}>
            {enviandoFotos ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnFotosTexto}>Enviar ahora</Text>}
          </TouchableOpacity>
        ) : null}
        {fotos.errores > 0 ? (
          <TouchableOpacity style={[styles.btnFotos, { backgroundColor: '#b91c1c' }]} onPress={() => enviarFotos(true)} disabled={enviandoFotos}>
            {enviandoFotos ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnFotosTexto}>Reintentar</Text>}
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  ) : null;

  const avisoAjenos = ajenos.length ? (
    <TouchableOpacity style={styles.bannerAjenos} onPress={() => Alert.alert('Viajes abiertos en el sistema', describirAjenos(ajenos))}>
      <FontAwesome5 name="exclamation-circle" size={16} color="#0f172a" />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={styles.bannerTitulo}>{ajenos.length === 1 ? '1 viaje abierto' : `${ajenos.length} viajes abiertos`} en el sistema</Text>
        <Text style={styles.bannerTexto}>No están en este celular • toca para ver qué hacer</Text>
      </View>
      <FontAwesome5 name="chevron-right" size={12} color="#0f172a" />
    </TouchableOpacity>
  ) : null;

  const abrirViaje = () => {
    if (viajeActivo) navigation.navigate('ViajeEnCurso', { uuid: viajeActivo.uuid });
    else navigation.navigate('Viaje', { placa: equipoActual.placa });
  };

  const modalLogin = (
    <Modal visible={pedirLogin} animationType="slide" onRequestClose={() => setPedirLogin(false)}>
      <View style={{ flex: 1 }}>
        <LoginScreen onLoginSuccess={reloginExitoso} />
        <TouchableOpacity style={styles.btnCerrarModal} onPress={() => setPedirLogin(false)}>
          <Text style={styles.btnCerrarModalText}>Ahora no</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );

  if (hasPermission === null) return <View style={styles.centerContainer}><ActivityIndicator size="large" color="#3b82f6" /></View>;

  if (!equipoActual) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.containerScan}>
          <View style={styles.headerScan}>
            <View>
              <Text style={styles.titleScan}>Seleccionar Equipo</Text>
              <Text style={styles.subtitleScan}>Escanea el QR para iniciar operación</Text>
            </View>
            <TouchableOpacity style={styles.btnIconTop} onPress={cerrarSesion}>
              <FontAwesome5 name="sign-out-alt" size={16} color="#ef4444" />
            </TouchableOpacity>
          </View>
          {avisoSesion}
          {avisoViaje}
          {avisoProblema}
          {avisoAjenos}
          {avisoFotos}
          <TouchableOpacity style={styles.btnQrGiant} onPress={() => { setScanned(false); setShowCamera(true); }}>
            <FontAwesome5 name="qrcode" size={40} color="#fff" style={{ marginBottom: 15 }} />
            <Text style={styles.btnQrTextGiant}>Escanear Código QR</Text>
          </TouchableOpacity>
          <Text style={styles.orText}>--- O INGRESA MANUALMENTE ---</Text>
          <View style={styles.cardManual}>
            <TextInput style={styles.inputManual} placeholder="EJ: SCM001" placeholderTextColor="#475569" value={placaInput} onChangeText={setPlacaInput} autoCapitalize="characters" />
            <TouchableOpacity style={styles.btnActionScan} onPress={() => seleccionarEquipo(placaInput)}>
              <Text style={styles.btnTextScan}>Continuar</Text>
            </TouchableOpacity>
          </View>
          <Modal visible={showCamera} animationType="slide">
            <View style={styles.cameraContainer}>
              <CameraView onBarcodeScanned={scanned ? undefined : handleBarCodeScanned} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} style={StyleSheet.absoluteFillObject} />
              <View style={styles.cameraOverlay}>
                <TouchableOpacity style={styles.btnCloseCamera} onPress={() => setShowCamera(false)}>
                  <Text style={styles.btnTextScan}>Cancelar</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
          {modalLogin}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.hubContainer}>
        <View style={styles.hubHeader}>
          <View style={styles.userInfo}>
            <View style={styles.userAvatar}>
              <FontAwesome5 name="user" size={18} color="#ffffff" />
            </View>
            <View style={{ marginLeft: 10, flexShrink: 1 }}>
              <Text style={styles.userTitle}>Operación</Text>
              <View style={styles.rowCenter}>
                <View style={[styles.dotOffline, { backgroundColor: estado.color }]} />
                <Text style={styles.userSubtitle}>{estado.texto} • Sync: {lastSync}</Text>
              </View>
              {pendientes.pendientes > 0 && <Text style={[styles.userSubtitle, { color: '#f59e0b', marginTop: 2 }]}>• {pendientes.pendientes} por enviar</Text>}
              {pendientes.errores > 0 && <Text style={[styles.userSubtitle, { color: '#ef4444', marginTop: 2 }]}>• {pendientes.errores} con error</Text>}
            </View>
          </View>
          <View style={styles.topActions}>
            <TouchableOpacity style={styles.btnTopSmall} onPress={sincronizarFondo} disabled={isSyncing}>
              {isSyncing ? <ActivityIndicator size="small" color="#fff" /> : <FontAwesome5 name="sync-alt" size={16} color="#fff" />}
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnTopSmall} onPress={cerrarSesion}>
              <FontAwesome5 name="sign-out-alt" size={16} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {avisoSesion}
        {avisoViaje}
        {avisoProblema}
        {avisoAjenos}
        {avisoFotos}

        <View style={styles.equipoCard}>
          <View style={styles.equipoIconWrap}><FontAwesome5 name={equipoActual.usaHoras ? 'tractor' : 'truck'} size={28} color="#fff" /></View>
          <View style={styles.equipoInfo}>
            <Text style={styles.equipoLabel}>EQUIPO ACTUAL</Text>
            <Text style={styles.equipoName}>{equipoActual.placa}</Text>
            <Text style={styles.equipoDesc}>{equipoActual.tipo} • {equipoActual.usaHoras ? 'Horómetro' : 'Odómetro'}</Text>
          </View>
          <TouchableOpacity style={styles.btnCambiar} onPress={cambiarEquipo}>
            <FontAwesome5 name="exchange-alt" size={12} color="#fff" />
            <Text style={styles.btnCambiarText}>Cambiar</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.row}>
          <TouchableOpacity style={[styles.cardPrimary, { backgroundColor: '#3b82f6' }]} onPress={() => navigation.navigate('Preoperacional', { placa: equipoActual.placa })}>
            <View style={styles.iconLightWrap}><FontAwesome5 name="clipboard-check" size={18} color="#3b82f6" /></View>
            <Text style={styles.cardTitle}>Preoperacional</Text>
            <Text style={styles.cardSubtitle}>Verificar el equipo</Text>
            <FontAwesome5 name="chevron-right" size={12} color="#fff" style={styles.chevronPos} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.cardPrimary, { backgroundColor: '#10b981' }]} onPress={() => navigation.navigate('Combustible', { placa: equipoActual.placa })}>
            <View style={[styles.iconLightWrap, { backgroundColor: 'rgba(255,255,255,0.2)' }]}><FontAwesome5 name="gas-pump" size={18} color="#fff" /></View>
            <Text style={styles.cardTitle}>Combustible</Text>
            <Text style={styles.cardSubtitle}>Suministro</Text>
            <FontAwesome5 name="chevron-right" size={12} color="#fff" style={styles.chevronPos} />
          </TouchableOpacity>
        </View>
        <View style={styles.row}>
          <TouchableOpacity style={[styles.cardPrimary, { backgroundColor: '#f59e0b', minHeight: 110 }]} onPress={abrirViaje}>
            <View style={[styles.iconLightWrap, { backgroundColor: 'rgba(255,255,255,0.25)' }]}><FontAwesome5 name="route" size={18} color="#fff" /></View>
            <Text style={styles.cardTitle}>{viajeActivo ? 'Viaje en curso' : 'Viaje'}</Text>
            <Text style={styles.cardSubtitle}>{viajeActivo ? `${viajeActivo.placa} • ${viajeActivo.origen} ➔ ${viajeActivo.destino}` : 'Iniciar un viaje con carga'}</Text>
            <FontAwesome5 name="chevron-right" size={12} color="#fff" style={styles.chevronPos} />
          </TouchableOpacity>
        </View>
      </ScrollView>
      {modalLogin}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0f172a' },
  centerContainer: { flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center' },
  containerScan: { flex: 1, padding: 20 },
  headerScan: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 40 },
  titleScan: { fontSize: 24, fontWeight: '900', color: '#fff' },
  subtitleScan: { fontSize: 14, color: '#94a3b8' },
  btnIconTop: { backgroundColor: '#1e293b', padding: 12, borderRadius: 8 },
  btnQrGiant: { backgroundColor: '#1e293b', padding: 40, borderRadius: 20, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  btnQrTextGiant: { color: '#fff', fontWeight: 'bold', fontSize: 18 },
  orText: { textAlign: 'center', color: '#64748b', marginVertical: 30, fontWeight: '800', letterSpacing: 1 },
  cardManual: { backgroundColor: '#1e293b', padding: 20, borderRadius: 15, borderWidth: 1, borderColor: '#334155' },
  inputManual: { backgroundColor: '#0f172a', borderWidth: 1, borderColor: '#334155', borderRadius: 8, padding: 15, fontSize: 22, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginBottom: 15 },
  btnActionScan: { backgroundColor: '#3b82f6', padding: 15, borderRadius: 8, alignItems: 'center' },
  btnTextScan: { color: '#fff', fontWeight: '900', fontSize: 16, textTransform: 'uppercase' },
  hubContainer: { padding: 15, paddingBottom: 40 },
  hubHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  userInfo: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  userAvatar: { width: 45, height: 45, borderRadius: 25, backgroundColor: '#3b82f6', justifyContent: 'center', alignItems: 'center' },
  userTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  userSubtitle: { color: '#94a3b8', fontSize: 11, fontWeight: 'bold', marginLeft: 4 },
  rowCenter: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  dotOffline: { width: 8, height: 8, borderRadius: 4 },
  topActions: { flexDirection: 'row', gap: 8 },
  btnTopSmall: { backgroundColor: '#1e293b', width: 40, height: 40, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  bannerSesion: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fbbf24', borderRadius: 12, padding: 14, marginBottom: 15 },
  bannerTitulo: { color: '#0f172a', fontWeight: '900', fontSize: 14 },
  bannerViaje: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fcd34d', borderRadius: 12, padding: 14, marginBottom: 15 },
  bannerProblema: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#dc2626', borderRadius: 12, padding: 14, marginBottom: 15 },
  bannerAjenos: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fdba74', borderRadius: 12, padding: 14, marginBottom: 15 },
  bannerTexto: { color: '#1e293b', fontSize: 12, marginTop: 2 },
  tarjetaFotos: { backgroundColor: '#bfdbfe', borderRadius: 12, padding: 14, marginBottom: 15 },
  btnFotos: { flex: 1, backgroundColor: '#1e40af', paddingVertical: 11, borderRadius: 8, alignItems: 'center' },
  btnFotosTexto: { color: '#fff', fontWeight: '900', fontSize: 14 },
  btnCerrarModal: { position: 'absolute', top: 50, right: 20, backgroundColor: '#1e293b', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  btnCerrarModalText: { color: '#fff', fontWeight: 'bold' },
  equipoCard: { backgroundColor: '#1e293b', borderRadius: 16, padding: 20, marginBottom: 15, flexDirection: 'row', alignItems: 'center' },
  equipoIconWrap: { width: 60, height: 60, backgroundColor: '#334155', borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 15 },
  equipoInfo: { flex: 1 },
  equipoLabel: { color: '#94a3b8', fontSize: 10, fontWeight: 'bold', letterSpacing: 1, marginBottom: 2 },
  equipoName: { color: '#fff', fontSize: 18, fontWeight: '900', marginBottom: 2 },
  equipoDesc: { color: '#cbd5e1', fontSize: 12, marginBottom: 6 },
  btnCambiar: { position: 'absolute', right: 15, bottom: 15, backgroundColor: '#334155', flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, alignItems: 'center' },
  btnCambiarText: { color: '#fff', fontSize: 12, fontWeight: 'bold', marginLeft: 6 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  cardPrimary: { flex: 1, borderRadius: 16, padding: 15, minHeight: 140, justifyContent: 'space-between' },
  iconLightWrap: { width: 40, height: 40, backgroundColor: 'rgba(255,255,255,0.8)', borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  cardTitle: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginTop: 15 },
  cardSubtitle: { color: 'rgba(255,255,255,0.8)', fontSize: 11 },
  chevronPos: { position: 'absolute', right: 15, bottom: 20 },
  cameraContainer: { flex: 1, justifyContent: 'flex-end' },
  cameraOverlay: { position: 'absolute', bottom: 40, left: 20, right: 20, alignItems: 'center' },
  btnCloseCamera: { backgroundColor: '#ef4444', padding: 15, borderRadius: 8, width: '100%', alignItems: 'center' },
});
