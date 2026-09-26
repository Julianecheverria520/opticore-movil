import React, { useState } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, StatusBar } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { API_URL } from '../config';

export default function LoginScreen({ onLoginSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) {
      Alert.alert('Error', 'Por favor ingresa tu usuario y contraseña.');
      return;
    }

    setLoading(true);
    try {
      const formData = new URLSearchParams();
      formData.append('username', username.trim());
      formData.append('password', password);

      // Login de la app: token de 7 días (conductores) que solo sirve en las rutas de la app.
      // Si el servidor todavía no tiene /auth/token-movil (404), se usa el login de la web.
      const pedir = (ruta) => fetch(`${API_URL}${ruta}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      });
      let response = await pedir('/auth/token-movil');
      if (response.status === 404) response = await pedir('/auth/token');

      const data = await response.json();

      if (response.ok && data.access_token) {
        // 🔥 Pasamos el token Y el nombre de usuario para el modo Offline
        onLoginSuccess(data.access_token, username.trim());
      } else if (response.status === 403 && typeof data.detail === 'string') {
        // Cuenta inactiva o empresa suspendida: el servidor explica el motivo
        Alert.alert('Acceso bloqueado', `${data.detail}\n\nLo que tengas sin enviar se conserva en el celular.`);
      } else {
        Alert.alert('Error', 'Credenciales incorrectas o acceso denegado.');
      }
    } catch (error) {
      console.error("Error de login:", error);
      Alert.alert('Error de Red', 'No se pudo conectar al servidor. Revisa tu conexión a internet.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView 
      style={styles.container} 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />
      
      <View style={styles.headerWrap}>
        <View style={styles.logoCircle}>
          <FontAwesome5 name="route" size={32} color="#ffffff" />
        </View>
        <Text style={styles.title}>OptiCore IA</Text>
        <Text style={styles.subtitle}>SISTEMA DE GESTIÓN LOGÍSTICA</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.headerCard}>
          <Text style={styles.cardTitle}>Iniciar Sesión</Text>
          <Text style={styles.cardSubtitle}>Ingresa tus credenciales de operador</Text>
        </View>

        <View style={styles.inputContainer}>
          <View style={styles.iconWrap}>
            <FontAwesome5 name="user-alt" size={16} color="#64748b" />
          </View>
          <TextInput
            style={styles.input}
            placeholder="Usuario (Cédula)"
            placeholderTextColor="#64748b"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            keyboardType="default"
          />
        </View>
        
        <View style={styles.inputContainer}>
          <View style={styles.iconWrap}>
            <FontAwesome5 name="lock" size={16} color="#64748b" />
          </View>
          <TextInput
            style={styles.input}
            placeholder="Contraseña"
            placeholderTextColor="#64748b"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
        </View>

        <TouchableOpacity 
          style={[styles.button, loading && styles.buttonDisabled]} 
          onPress={handleLogin} 
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <>
              <Text style={styles.buttonText}>INGRESAR</Text>
              <FontAwesome5 name="arrow-right" size={14} color="#ffffff" style={{ marginLeft: 8 }} />
            </>
          )}
        </TouchableOpacity>
      </View>
      
      <Text style={styles.footerText}>Conexión Segura Cifrada</Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    padding: 20,
  },
  headerWrap: {
    alignItems: 'center',
    marginBottom: 40,
  },
  logoCircle: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: '#3b82f6',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 15,
    elevation: 10,
    shadowColor: '#3b82f6',
    shadowOpacity: 0.4,
    shadowRadius: 15,
  },
  title: {
    fontSize: 32,
    fontWeight: '900',
    color: '#ffffff',
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
    letterSpacing: 2,
    marginTop: 5,
  },
  card: {
    backgroundColor: '#1e293b',
    padding: 25,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#334155',
    elevation: 5,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  headerCard: {
    marginBottom: 25,
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#ffffff',
  },
  cardSubtitle: {
    fontSize: 14,
    color: '#94a3b8',
    marginTop: 4,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 12,
    marginBottom: 15,
    overflow: 'hidden',
  },
  iconWrap: {
    padding: 15,
    justifyContent: 'center',
    alignItems: 'center',
    width: 50,
  },
  input: {
    flex: 1,
    paddingVertical: 15,
    paddingRight: 15,
    fontSize: 16,
    color: '#ffffff',
    fontWeight: '600',
  },
  button: {
    backgroundColor: '#3b82f6',
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
    elevation: 3,
  },
  buttonDisabled: {
    backgroundColor: '#1e3a8a',
    elevation: 0,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '900',
    fontSize: 16,
    letterSpacing: 1,
  },
  footerText: {
    textAlign: 'center',
    color: '#475569',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 30,
    letterSpacing: 1,
  }
});