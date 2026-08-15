import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.tyhuang9.dupert',
  appName: 'Dupert',
  webDir: 'dist',
  // Bundle the compiled files; production must never point the native shell at a
  // hosted server. These explicit defaults are the native Origins configured in
  // NATIVE_ALLOWED_ORIGINS on the backend.
  server: {
    hostname: 'localhost',
    iosScheme: 'capacitor',
    androidScheme: 'https',
  },
};

export default config;
