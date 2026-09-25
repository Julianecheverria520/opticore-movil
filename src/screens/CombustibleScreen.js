import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, Switch, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import { API_URL } from '../config';
import { getDb, nuevoUUID, ahoraISO, parseNum, parseMoneda, esMaquinaria } from '../database/db';
import { enviarPendientes } from '../database/syncUp';
import { fetchConTimeout, formatearPesos } from '../red';

// Por debajo de este precio por galón casi seguro es un error de digitación (p. ej. "150" en vez de "150.000")
const PRECIO_GALON_MINIMO = 5000;

export default function CombustibleScreen({ route, navigation }) {
  const { placa } = route.params;

  const [lecturaBase, setLecturaBase] = useState(0);
  const [unidad, setUnidad] = useState('Km');
  const [capacidadTanque, setCapacidadTanque] = useState(null);
  const [loadingInitial, setLoadingInitial] = useState(true);

  const [lecturaActual, setLecturaActual] = useState('');
  const [galones, setGalones] = useState('');
  const [valor, setValor] = useState('');
  const [proveedor, setProveedor] = useState('');
  const [tanqueLleno, setTanqueLleno] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    async function cargarDatos() {
      const placaLimpia = (placa || '').trim().toUpperCase();

      // 1. CARGA OFFLINE
      try {
        const db = await getDb();
        const equipo = await db.getFirstAsync('SELECT * FROM equipos WHERE placa = ?', placaLimpia);

        if (equipo) {
          const esMaq = esMaquinaria(equipo);
          setUnidad(esMaq ? "Hrs" : "Km");
          setLecturaBase(esMaq ? (equipo.ultimo_horometro || 0) : (equipo.ultimo_odometro || 0));
          setCapacidadTanque(equipo.capacidad_tanque_gal || null);
        }
      } catch (e) {
        console.error("Error offline:", e);
      } finally {
        setLoadingInitial(false);
      }

      // 2. ACTUALIZACIÓN ONLINE. R4 · máximo 5 s con señal débil.
      try {
        const token = await AsyncStorage.getItem('userToken');
        const resVal = await fetchConTimeout(`${API_URL}/maestros/equipos/preoperacional/validar/${encodeURIComponent(placaLimpia)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }, 5000);

        if (resVal.ok) {
          const dataVal = await resVal.json();
          const usaHoro = !!dataVal.tiene_horometro;
          setUnidad(usaHoro ? "Hrs" : "Km");
          setLecturaBase(prev => {
             const valLocal = parseNum(prev);
             const valRemoto = parseNum(usaHoro ? dataVal.ultimo_horometro : dataVal.ultimo_odometro);
             return Math.max(valLocal, valRemoto);
          });
        }
      } catch (error) {
        console.log("Sin red. Usando histórico local.");
      }
    }
    cargarDatos();
  }, [placa]);

  const diffLectura = lecturaActual !== '' ? (parseNum(lecturaActual) - lecturaBase) : 0;
  const lecturaInvalida = lecturaActual !== '' && diffLectura < 0;

  // E2 · el valor se interpreta como pesos colombianos ("150.000" = ciento cincuenta mil)
  const valorPesos = parseMoneda(valor);
  const galonesNum = parseNum(galones);
  const precioGalon = galonesNum > 0 && valorPesos > 0 ? valorPesos / galonesNum : 0;

  async function obtenerGPS() {
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

  const confirmar = (titulo, mensaje) => new Promise((resolve) => {
    Alert.alert(titulo, mensaje, [
      { text: 'Corregir', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Sí, es correcto', onPress: () => resolve(true) },
    ], { cancelable: false });
  });

  const procesarGuardadoOffline = async () => {
    if (lecturaActual.trim() === '') {
      Alert.alert('Lectura Requerida', `❌ Debes ingresar la lectura actual del ${unidad === 'Hrs' ? 'horómetro' : 'odómetro'}.`); return;
    }
    const valLectura = parseNum(lecturaActual);
    if (valLectura <= 0) {
      Alert.alert('Lectura Inválida', '❌ La lectura debe ser mayor que cero.'); return;
    }
    if (valLectura < lecturaBase) {
      Alert.alert('Lectura Inválida', `❌ La lectura actual no puede ser menor a la anterior (${lecturaBase} ${unidad}).`); return;
    }
    if (galonesNum <= 0 || valorPesos <= 0) {
      Alert.alert('Datos Incompletos', '❌ Debes ingresar los galones surtidos y el valor total pagado.'); return;
    }

    // Controles de digitación: el operador confirma antes de guardar
    if (precioGalon < PRECIO_GALON_MINIMO) {
      const ok = await confirmar('Revisa el valor pagado',
        `Registraste ${formatearPesos(valorPesos)} por ${galonesNum} galones: ${formatearPesos(precioGalon)} por galón.\n\n¿El valor es correcto?`);
      if (!ok) return;
    }
    if (capacidadTanque && galonesNum > capacidadTanque * 1.05) {
      const ok = await confirmar('Revisa los galones',
        `El tanque de este equipo es de ${capacidadTanque} galones y registraste ${galonesNum}.\n\n¿Es correcto?`);
      if (!ok) return;
    }

    setIsSaving(true);
    try {
      const placaLimpia = (placa || '').trim().toUpperCase();
      const valOdo = unidad === 'Km' ? valLectura : 0;
      const valHoro = unidad === 'Hrs' ? valLectura : 0;

      const gps = await obtenerGPS();
      const usuario = await AsyncStorage.getItem('userName');
      const db = await getDb();

      // 1. Guardar en SQLite (La Cola)
      await db.runAsync(
        `INSERT INTO tanqueos_pendientes
         (uuid, usuario, placa, cantidad_galones, valor_total, proveedor, tanque_lleno,
          odometro_tanqueo, horometro_tanqueo, fecha, fecha_iso, latitud, longitud, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), ?, ?, ?, 'pending')`,
        nuevoUUID(), usuario, placaLimpia, galonesNum, valorPesos, proveedor.trim(),
        tanqueLleno ? 1 : 0, valOdo, valHoro, ahoraISO(), gps?.lat ?? null, gps?.lon ?? null
      );

      // 2. Actualizar la memoria local para el siguiente tanqueo o preoperacional
      if (unidad === 'Hrs') {
        await db.runAsync('UPDATE equipos SET ultimo_horometro = ? WHERE placa = ?', valHoro, placaLimpia);
      } else {
        await db.runAsync('UPDATE equipos SET ultimo_odometro = ? WHERE placa = ?', valOdo, placaLimpia);
      }

      // 3. Disparar subida
      enviarPendientes().catch(() => {});

      Alert.alert('✅ Éxito', `Tanqueo de ${galonesNum} gal por ${formatearPesos(valorPesos)} guardado. Se enviará automáticamente cuando recuperes conexión.`, [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      Alert.alert('Error', 'No se pudo guardar localmente.');
    } finally {
      setIsSaving(false);
    }
  };

  if (loadingInitial) {
    return (
      <View style={[styles.container, {justifyContent: 'center', alignItems: 'center'}]}>
        <ActivityIndicator size="large" color="#10b981" />
        <Text style={{color: '#94a3b8', marginTop: 10}}>Consultando equipo...</Text>
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
          <FontAwesome5 name="gas-pump" size={18} color="#f59e0b" style={{marginRight: 8}} />
          <Text style={styles.headerTitle}>Registro Combustible</Text>
        </View>
        <View style={{width: 20}} />
      </View>

      <ScrollView contentContainerStyle={styles.formContainer} keyboardShouldPersistTaps="handled">
        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Vehículo / Máquina</Text>
          <TextInput style={[styles.formInput, styles.placaInput]} value={placa} editable={false} />
        </View>

        <View style={styles.formGroup}>
          <View style={styles.rowBetween}>
            <Text style={[styles.formLabel, {marginBottom: 0}]}>Lectura Actual <Text style={{color: '#ef4444'}}>*</Text></Text>
            <View style={styles.hintLectura}>
              <Text style={styles.hintLecturaText}>Anterior: {lecturaBase} {unidad}</Text>
            </View>
          </View>
          <View style={[styles.inputGroup, lecturaInvalida ? {borderColor: '#ef4444', backgroundColor: '#fef2f2'} : {}]}>
            <View style={[styles.inputGroupAddon, lecturaInvalida ? {borderColor: '#ef4444'} : {}]}>
              <FontAwesome5 name="tachometer-alt" size={18} color={lecturaInvalida ? "#ef4444" : "#475569"} />
            </View>
            <TextInput
              style={[styles.inputGroupField, lecturaInvalida ? {backgroundColor: '#fef2f2', color: '#991b1b'} : {}]}
              keyboardType="numeric" placeholder={`Ej: ${lecturaBase + 10}`} placeholderTextColor="#94a3b8"
              value={lecturaActual} onChangeText={setLecturaActual}
            />
          </View>
        </View>

        {lecturaActual !== '' ? (
          <View style={[styles.diffCard, lecturaInvalida ? styles.diffError : styles.diffSuccess, {marginBottom: 20}]}>
            <View style={{flexDirection: 'row', alignItems: 'center'}}>
              <FontAwesome5 name={lecturaInvalida ? "times-circle" : "check-circle"} size={16} color={lecturaInvalida ? "#991b1b" : "#065f46"} style={{marginRight: 8}}/>
              <Text style={[styles.diffText, {color: lecturaInvalida ? "#991b1b" : "#065f46"}]}>
                {lecturaInvalida ? 'REVISAR LECTURA' : `Recorrido: +${diffLectura.toFixed(1)} ${unidad}`}
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Cantidad (Galones) <Text style={{color: '#ef4444'}}>*</Text></Text>
          <View style={styles.inputGroup}>
            <View style={styles.inputGroupAddon}><FontAwesome5 name="tint" size={18} color="#3b82f6" /></View>
            <TextInput style={styles.inputGroupField} keyboardType="numeric" placeholder="Ej: 15.5" placeholderTextColor="#94a3b8" value={galones} onChangeText={setGalones} />
          </View>
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Valor Pagado <Text style={{color: '#ef4444'}}>*</Text></Text>
          <View style={styles.inputGroup}>
            <View style={styles.inputGroupAddon}><FontAwesome5 name="dollar-sign" size={18} color="#475569" /></View>
            <TextInput style={styles.inputGroupField} keyboardType="numeric" placeholder="Ej: 150000" placeholderTextColor="#94a3b8" value={valor} onChangeText={setValor} />
          </View>
          {valor !== '' ? (
            <Text style={[styles.valorPreview, precioGalon > 0 && precioGalon < PRECIO_GALON_MINIMO ? { color: '#b45309' } : null]}>
              Se guardará: {formatearPesos(valorPesos)}{precioGalon > 0 ? `  •  ${formatearPesos(precioGalon)} por galón` : ''}
            </Text>
          ) : null}
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Estación de Servicio</Text>
          <TextInput style={[styles.formInput, {textTransform: 'uppercase'}]} placeholder="Ej: TERPEL 80" placeholderTextColor="#94a3b8" autoCapitalize="characters" value={proveedor} onChangeText={setProveedor} />
        </View>

        <View style={styles.toggleContainer}>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
            <FontAwesome5 name="battery-full" size={18} color="#10b981" style={{marginRight: 10}} />
            <Text style={styles.toggleLabel}>¿Llenaste a tope?</Text>
          </View>
          <Switch trackColor={{ false: "#cbd5e1", true: "#047857" }} thumbColor={tanqueLleno ? "#10b981" : "#f1f5f9"} value={tanqueLleno} onValueChange={setTanqueLleno} />
        </View>

        <TouchableOpacity style={[styles.submitBtn, isSaving && styles.submitBtnDisabled]} onPress={procesarGuardadoOffline} disabled={isSaving}>
          {isSaving ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <View style={{flexDirection: 'row', alignItems: 'center'}}>
              <FontAwesome5 name="save" size={18} color="#ffffff" style={{marginRight: 10}} />
              <Text style={styles.submitBtnText}>Guardar Tanqueo</Text>
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
  mobileHeader: { backgroundColor: '#0f172a', paddingVertical: 15, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', elevation: 4 },
  backBtn: { padding: 5 },
  headerTitleWrap: { flexDirection: 'row', alignItems: 'center' },
  headerTitle: { color: '#ffffff', fontSize: 18, fontWeight: '700' },
  formContainer: { padding: 20, paddingBottom: 50, backgroundColor: '#f8fafc', flexGrow: 1 },
  formGroup: { marginBottom: 20 },
  formLabel: { fontSize: 13, color: '#475569', fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' },
  formInput: { width: '100%', padding: 15, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, fontSize: 18, backgroundColor: '#ffffff', color: '#0f172a' },
  placaInput: { fontSize: 28, fontWeight: '900', textAlign: 'center', letterSpacing: 2, color: '#0f172a', backgroundColor: '#f1f5f9' },
  inputGroup: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, overflow: 'hidden' },
  inputGroupAddon: { padding: 15, backgroundColor: '#f1f5f9', borderRightWidth: 1, borderColor: '#cbd5e1', width: 55, alignItems: 'center', justifyContent: 'center' },
  inputGroupField: { flex: 1, fontSize: 18, padding: 15, color: '#0f172a', backgroundColor: '#ffffff' },
  valorPreview: { marginTop: 6, fontSize: 13, fontWeight: '800', color: '#065f46' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 8 },
  hintLectura: { backgroundColor: '#e2e8f0', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  hintLecturaText: { fontSize: 12, fontWeight: '800', color: '#64748b' },
  diffCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 12, borderRadius: 8 },
  diffText: { fontWeight: '900', fontSize: 14 },
  diffSuccess: { backgroundColor: '#dcfce7', borderWidth: 1, borderColor: '#34d399' },
  diffError: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#f87171' },
  toggleContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#ffffff', paddingVertical: 18, paddingHorizontal: 15, borderRadius: 8, borderWidth: 1, borderColor: '#cbd5e1', marginBottom: 20 },
  toggleLabel: { fontWeight: '800', color: '#1e293b', fontSize: 16 },
  submitBtn: { backgroundColor: '#10b981', width: '100%', padding: 18, borderRadius: 8, elevation: 3, marginTop: 10, justifyContent: 'center', alignItems: 'center' },
  submitBtnDisabled: { backgroundColor: '#94a3b8', elevation: 0 },
  submitBtnText: { color: '#ffffff', fontSize: 19, fontWeight: '900' }
});
