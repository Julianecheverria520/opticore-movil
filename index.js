// La tarea GPS se define ANTES que todo: Android puede despertar la app sin interfaz
// solo para entregar puntos, y la tarea tiene que existir en ese momento.
import './src/gps/tarea';
import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
