import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.bytebrains.qvault",
  appName: "QVault",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  android: {
    backgroundColor: "#050510",
  },
};

export default config;
