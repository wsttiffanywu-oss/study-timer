// Runs before the page. Gives the web app a small, fixed set of ways to keep its data in a
// file; the page itself has no access to Node or the file system.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopStorage", {
  load: () => ipcRenderer.invoke("st:load"),                 // Uint8Array | null
  save: (data) => ipcRenderer.invoke("st:save", data),
  saveSync: (data) => ipcRenderer.sendSync("st:saveSync", data), // used while the window is closing
  getWasm: () => ipcRenderer.invoke("st:wasm"),              // sql.js engine, bundled with the app
  dailyBackup: (json) => ipcRenderer.invoke("st:dailyBackup", json)
});
