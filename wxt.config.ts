import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Strava → Peakbagger",
    description: "Sync Strava activities to peakbagger.com ascents",
    version: "0.4.0",
    permissions: ["identity", "storage", "tabs", "alarms", "scripting"],
    host_permissions: [
      "https://www.strava.com/*",
      "https://*.peakbagger.com/*",
    ],
  },
});
