// Electron main process: opens the window and keeps the database as a real file in the app's
// own data folder (macOS: ~/Library/Application Support/<app name>/data).
const { app, BrowserWindow, Menu, shell, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

const SMOKE = process.env.STUDY_TIMER_SMOKE === "1";          // CI / test: start, check, quit
if (process.env.STUDY_TIMER_USERDATA) app.setPath("userData", process.env.STUDY_TIMER_USERDATA);

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "app", "config.json"), "utf8"));
const ZH = config.lang === "zh";
const TEXT = ZH
  ? { data: "显示数据文件夹", backups: "显示备份文件夹", file: "文件" }
  : { data: "Show Data Folder", backups: "Show Backups Folder", file: "File" };

const dataDir = () => path.join(app.getPath("userData"), "data");
const dbFile = () => path.join(dataDir(), "study-timer.sqlite");
const backupDir = () => path.join(dataDir(), "backups");

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, file);
}

ipcMain.handle("st:load", () => (fs.existsSync(dbFile()) ? fs.readFileSync(dbFile()) : null));
ipcMain.handle("st:save", (_e, data) => { writeAtomic(dbFile(), data); });
ipcMain.on("st:saveSync", (e, data) => { try { writeAtomic(dbFile(), data); e.returnValue = true; } catch (err) { e.returnValue = false; } });
ipcMain.handle("st:wasm", () => fs.readFileSync(path.join(__dirname, "app", "vendor", "sql-wasm.wasm")));
ipcMain.handle("st:dailyBackup", (_e, json) => {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const file = path.join(backupDir(), `study-timer-${day}.json`);
  if (fs.existsSync(file)) return false;
  writeAtomic(file, Buffer.from(json, "utf8"));
  const all = fs.readdirSync(backupDir()).filter(f => /^study-timer-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  all.slice(0, Math.max(0, all.length - 30)).forEach(f => fs.unlinkSync(path.join(backupDir(), f)));
  return true;
});

function showFolder(dir) { fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); }

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { label: TEXT.file, submenu: [
      { label: TEXT.data, click: () => showFolder(dataDir()) },
      { label: TEXT.backups, click: () => showFolder(backupDir()) },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" }
    ] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 860, minWidth: 720, minHeight: 560,
    title: app.getName(),
    show: !SMOKE,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  // Links to websites open in the normal browser, never inside this window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.loadFile(path.join(__dirname, "app", "index.html"));
  if (SMOKE) smokeTest(win);
  return win;
}

// End-to-end check used by CI: the page loads, the database starts, a write reaches the file on disk.
function smokeTest(win) {
  const fail = (msg) => { console.log("SMOKE-FAIL: " + msg); app.exit(1); };
  setTimeout(() => fail("timed out"), 45000);
  win.webContents.on("render-process-gone", () => fail("renderer crashed"));
  win.webContents.once("did-finish-load", async () => {
    try {
      let status = "";
      for (let i = 0; i < 100; i++) {
        status = await win.webContents.executeJavaScript("document.getElementById('dbStatus').textContent");
        if (!/…|\.\.\./.test(status)) break;
        await new Promise(r => setTimeout(r, 300));
      }
      if (/失败|failed/i.test(status) || /…|\.\.\./.test(status)) return fail("database status: " + status);
      await win.webContents.executeJavaScript("run('INSERT OR IGNORE INTO courses (name) VALUES (?)', ['smoke-test'])");
      for (let i = 0; i < 20 && !fs.existsSync(dbFile()); i++) await new Promise(r => setTimeout(r, 200));
      if (!fs.existsSync(dbFile()) || fs.statSync(dbFile()).size < 1000) return fail("database file was not written");
      console.log("SMOKE-OK lang=" + config.lang + " db=" + fs.statSync(dbFile()).size + " bytes");
      app.exit(0);
    } catch (err) { fail(String(err)); }
  });
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { app.quit(); });
