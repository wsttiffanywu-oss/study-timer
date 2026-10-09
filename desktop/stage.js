// Lays out desktop/app for one language:  node stage.js zh|en
// Needs `npm install` first (for sql.js). Uses scripts/build_packages.py for the language-fixed web files.
const fs = require("fs"), path = require("path"), cp = require("child_process");
const lang = process.argv[2];
if (!["zh", "en"].includes(lang)) { console.error("usage: node stage.js zh|en"); process.exit(1); }
const here = __dirname, root = path.join(here, "..");
const stageRoot = path.join(here, ".stage"), appDir = path.join(here, "app");

fs.rmSync(stageRoot, { recursive: true, force: true });
cp.execFileSync("python3", [path.join(root, "scripts", "build_packages.py"), "--stage-only", stageRoot], { stdio: "inherit" });

fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(path.join(appDir, "vendor"), { recursive: true });
for (const f of ["index.html", "style.css", "app.js", "ai-import.js", "i18n.js", "LICENSE", "demo-data.json"]) {
  fs.copyFileSync(path.join(stageRoot, lang, f), path.join(appDir, f));
}
// The database engine is bundled so the app works offline (the web version loads it from a CDN).
const sqlDist = path.join(here, "node_modules", "sql.js", "dist");
for (const f of ["sql-wasm.js", "sql-wasm.wasm"]) fs.copyFileSync(path.join(sqlDist, f), path.join(appDir, "vendor", f));
const cdn = "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.js";
let html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
if (!html.includes(cdn)) { console.error("stage: sql.js CDN script tag not found in index.html"); process.exit(1); }
fs.writeFileSync(path.join(appDir, "index.html"), html.replace(cdn, "vendor/sql-wasm.js"));
fs.writeFileSync(path.join(appDir, "config.json"), JSON.stringify({ lang }) + "\n");
fs.rmSync(stageRoot, { recursive: true, force: true });
console.log("staged desktop/app for", lang);
