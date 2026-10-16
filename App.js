import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { guardarToken, leerToken } from './src/sesion';
import { FontAwesome5 } from '@expo/vector-icons'; // E4 · faltaba: la pantalla de error se caía

// Pantallas
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import PreoperacionalScreen from './src/screens/PreoperacionalScreen';
import CombustibleScreen from './src/screens/CombustibleScreen';
import ViajeScreen from './src/screens/ViajeScreen';
import ViajeEnCursoScreen from './src/screens/ViajeEnCursoScreen';
import PermisoUbicacionScreen from './src/screens/PermisoUbicacionScreen';

// Base de datos y Sincronización
import { iniciarBaseDeDatos, getDb } from './src/database/db';
import { prepararNotificaciones, escucharToques } from './src/recordatorioPreop';
import { enviarPendientes } from './src/database/syncUp';
import { sincronizarDatosMaestros, ultimoMotivoSync } from './src/database/sync';
import { API_URL } from './src/config';

const Stack = createNativeStackNavigator();
const navRef = createNavigationContainerRef();

export default function App() {
  const [isReady, setIsReady] = useState(false);
  const [userToken, setUserToken] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [errorDb, setErrorDb] = useState(null);
  const tokenRef = useRef(null);
  tokenRef.current = userToken;

  // Toque en el aviso del recordatorio: Preoperacional del equipo recordado, o Home si no hay.
  // Si la navegación aún no está lista (arranque en frío desde el aviso), se hace en onReady.
  const toquePendiente = useRef(false);
  const abrirDesdeRecordatorio = useCallback(async () => {
    if (!navRef.isReady()) { toquePendiente.current = true; return; }
    toquePendiente.current = false;
    if (!tokenRef.current) return; // sin sesión: se queda en el login
    try {
      const placa = await AsyncStorage.getItem('equipoRecordado');
      const eq = placa ? await (await getDb()).getFirstAsync('SELECT placa FROM equipos WHERE placa = ?', placa) : null;
      if (eq) navRef.navigate('Preoperacional', { placa: eq.placa });
      else navRef.navigate('Home');
    } catch (e) {
      console.warn('Recordatorio: no se pudo abrir el preoperacional:', e?.message || e);
    }
  }, []);

  useEffect(() => {
    prepararNotificaciones();
    return escucharToques(abrirDesdeRecordatorio);
  }, [abrirDesdeRecordatorio]);

  const prepararApp = useCallback(async () => {
    setIsReady(false);
    setErrorDb(null);
    try {
      // 1. Inicializar SQLite (Crea las tablas o aplica migraciones si es necesario)
      await iniciarBaseDeDatos();

      // 2. Auto-login: si hay token guardado se entra aunque esté vencido o no haya red.
      //    La captura funciona offline; el envío pide credenciales solo cuando haga falta.
      const tokenGuardado = await leerToken();
      if (tokenGuardado) setUserToken(tokenGuardado);
    } catch (error) {
      console.error('Error iniciando app:', error);
      setErrorDb(String(error?.message || error));
    } finally {
      setIsReady(true);
    }
  }, []);

  useEffect(() => { prepararApp(); }, [prepararApp]);

  // LÓGICA DE LOGIN: Guarda quién entró y sincroniza inmediatamente
  const manejarLoginExitoso = async (token, username) => {
    try {
      await guardarToken(token);
      if (username) {
        await AsyncStorage.setItem('userName', username.trim());
      }

      setIsSyncing(true);

      // 1. Subir cualquier reporte que haya quedado atascado
      await enviarPendientes();

      // 2. Bajar equipos y preguntas actualizados
      const syncExitoso = await sincronizarDatosMaestros(token, API_URL);
      if (!syncExitoso) {
        Alert.alert(
          'Aviso',
          ultimoMotivoSync === 'sin_red'
            ? 'Señal débil: se usará la lista de equipos y preguntas guardada en el celular.'
            : 'No se pudieron actualizar equipos y preguntas. Se usará la versión guardada en el celular.'
        );
      }
    } catch (error) {
      console.log('Error en el proceso post-login:', error);
    } finally {
      setIsSyncing(false);
      setUserToken(token);
    }
  };

  // Pantalla de carga si la BD local aún no arranca
  if (!isReady) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text style={styles.loadingText}>Iniciando OptiCore...</Text>
      </View>
    );
  }

  if (errorDb) {
    return (
      <View style={styles.loadingContainer}>
        <FontAwesome5 name="exclamation-triangle" size={40} color="#ef4444" />
        <Text style={styles.errorText}>No se pudo abrir la base de datos del celular.</Text>
        <Text style={styles.errorDetail}>{errorDb}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={prepararApp}>
          <FontAwesome5 name="redo" size={14} color="#fff" />
          <Text style={styles.retryText}>Reintentar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <NavigationContainer ref={navRef} onReady={() => { if (toquePendiente.current) abrirDesdeRecordatorio(); }}>
      <Stack.Navigator>
        {userToken == null ? (
          // ================= MÓDULO PÚBLICO (Sin Sesión) =================
          <Stack.Screen name="Login" options={{ headerShown: false }}>
            {(props) => (
              <View style={{ flex: 1 }}>
                <LoginScreen {...props} onLoginSuccess={manejarLoginExitoso} />

                {/* Overlay de carga mientras sincroniza por primera vez */}
                {isSyncing && (
                  <View style={styles.syncOverlay}>
                    <ActivityIndicator size="large" color="#ffffff" />
                    <Text style={styles.syncText}>Descargando Base de Datos...</Text>
                    <Text style={styles.syncSubtext}>Esto tomará unos segundos</Text>
                  </View>
                )}
              </View>
            )}
          </Stack.Screen>
        ) : (
          // ================= MÓDULO PRIVADO (Con Sesión) =================
          <>
            <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Preoperacional" component={PreoperacionalScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Combustible" component={CombustibleScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Viaje" component={ViajeScreen} options={{ headerShown: false }} />
            <Stack.Screen name="ViajeEnCurso" component={ViajeEnCursoScreen} options={{ headerShown: false }} />
            <Stack.Screen name="PermisoUbicacion" component={PermisoUbicacionScreen} options={{ headerShown: false }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    padding: 24,
  },
  loadingText: {
    marginTop: 15,
    color: '#94a3b8',
    fontSize: 16,
    fontWeight: 'bold',
  },
  errorText: {
    marginTop: 15,
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  errorDetail: {
    marginTop: 8,
    color: '#94a3b8',
    fontSize: 12,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 24,
    backgroundColor: '#3b82f6',
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  retryText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  syncOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  syncText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 20,
  },
  syncSubtext: {
    color: '#94a3b8',
    fontSize: 14,
    marginTop: 5,
  }
});
