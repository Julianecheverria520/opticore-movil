// NetInfo: con red salvo que la prueba ponga globalThis.__sinRed = true
export default {
  fetch: async () => (globalThis.__sinRed
    ? { isConnected: false, isInternetReachable: false }
    : { isConnected: true, isInternetReachable: true }),
  addEventListener: () => () => {},
};
