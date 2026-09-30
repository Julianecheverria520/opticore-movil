import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, Switch, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { leerToken } from '../sesion';
import * as Location from 'expo-location';

import { API_URL } from '../config';
import { getDb, nuevoUUID, ahoraISO, parseNum, esMaquinaria } from '../database/db';
import { enviarPendientes } from '../database/syncUp';
import { fetchConTimeout } from '../red';
import { parseDecimal, parseMoneda, parseLectura, fmtPesos, fmtNum, advertenciasTanqueo } from '../combustibleNumeros';
import { datosValidacion } from '../combustible';

// Números y avisos iguales a la PWA (combustibleNumeros.js): "Se guardará: X" debajo de cada campo,
// precio por galón con el rango de la empresa y confirmaciones en el mismo orden (lectura ambigua →
// lectura menor que la anterior → ¿tanqueo nuevo? → precio y capacidad). Nada bloquea: el servidor
// vuelve a validar y marca REVISAR. Una lectura menor tampoco bloquea (odómetro cambiado, lectura
// anterior inflada por error): se confirma, y el contador del equipo en el celular no baja.

const COLOR_AVISO = { ok: '#065f46', warn: '#b45309', err: '#b91c1c' };
const SIN_VALIDACION = { rango: null, capacidad: null, margen: 5, fotoModo: 'OPCIONAL', hoy: [] };

function Aviso({ texto, tipo }) {
  if (!texto) return null;
  return <Text style={[styles.valorPreview, { color: COLOR_AVISO[tipo] || COLOR_AVISO.ok }]}>{texto}</Text>;
}

/**
 * Alert con botones nombrados → Promise con el `valor` del botón elegido.
 * En Android el ÚLTIMO botón es el principal (derecha); con tres, el primero queda a la izquierda.
 */
function preguntar(titulo, lineas, botones) {
  return new Promise((resolve) => {
    Alert.alert(titulo, lineas.join('\n\n'),
      botones.map((b) => ({ text: b.texto, style: b.estilo, onPress: () => resolve(b.valor) })),
      { cancelable: false });
  });
}

