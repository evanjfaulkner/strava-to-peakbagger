export default defineContentScript({
  matches: ["https://*.peakbagger.com/climber/ascentedit.aspx*"],
  runAt: "document_idle",
  main() {
    console.log("ascentedit content script loaded");
  },
});
