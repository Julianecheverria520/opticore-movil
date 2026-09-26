import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ScrollView, Switch, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { leerToken } from '../sesion';
import * as Location from 'expo-location';

import { API_URL } from '../config';
import { getDb, nuevoUUID, ahoraISO, parseNum, esMaquinaria } from '../database/db';
import { enviarPendientes } from '../database/syncUp';
import { fetchConTimeout } from '../red';
import {
  RESUELTA, CONTINUA, textoDias, armarObservaciones,
  leerFallasAbiertas, reemplazarFallasPlaca, actualizarFallasLocales,
} from '../fallas';

export default function PreoperacionalScreen({ route, navigation }) {
  const { placa } = route.params;

  const [pasoActual, setPasoActual] = useState(1);
  const [estadoEquipo, setEstadoEquipo] = useState('ACTIVO');

  const [usaHoras, setUsaHoras] = useState(false);
  const [lecturaAnt, setLecturaAnt] = useState('0');
  const [lecturaNueva, setLecturaNueva] = useState('');

  const [preguntasAgrupadas, setPreguntasAgrupadas] = useState({});
  const [categorias, setCategorias] = useState([]);

  const [respuestas, setRespuestas] = useState({});
  const [obsFallas, setObsFallas] = useState({});
  const [observacionFinal, setObservacionFinal] = useState('');
  const [guardando, setGuardando] = useState(false);

  // Autogestión de fallas (src/fallas.js): fallas abiertas de esta placa por pregunta_id,
  // y lo que responde el conductor para cada una (RESUELTA / CONTINUA + observación).
  const [autogestion, setAutogestion] = useState(false);
  const [fallasPrevias, setFallasPrevias] = useState({});
  const [seguimiento, setSeguimiento] = useState({});
  const [obsSeguimiento, setObsSeguimiento] = useState({});

  // Como en la PWA, la observación de "AÚN FALLA" arranca con la del reporte anterior
  const mostrarFallas = (fallas) => {
    setFallasPrevias(fallas);
    setObsSeguimiento((prev) => {
      const n = { ...prev };
      for (const f of Object.values(fallas)) if (n[f.pregunta_id] == null) n[f.pregunta_id] = f.ultima_obs || '';
      return n;
    });
  };

  useEffect(() => {
    async function cargarDatos() {
      const placaLimpia = (placa || '').trim().toUpperCase();

      // 1. CARGA OFFLINE
      try {
        const db = await getDb();
        const equipoLocal = await db.getFirstAsync('SELECT * FROM equipos WHERE placa = ?', placaLimpia);

        if (equipoLocal) {
          const esMaq = esMaquinaria(equipoLocal);
          setUsaHoras(esMaq);
          setLecturaAnt(String(esMaq ? (equipoLocal.ultimo_horometro || 0) : (equipoLocal.ultimo_odometro || 0)));
        } else {
          setLecturaAnt('0');
        }

        // R5 · Checklist del tipo de equipo + preguntas generales (tipo NULL), igual que
        // /maestros/preguntas/plantilla/{placa} en el servidor.
        let todasLasPreguntas = await db.getAllAsync(
          `SELECT * FROM preguntas
            WHERE tipo_activo_id IS NULL OR tipo_activo_id = 0 OR tipo_activo_id = ?
            ORDER BY categoria, id`,
          equipoLocal?.tipo_activo_id ?? -1
        );
        // Si el equipo no tiene tipo asignado y la empresa no tiene preguntas generales,
        // se muestran todas para no dejar al operador sin formulario.
        if (todasLasPreguntas.length === 0) {
          todasLasPreguntas = await db.getAllAsync('SELECT * FROM preguntas ORDER BY categoria, id');
        }

        const grupos = {};
        const respuestasIniciales = {};

        todasLasPreguntas.forEach(p => {
          if (!grupos[p.categoria]) grupos[p.categoria] = [];
          grupos[p.categoria].push(p);
          respuestasIniciales[p.id] = true;
        });

        setPreguntasAgrupadas(grupos);
        setCategorias(Object.keys(grupos));
        setRespuestas(respuestasIniciales);

        // Solo con un servidor que ya manda fallas en /movil/maestros (si no, la clave no existe)
        const usaAuto = (await AsyncStorage.getItem('usaAutogestionFallas')) === '1';
        setAutogestion(usaAuto);
        if (usaAuto) mostrarFallas(await leerFallasAbiertas(db, placaLimpia));
      } catch (e) {
        console.error("Error offline:", e);
      }

      // 2. ACTUALIZACIÓN ONLINE (si hay red). R4 · máximo 5 s: con señal débil no se queda esperando.
      try {
        const token = await leerToken();
        const resVal = await fetchConTimeout(`${API_URL}/maestros/equipos/preoperacional/validar/${encodeURIComponent(placaLimpia)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }, 5000);

        if (resVal.ok) {
          const dataVal = await resVal.json();
          const usaHoro = !!dataVal.tiene_horometro;
          setUsaHoras(usaHoro);
          // Si el servidor manda un valor menor al que registramos offline hace unas horas, ignorarlo
          setLecturaAnt(prev => {
             const valLocal = parseNum(prev);
             const valRemoto = parseNum(usaHoro ? dataVal.ultimo_horometro : dataVal.ultimo_odometro);
             return String(Math.max(valLocal, valRemoto));
          });

          // Con señal, /validar trae las fallas al minuto (p. ej. un preoperacional recién hecho en la
          // PWA). Se usan solo si el servidor es nuevo (pregunta_id en cada alerta y maestros con la
          // clave) y si esta placa no tiene preoperacionales sin enviar (esos van por delante).
          const alertas = dataVal.alertas_pendientes;
          const servidorNuevo = typeof dataVal.usa_autogestion_fallas === 'boolean'
            && Array.isArray(alertas) && alertas.every((a) => a.pregunta_id != null)
            && (await AsyncStorage.getItem('usaAutogestionFallas')) !== null;
          if (servidorNuevo) {
            const db = await getDb();
            const pend = await db.getFirstAsync(
              "SELECT COUNT(*) AS n FROM reportes_pendientes WHERE equipo_id = ? AND sync_status != 'synced'", placaLimpia
            );
            if (!pend?.n) {
              await AsyncStorage.setItem('usaAutogestionFallas', dataVal.usa_autogestion_fallas ? '1' : '0');
              await reemplazarFallasPlaca(db, placaLimpia, dataVal.usa_autogestion_fallas ? alertas : []);
              setAutogestion(dataVal.usa_autogestion_fallas);
              mostrarFallas(dataVal.usa_autogestion_fallas ? await leerFallasAbiertas(db, placaLimpia) : {});
            }
          }
        }
      } catch (error) {
        console.log("Sin red. Usando histórico local.");
      }
    }

    cargarDatos();
  }, [placa]);

  const totalPasos = categorias.length > 0 ? categorias.length + 2 : 2;
  const unidad = usaHoras ? 'Hrs' : 'Km';

  const diffLectura = lecturaNueva !== '' ? (parseNum(lecturaNueva) - parseNum(lecturaAnt)) : 0;
  const lecturaInvalida = lecturaNueva !== '' && diffLectura < 0;

  const togglePregunta = (id, valor) => {
    setRespuestas(prev => ({ ...prev, [id]: valor }));
    if (valor) setObsFallas(prev => ({ ...prev, [id]: '' }));
  };

  const actualizarObsFalla = (id, texto) => setObsFallas(prev => ({ ...prev, [id]: texto }));

  const cambiarPaso = (direccion) => {
    if (pasoActual === 1 && direccion === 1) {
      if (lecturaNueva.trim() === '') {
        Alert.alert('Lectura Requerida', `❌ Debe ingresar la lectura actual del ${usaHoras ? 'horómetro' : 'odómetro'}.`);
        return;
      }
      if (lecturaInvalida) {
        Alert.alert('Lectura Inválida', `❌ La lectura actual no puede ser menor a la anterior (${lecturaAnt} ${unidad}).`);
        return;
      }
    }
    setPasoActual(prev => prev + direccion);
  };

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

  const guardarReporte = async () => {
    if (guardando) return;

    if (categorias.length === 0) {
      Alert.alert('Sin formulario', 'No hay preguntas descargadas. Conéctate a internet y sincroniza antes de inspeccionar.');
      return;
    }

    let faltanObservaciones = false;
    let fallaCritica = false;
    const sinResponder = [];
    const nuevas = [];
    const seg = [];
    const respuestasEnvio = { ...respuestas };

    for (const cat of categorias) {
      for (const p of (preguntasAgrupadas[cat] || [])) {
        const falla = autogestion ? fallasPrevias[p.id] : null;
        if (falla) {
          // Falla anterior: "YA SE ARREGLÓ" = bien; "AÚN FALLA" = sigue abierta (obs. obligatoria).
          // Solo una pregunta CRÍTICA manda a TALLER (misma regla que la PWA y el servidor).
          const sel = seguimiento[p.id];
          const obs = (obsSeguimiento[p.id] || '').trim();
          if (!sel || (sel === CONTINUA && !obs)) { sinResponder.push(p.pregunta); continue; }
          respuestasEnvio[p.id] = sel === RESUELTA;
          if (sel === CONTINUA && p.es_critica === 1) fallaCritica = true;
          seg.push({ pregunta_id: p.id, pregunta: p.pregunta, resultado: sel, obs: sel === CONTINUA ? obs : '' });
        } else if (!respuestas[p.id]) {
          if (p.es_critica === 1) fallaCritica = true;
          const txt = (obsFallas[p.id] || '').trim();
          if (!txt) faltanObservaciones = true;
          nuevas.push({ pregunta_id: p.id, pregunta: p.pregunta, categoria: cat, es_critica: p.es_critica === 1, obs: txt });
        }
      }
    }

    if (sinResponder.length) {
      Alert.alert(
        'Fallas anteriores sin responder',
        `❌ Marque "YA SE ARREGLÓ" o "AÚN FALLA" (con observación) en:\n\n• ${sinResponder.join('\n• ')}`
      );
      return;
    }
    if (faltanObservaciones) {
      Alert.alert('Inspección Incompleta', '❌ Por favor, describa el motivo de la falla en los campos resaltados en rojo.');
      return;
    }

    // Mismo formato que la PWA (FALLA [..] / Auditoría [..]) para que la web lea las observaciones
    const observaciones = armarObservaciones({ general: observacionFinal, nuevas, seguimiento: seg });

    setGuardando(true);
    try {
      const estadoFinal = fallaCritica ? 'TALLER' : estadoEquipo;
      const lectura = parseNum(lecturaNueva);
      const anterior = parseNum(lecturaAnt);
      const valOdo = usaHoras ? 0 : lectura;
      const valHoro = usaHoras ? lectura : 0;
      const placaLimpia = (placa || '').trim().toUpperCase();

      const gps = await obtenerGPS();
      const usuario = await AsyncStorage.getItem('userName');
      const db = await getDb();

      // 1. Guardar en SQLite (La Cola de envíos pendientes)
      await db.runAsync(
        `INSERT INTO reportes_pendientes
           (uuid, usuario, equipo_id, usuario_id, odometro, horometro, odometro_anterior, horometro_anterior,
            estado_equipo, fecha, fecha_iso, respuestas_json, observaciones, latitud, longitud, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?, ?, ?, ?, ?, 'pending')`,
        nuevoUUID(), usuario, placaLimpia, 0, valOdo, valHoro,
        usaHoras ? 0 : anterior, usaHoras ? anterior : 0,
        estadoFinal, ahoraISO(), JSON.stringify(respuestasEnvio), observaciones,
        gps?.lat ?? null, gps?.lon ?? null
      );

      // 2. ACTUALIZAR EQUIPO LOCAL PARA QUE EL PRÓXIMO REPORTE DEL DÍA (OFFLINE) NO ESTÉ EN CERO
      if (usaHoras) {
        await db.runAsync('UPDATE equipos SET ultimo_horometro = ?, estado = ? WHERE placa = ?', valHoro, estadoFinal, placaLimpia);
      } else {
        await db.runAsync('UPDATE equipos SET ultimo_odometro = ?, estado = ? WHERE placa = ?', valOdo, estadoFinal, placaLimpia);
      }

      // 3. Fallas locales al día: un segundo preoperacional sin señal ya ve estas respuestas
      if (autogestion) await actualizarFallasLocales(db, placaLimpia, { seguimiento: seg, nuevas });

      // 4. Disparar subida en segundo plano (si no hay red simplemente se omite)
      enviarPendientes().catch(() => {});

      Alert.alert(
        '✅ Reporte Guardado',
        fallaCritica ? '🚨 ATENCIÓN: Equipo enviado a TALLER por falla crítica.' : 'Inspección guardada. Se enviará automáticamente cuando recuperes conexión.',
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'No se pudo guardar localmente.');
    } finally {
      setGuardando(false);
    }
  };

  const progreso = (pasoActual / totalPasos) * 100;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.mobileHeader}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <FontAwesome5 name="arrow-left" size={20} color="#ffffff" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <FontAwesome5 name="clipboard-check" size={18} color="#60a5fa" style={{marginRight: 8}} />
          <Text style={styles.headerTitle}>Inspección Equipo</Text>
        </View>
        <View style={{width: 20}} />
      </View>

      <View style={styles.headerInfoBar}>
        <View><Text style={styles.infoLabel}>PLACA</Text><Text style={styles.infoValue}>{placa}</Text></View>
        <View style={{alignItems: 'flex-end'}}><Text style={styles.infoLabel}>PASO</Text><Text style={styles.infoValue}>{pasoActual} / {totalPasos}</Text></View>
      </View>

      <View style={styles.progressContainer}>
        <View style={[styles.progressBar, { width: `${progreso}%` }]} />
      </View>

      <ScrollView style={styles.scrollArea} contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">

        {pasoActual === 1 ? (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <FontAwesome5 name="tachometer-alt" size={18} color="#475569" style={{marginRight: 10}}/>
              <Text style={styles.cardTitle}>Estado y Lecturas</Text>
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.formLabel}>{unidad} Anterior</Text>
              <TextInput style={[styles.formInput, styles.inputDisabled]} value={lecturaAnt} editable={false} />
            </View>

            <View style={styles.formGroup}>
              <Text style={styles.formLabel}>{unidad} Actual <Text style={{color: '#ef4444'}}>*</Text></Text>
              <TextInput
                style={[styles.formInput, lecturaInvalida ? {borderColor: '#ef4444', backgroundColor: '#fef2f2'} : {}]}
                keyboardType="numeric"
                placeholder={`Ej: ${lecturaAnt}`}
                placeholderTextColor="#94a3b8"
                value={lecturaNueva}
                onChangeText={setLecturaNueva}
              />
            </View>

            {lecturaNueva !== '' ? (
              <View style={[styles.diffCard, lecturaInvalida ? styles.diffError : styles.diffSuccess]}>
                <View style={{flexDirection: 'row', alignItems: 'center'}}>
                  <FontAwesome5 name={lecturaInvalida ? "times-circle" : "check-circle"} size={16} color={lecturaInvalida ? "#991b1b" : "#065f46"} style={{marginRight: 8}}/>
                  <Text style={[styles.diffText, {color: lecturaInvalida ? "#991b1b" : "#065f46"}]}>
                    {lecturaInvalida ? 'REVISAR LECTURA' : `Recorrido: +${diffLectura.toFixed(1)} ${unidad}`}
                  </Text>
                </View>
              </View>
            ) : null}
          </View>
        ) : null}

        {pasoActual > 1 && pasoActual < totalPasos ? (
          <View style={styles.card}>
            <View style={styles.cardHeader}><FontAwesome5 name="list-ul" size={18} color="#475569" style={{marginRight: 10}}/><Text style={styles.cardTitle}>{categorias[pasoActual - 2]}</Text></View>

            {(preguntasAgrupadas[categorias[pasoActual - 2]] || []).map(p => {
              const falla = autogestion ? fallasPrevias[p.id] : null;
              if (falla) {
                const sel = seguimiento[p.id];
                return (
                  <View key={p.id} style={[styles.fallaPrevia, sel === RESUELTA ? styles.fallaResuelta : null, sel === CONTINUA ? styles.fallaContinua : null]}>
                    <View style={styles.preguntaRow}>
                      <View style={{ flex: 1, paddingRight: 10 }}>
                        <Text style={[styles.preguntaTexto, { color: '#b45309', fontWeight: '800' }]}>{p.pregunta}</Text>
                        {p.es_critica === 1 ? <Text style={styles.criticoText}>CRÍTICO</Text> : null}
                      </View>
                      <View style={styles.badgeFalla}>
                        <Text style={styles.badgeFallaTxt}>⚠️ FALLA PREVIA</Text>
                        <Text style={styles.badgeFallaTxt}>({textoDias(falla)})</Text>
                      </View>
                    </View>
                    <Text style={styles.obsAnterior}>
                      <Text style={{ fontWeight: '800' }}>Reporte anterior: </Text>{falla.ultima_obs || 'Sin descripción'}
                    </Text>
                    <View style={styles.filaSeguimiento}>
                      <TouchableOpacity
                        style={[styles.btnSeg, { backgroundColor: '#10b981' }, sel === RESUELTA ? styles.btnSegActivo : styles.btnSegInactivo]}
                        onPress={() => setSeguimiento(prev => ({ ...prev, [p.id]: RESUELTA }))}
                      >
                        <FontAwesome5 name="check-circle" size={13} color="#fff" />
                        <Text style={styles.btnSegTxt}> YA SE ARREGLÓ</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.btnSeg, { backgroundColor: '#ef4444' }, sel === CONTINUA ? styles.btnSegActivo : styles.btnSegInactivo]}
                        onPress={() => setSeguimiento(prev => ({ ...prev, [p.id]: CONTINUA }))}
                      >
                        <FontAwesome5 name="times-circle" size={13} color="#fff" />
                        <Text style={styles.btnSegTxt}> AÚN FALLA</Text>
                      </TouchableOpacity>
                    </View>
                    {sel === CONTINUA ? (
                      <TextInput
                        style={[styles.inputFalla, { minHeight: 60, textAlignVertical: 'top' }]}
                        placeholder="⚠️ Obligatorio: ¿cómo sigue la falla?"
                        placeholderTextColor="#fca5a5"
                        multiline
                        value={obsSeguimiento[p.id] ?? ''}
                        onChangeText={(txt) => setObsSeguimiento(prev => ({ ...prev, [p.id]: txt }))}
                      />
                    ) : null}
                  </View>
                );
              }
              const estaOk = respuestas[p.id];
              return (
                <View key={p.id} style={styles.preguntaItem}>
                  <View style={styles.preguntaRow}>
                    <View style={{ flex: 1, paddingRight: 15 }}>
                      <Text style={styles.preguntaTexto}>{p.pregunta}</Text>
                      {p.es_critica === 1 ? <Text style={styles.criticoText}>CRÍTICO</Text> : null}
                    </View>
                    <Switch trackColor={{ false: "#fca5a5", true: "#86efac" }} thumbColor={estaOk ? "#16a34a" : "#ef4444"} value={estaOk} onValueChange={(val) => togglePregunta(p.id, val)} />
                  </View>
                  {!estaOk ? (
                    <TextInput
                      style={styles.inputFalla}
                      placeholder="⚠️ Obligatorio: Describa la falla..."
                      placeholderTextColor="#fca5a5"
                      value={obsFallas[p.id] || ''}
                      onChangeText={(txt) => actualizarObsFalla(p.id, txt)}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        {pasoActual === totalPasos ? (
          <View style={styles.card}>
            <View style={styles.cardHeader}><FontAwesome5 name="comment-dots" size={18} color="#475569" style={{marginRight: 10}}/><Text style={styles.cardTitle}>Observaciones Finales</Text></View>
            <TextInput style={[styles.formInput, { height: 120, textAlignVertical: 'top' }]} placeholder="Escribe aquí si tienes algún comentario adicional..." placeholderTextColor="#94a3b8" multiline value={observacionFinal} onChangeText={setObservacionFinal} />
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        {pasoActual > 1 ? (
          <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={() => cambiarPaso(-1)} disabled={guardando}>
            <Text style={styles.btnTextSec}>Atrás</Text>
          </TouchableOpacity>
        ) : null}

        {pasoActual < totalPasos ? (
          <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={() => cambiarPaso(1)} disabled={guardando}>
            <Text style={styles.btnText}>Siguiente </Text>
            <FontAwesome5 name="arrow-right" size={12} color="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.btn, styles.btnSuccess]} onPress={guardarReporte} disabled={guardando}>
            <FontAwesome5 name="save" size={16} color="#fff" style={{marginRight: 8}} />
            <Text style={styles.btnText}>{guardando ? 'Guardando...' : 'Guardar Reporte'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0f172a' },
  mobileHeader: { backgroundColor: '#0f172a', paddingVertical: 15, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backBtn: { padding: 5 },
  headerTitleWrap: { flexDirection: 'row', alignItems: 'center' },
  headerTitle: { color: '#ffffff', fontSize: 18, fontWeight: '700' },
  headerInfoBar: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#1e293b', padding: 15 },
  infoLabel: { color: '#94a3b8', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  infoValue: { color: '#ffffff', fontSize: 18, fontWeight: '900' },
  progressContainer: { height: 6, backgroundColor: '#cbd5e1', width: '100%' },
  progressBar: { height: '100%', backgroundColor: '#3b82f6' },
  scrollArea: { flex: 1, backgroundColor: '#f8fafc' },
  card: { backgroundColor: '#ffffff', borderRadius: 12, padding: 20, elevation: 2, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, borderWidth: 1, borderColor: '#e2e8f0', marginBottom: 20 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#f1f5f9', paddingBottom: 12, marginBottom: 15 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: '#1e293b', textTransform: 'uppercase' },
  formGroup: { marginBottom: 20 },
  formLabel: { fontSize: 12, color: '#475569', fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' },
  formInput: { backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, padding: 15, fontSize: 18, color: '#0f172a', fontWeight: 'bold' },
  inputDisabled: { backgroundColor: '#f1f5f9', color: '#64748b' },
  diffCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 12, borderRadius: 8 },
  diffText: { fontWeight: '900', fontSize: 14 },
  diffSuccess: { backgroundColor: '#dcfce7', borderWidth: 1, borderColor: '#34d399' },
  diffError: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#f87171' },
  preguntaItem: { marginBottom: 20, paddingBottom: 15, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  preguntaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  preguntaTexto: { fontSize: 15, color: '#334155', fontWeight: '600' },
  criticoText: { color: '#ef4444', fontSize: 10, fontWeight: '900', marginTop: 4, letterSpacing: 1 },
  inputFalla: { marginTop: 12, backgroundColor: '#fef2f2', borderWidth: 2, borderColor: '#ef4444', borderRadius: 8, padding: 12, color: '#7f1d1d', fontSize: 14 },
  fallaPrevia: { marginBottom: 20, padding: 12, borderRadius: 10, borderWidth: 2, borderColor: '#f59e0b', backgroundColor: '#fffbeb' },
  fallaResuelta: { borderColor: '#10b981', backgroundColor: '#f0fdf4' },
  fallaContinua: { borderColor: '#ef4444', backgroundColor: '#fef2f2' },
  badgeFalla: { backgroundColor: '#d97706', borderRadius: 4, paddingVertical: 4, paddingHorizontal: 8, alignItems: 'center' },
  badgeFallaTxt: { color: '#ffffff', fontSize: 10, fontWeight: '900' },
  obsAnterior: { fontSize: 13, color: '#92400e', marginTop: 8, marginBottom: 10 },
  filaSeguimiento: { flexDirection: 'row', gap: 10 },
  btnSeg: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 8 },
  btnSegActivo: { opacity: 1, borderWidth: 2, borderColor: '#0f172a' },
  btnSegInactivo: { opacity: 0.45 },
  btnSegTxt: { color: '#ffffff', fontWeight: '900', fontSize: 13 },
  footer: { flexDirection: 'row', padding: 15, backgroundColor: '#ffffff', borderTopWidth: 1, borderTopColor: '#e2e8f0', justifyContent: 'space-between' },
  btn: { flex: 1, padding: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', marginHorizontal: 5 },
  btnSecondary: { backgroundColor: '#f1f5f9' },
  btnPrimary: { backgroundColor: '#3b82f6' },
  btnSuccess: { backgroundColor: '#10b981', elevation: 3 },
  btnText: { color: '#ffffff', fontWeight: '900', fontSize: 16 },
  btnTextSec: { color: '#475569', fontWeight: '900', fontSize: 16 },
});