export default function CombustibleScreen({ route, navigation }) {
  const { placa } = route.params;

  const [lecturaBase, setLecturaBase] = useState(0);
  const [unidad, setUnidad] = useState('Km');
  const [validacion, setValidacion] = useState(SIN_VALIDACION);
  const [loadingInitial, setLoadingInitial] = useState(true);

  const [lecturaActual, setLecturaActual] = useState('');
  const [galones, setGalones] = useState('');
  const [valor, setValor] = useState('');
  const [proveedor, setProveedor] = useState('');
  const [tanqueLleno, setTanqueLleno] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  // Lectura ambigua ya elegida por el operador para ESE texto ("125.430" → 125430 o 125,43)
  const [lecturaConfirmada, setLecturaConfirmada] = useState({ texto: null, valor: null });

  const uuidTanqueo = useRef(nuevoUUID()); // uno por formulario: el servidor no duplica un reenvío
  const procesando = useRef(false);        // tocar Guardar dos veces no abre dos flujos

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
        }
        setValidacion(await datosValidacion(db, placaLimpia));
      } catch (e) {
        console.error("Error offline:", e);
      } finally {
        setLoadingInitial(false);
      }

      // 2. ACTUALIZACIÓN ONLINE. R4 · máximo 5 s con señal débil.
      try {
        const token = await leerToken();
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

  // ── Lo que se guardará, en vivo (igual que la PWA)
  const leerLectura = (texto) => (texto.trim() && texto.trim() === lecturaConfirmada.texto
    ? { valor: lecturaConfirmada.valor, alternativa: null, ambigua: false }
    : parseLectura(texto, lecturaBase));
  const lec = leerLectura(lecturaActual);
  const lecturaInvalida = lecturaActual.trim() !== '' && (Number.isNaN(lec.valor) || lec.valor < lecturaBase);
  let avisoLectura = null;
  if (lecturaActual.trim() === '') avisoLectura = null;
  else if (Number.isNaN(lec.valor)) avisoLectura = { texto: 'No es un número válido', tipo: 'err' };
  else if (lec.ambigua) avisoLectura = { texto: `Se guardará: ${fmtNum(lec.valor)} ${unidad} (¿o ${fmtNum(lec.alternativa)}? se confirmará al guardar)`, tipo: 'warn' };
  else avisoLectura = { texto: `Se guardará: ${fmtNum(lec.valor)} ${unidad}`, tipo: lec.valor < lecturaBase ? 'err' : 'ok' };

  const galonesNum = parseDecimal(galones);
  const valorPesos = parseMoneda(valor);
  let avisoGalones = null;
  if (galones.trim()) avisoGalones = Number.isNaN(galonesNum) ? { texto: 'No es un número válido', tipo: 'err' } : { texto: `Se guardará: ${fmtNum(galonesNum)} gal`, tipo: 'ok' };
  let avisoValor = null;
  if (valor.trim()) avisoValor = Number.isNaN(valorPesos) ? { texto: 'No es un valor válido', tipo: 'err' } : { texto: `Se guardará: ${fmtPesos(valorPesos)}`, tipo: 'ok' };

  let avisoPrecio = null;
  if (galonesNum > 0 && valorPesos > 0) {
    const { precio, avisos } = advertenciasTanqueo(galonesNum, valorPesos, validacion.rango, validacion.capacidad, validacion.margen);
    const rangoTxt = validacion.rango ? ` · esperado ${fmtPesos(validacion.rango.min)}–${fmtPesos(validacion.rango.max)}` : '';
    avisoPrecio = { texto: `${fmtPesos(precio)} por galón${rangoTxt}`, tipo: avisos.length ? 'warn' : 'ok' };
  }

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

  const procesarGuardadoOffline = async () => {
    if (procesando.current) return;
    const nombreLectura = unidad === 'Hrs' ? 'horómetro' : 'odómetro';
    if (lecturaActual.trim() === '') {
      Alert.alert('Lectura Requerida', `❌ Debes ingresar la lectura actual del ${nombreLectura}.`); return;
    }
    const lecActual = leerLectura(lecturaActual);
    if (!(lecActual.valor > 0)) {
      Alert.alert('Lectura Inválida', `❌ La lectura del ${nombreLectura} debe ser un número mayor que cero.`); return;
    }
    if (!(galonesNum > 0) || !(valorPesos > 0)) {
      Alert.alert('Datos Incompletos', '❌ Debes ingresar los galones surtidos y el valor total pagado.'); return;
    }

    procesando.current = true;
    try {
      // 1. Lectura ambigua ("125.430"): que el operador elija
      let lectura = lecActual.valor;
      if (lecActual.ambigua) {
        const elegida = await preguntar('¿Cuál es la lectura?', [
          `Escribiste "${lecturaActual.trim()}". Puede leerse de dos formas:`,
          `Lectura anterior: ${fmtNum(lecturaBase)} ${unidad}.`,
        ], [
          { texto: 'Corregir', valor: null, estilo: 'cancel' },
          { texto: `${fmtNum(lecActual.alternativa)} ${unidad}`, valor: lecActual.alternativa },
          { texto: `${fmtNum(lecActual.valor)} ${unidad}`, valor: lecActual.valor },
        ]);
        if (elegida === null) return;
        lectura = elegida;
        setLecturaConfirmada({ texto: lecturaActual.trim(), valor: elegida });
      }
      let confirmada = false;
      if (lectura < lecturaBase) {
        const correcta = await preguntar('Lectura menor que la anterior', [
          `La lectura (${fmtNum(lectura)} ${unidad}) es menor que la anterior (${fmtNum(lecturaBase)} ${unidad}). ¿Es correcta?`,
        ], [
          { texto: 'Corregir', valor: false, estilo: 'cancel' },
          { texto: 'Sí, es correcta', valor: true },
        ]);
        if (!correcta) return;
        confirmada = true;
      }

      // 2. ¿Ya hay un tanqueo de este equipo hoy? (el servidor lo marcará como posible duplicado)
      const v = validacion;
      if (v.hoy.length) {
        const lista = v.hoy.map((t) => `a las ${t.hora} (${fmtNum(t.galones)} gal)`).join(', ');
        const nuevo = await preguntar('¿Es un tanqueo nuevo?', [
          `Ya hay ${v.hoy.length === 1 ? 'un tanqueo' : `${v.hoy.length} tanqueos`} de este equipo hoy ${lista}.`,
          'Si es el mismo, no lo registres otra vez. Si es uno nuevo, el administrador lo revisará.',
        ], [
          { texto: 'Cancelar', valor: false, estilo: 'cancel' },
          { texto: 'Sí, es uno nuevo', valor: true },
        ]);
        if (!nuevo) return;
      }

      // 3. Precio/galón y capacidad: advertir y pedir confirmación (no bloquea)
      const { avisos } = advertenciasTanqueo(galonesNum, valorPesos, v.rango, v.capacidad, v.margen);
      if (avisos.length) {
        const ok = await preguntar('Revisa los datos del tanqueo', [
          `Galones: ${fmtNum(galonesNum)} · Valor: ${fmtPesos(valorPesos)}`,
          ...avisos,
          '¿Los datos son correctos?',
        ], [
          { texto: 'Corregir', valor: false, estilo: 'cancel' },
          { texto: 'Sí, son correctos', valor: true },
        ]);
        if (!ok) return;
        confirmada = true;
      }

      setIsSaving(true);
      try {
        const placaLimpia = (placa || '').trim().toUpperCase();
        // La lectura va solo al contador del equipo (igual que la PWA)
        const valOdo = unidad === 'Km' ? lectura : 0;
        const valHoro = unidad === 'Hrs' ? lectura : 0;

        const gps = await obtenerGPS();
        const usuario = await AsyncStorage.getItem('userName');
        const db = await getDb();

        // 1. Guardar en SQLite (La Cola). uuid = uuid_cliente: un reenvío no duplica en el servidor.
        await db.runAsync(
          `INSERT INTO tanqueos_pendientes
           (uuid, usuario, placa, cantidad_galones, valor_total, proveedor, tanque_lleno,
            odometro_tanqueo, horometro_tanqueo, fecha, fecha_iso, latitud, longitud, advertencia_confirmada, sync_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), ?, ?, ?, ?, 'pending')`,
          uuidTanqueo.current, usuario, placaLimpia, galonesNum, valorPesos, proveedor.trim(),
          tanqueLleno ? 1 : 0, valOdo, valHoro, ahoraISO(), gps?.lat ?? null, gps?.lon ?? null, confirmada ? 1 : 0
        );

        // 2. Actualizar la memoria local para el siguiente tanqueo o preoperacional. Solo sube, igual
        //    que el servidor: una lectura menor confirmada no baja el contador (lo decide el admin).
        if (unidad === 'Hrs') {
          await db.runAsync('UPDATE equipos SET ultimo_horometro = MAX(COALESCE(ultimo_horometro, 0), ?) WHERE placa = ?', valHoro, placaLimpia);
        } else {
          await db.runAsync('UPDATE equipos SET ultimo_odometro = MAX(COALESCE(ultimo_odometro, 0), ?) WHERE placa = ?', valOdo, placaLimpia);
        }

        // 3. Disparar subida
        enviarPendientes().catch(() => {});

        Alert.alert('✅ Éxito', `Tanqueo de ${fmtNum(galonesNum)} gal por ${fmtPesos(valorPesos)} guardado. Se enviará automáticamente cuando recuperes conexión.`, [{ text: 'OK', onPress: () => navigation.goBack() }]);
      } catch (e) {
        Alert.alert('Error', 'No se pudo guardar localmente.');
      } finally {
        setIsSaving(false);
      }
    } finally {
      procesando.current = false;
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
              <Text style={styles.hintLecturaText}>Anterior: {fmtNum(lecturaBase, 1)} {unidad}</Text>
            </View>
          </View>
          <View style={[styles.inputGroup, lecturaInvalida ? {borderColor: '#ef4444', backgroundColor: '#fef2f2'} : {}]}>
            <View style={[styles.inputGroupAddon, lecturaInvalida ? {borderColor: '#ef4444'} : {}]}>
              <FontAwesome5 name="tachometer-alt" size={18} color={lecturaInvalida ? "#ef4444" : "#475569"} />
            </View>
            <TextInput
              style={[styles.inputGroupField, lecturaInvalida ? {backgroundColor: '#fef2f2', color: '#991b1b'} : {}]}
              keyboardType="decimal-pad" placeholder={`Ej: ${Math.round(lecturaBase) + 10}`} placeholderTextColor="#94a3b8"
              value={lecturaActual} onChangeText={setLecturaActual}
            />
          </View>
          <Aviso {...(avisoLectura || {})} />
        </View>

        {lecturaActual.trim() !== '' && !Number.isNaN(lec.valor) ? (
          <View style={[styles.diffCard, lecturaInvalida ? styles.diffError : styles.diffSuccess, {marginBottom: 20}]}>
            <View style={{flexDirection: 'row', alignItems: 'center'}}>
              <FontAwesome5 name={lecturaInvalida ? "times-circle" : "check-circle"} size={16} color={lecturaInvalida ? "#991b1b" : "#065f46"} style={{marginRight: 8}}/>
              <Text style={[styles.diffText, {color: lecturaInvalida ? "#991b1b" : "#065f46"}]}>
                {lecturaInvalida ? 'REVISAR LECTURA' : `Recorrido: +${fmtNum(lec.valor - lecturaBase, 1)} ${unidad}`}
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Cantidad (Galones) <Text style={{color: '#ef4444'}}>*</Text></Text>
          <View style={styles.inputGroup}>
            <View style={styles.inputGroupAddon}><FontAwesome5 name="tint" size={18} color="#3b82f6" /></View>
            <TextInput style={styles.inputGroupField} keyboardType="decimal-pad" placeholder="Ej: 15,5" placeholderTextColor="#94a3b8" value={galones} onChangeText={setGalones} />
          </View>
          <Aviso {...(avisoGalones || {})} />
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.formLabel}>Valor Pagado <Text style={{color: '#ef4444'}}>*</Text></Text>
          <View style={styles.inputGroup}>
            <View style={styles.inputGroupAddon}><FontAwesome5 name="dollar-sign" size={18} color="#475569" /></View>
            <TextInput style={styles.inputGroupField} keyboardType="number-pad" placeholder="Ej: 150000" placeholderTextColor="#94a3b8" value={valor} onChangeText={setValor} />
          </View>
          <Aviso {...(avisoValor || {})} />
          {avisoPrecio ? (
            <View style={[styles.precioCard, avisoPrecio.tipo === 'warn' ? styles.precioWarn : styles.precioOk]}>
              <FontAwesome5 name={avisoPrecio.tipo === 'warn' ? 'exclamation-triangle' : 'check-circle'} size={14} color={COLOR_AVISO[avisoPrecio.tipo]} style={{marginRight: 8}} />
              <Text style={[styles.precioText, { color: COLOR_AVISO[avisoPrecio.tipo] }]}>{avisoPrecio.texto}</Text>
            </View>
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
  precioCard: { flexDirection: 'row', alignItems: 'center', marginTop: 10, padding: 10, borderRadius: 8, borderWidth: 1 },
  precioOk: { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0' },
  precioWarn: { backgroundColor: '#fffbeb', borderColor: '#fcd34d' },
  precioText: { flex: 1, fontSize: 14, fontWeight: '900' },
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
