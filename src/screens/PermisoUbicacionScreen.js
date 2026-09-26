import React, { useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ScrollView, ActivityIndicator, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Location from 'expo-location';

/**
 * Se muestra al iniciar un viaje cuando falta "Permitir todo el tiempo".
 * Explica POR QUÉ antes de abrir el permiso del sistema (en Android 11+ el sistema
 * lleva a la pantalla de ajustes de ubicación de la app). Si el conductor no lo da,
 * el viaje sigue igual: el GPS ya está corriendo como servicio en primer plano.
 */
export default function PermisoUbicacionScreen({ route, navigation }) {
  const { uuid } = route.params || {};
  const [pidiendo, setPidiendo] = useState(false);

  const seguir = (conPermiso) => navigation.replace('ViajeEnCurso', { uuid, avisoSegundoPlano: !conPermiso });

  const pedirPermiso = async () => {
    setPidiendo(true);
    try {
      const r = await Location.requestBackgroundPermissionsAsync();
      if (r.status === 'granted') return seguir(true);
      // "No volver a preguntar" o rechazo: la única vía es la pantalla de ajustes de la app
      if (!r.canAskAgain) await Linking.openSettings();
      seguir(false);
    } catch {
      seguir(false);
    } finally {
      setPidiendo(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.contenido}>
        <View style={styles.icono}>
          <FontAwesome5 name="map-marked-alt" size={42} color="#f59e0b" />
        </View>
        <Text style={styles.titulo}>Permite la ubicación "todo el tiempo"</Text>
        <Text style={styles.texto}>
          Durante el viaje, OptiCore registra el recorrido de la volqueta para calcular la ruta y soportar el viaje ante el cliente.
        </Text>
        <Text style={styles.texto}>
          Con la pantalla apagada o usando otra app, Android puede pausar el GPS si solo tiene permiso "mientras se usa la app".
          Con <Text style={styles.negrita}>"Permitir todo el tiempo"</Text> el recorrido queda completo.
        </Text>

        <View style={styles.pasos}>
          <Text style={styles.pasosTitulo}>En la siguiente pantalla:</Text>
          <Text style={styles.paso}>1. Toca <Text style={styles.negrita}>Ubicación</Text> (si aparece).</Text>
          <Text style={styles.paso}>2. Elige <Text style={styles.negrita}>Permitir todo el tiempo</Text>.</Text>
          <Text style={styles.paso}>3. Vuelve a la app con el botón Atrás.</Text>
        </View>

        <Text style={styles.nota}>
          Solo se usa durante un viaje en curso. Mientras registra, verás la notificación "Viaje en curso".
        </Text>

        <TouchableOpacity style={styles.btnPrincipal} onPress={pedirPermiso} disabled={pidiendo}>
          {pidiendo ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrincipalTexto}>Continuar</Text>}
        </TouchableOpacity>
        <TouchableOpacity style={styles.btnSecundario} onPress={() => seguir(false)} disabled={pidiendo}>
          <Text style={styles.btnSecundarioTexto}>Ahora no</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0f172a' },
  contenido: { padding: 24, paddingBottom: 40, flexGrow: 1, justifyContent: 'center' },
  icono: { alignSelf: 'center', backgroundColor: '#1e293b', width: 90, height: 90, borderRadius: 45, justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  titulo: { color: '#fff', fontSize: 22, fontWeight: '900', textAlign: 'center', marginBottom: 16 },
  texto: { color: '#cbd5e1', fontSize: 15, lineHeight: 22, marginBottom: 12 },
  negrita: { fontWeight: '900', color: '#fff' },
  pasos: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16, marginVertical: 10 },
  pasosTitulo: { color: '#fbbf24', fontWeight: '900', marginBottom: 8 },
  paso: { color: '#e2e8f0', fontSize: 15, marginBottom: 4 },
  nota: { color: '#94a3b8', fontSize: 13, marginTop: 6, marginBottom: 20 },
  btnPrincipal: { backgroundColor: '#f59e0b', padding: 18, borderRadius: 10, alignItems: 'center', marginBottom: 12 },
  btnPrincipalTexto: { color: '#fff', fontWeight: '900', fontSize: 18 },
  btnSecundario: { padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  btnSecundarioTexto: { color: '#cbd5e1', fontWeight: '800', fontSize: 15 },
});
