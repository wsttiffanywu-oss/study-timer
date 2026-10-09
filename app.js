/* =========================================================================
   Storage layer: SQLite running in the browser via sql.js (WebAssembly),
   persisted across reloads by serializing the whole DB file into IndexedDB
   after every write. No course/schedule data is hard-coded anywhere below —
   the database starts empty and everything is entered through the UI.
   ========================================================================= */

const IDB_NAME = "study_timer_idb";
const IDB_STORE = "kv";
const IDB_KEY = "sqlite_file";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const dbi = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const dbi = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS courses (
  name TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  course TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'class',
  type TEXT NOT NULL,
  day INTEGER,
  date TEXT,
  start TEXT NOT NULL,
  end_time TEXT NOT NULL,
  loc TEXT,
  start_date TEXT,
  end_date TEXT,
  exclude_dates TEXT,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course TEXT NOT NULL,
  date TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  note TEXT,
  start_time TEXT,
  end_time TEXT,
  saved_at TEXT,
  deleted_at TEXT,
  breaks TEXT
);
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS timer_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  course TEXT,
  start_epoch INTEGER,
  first_start_epoch INTEGER,
  elapsed_before_pause REAL,
  running INTEGER,
  breaks TEXT
);
`;

let db = null;
let persistTimer = null;

function persist() {
  // Debounced so a burst of writes (e.g. rendering) doesn't serialize repeatedly.
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    const data = db.export();
    await idbSet(IDB_KEY, data);
  }, 60);
}

function run(sql, params = []) {
  db.run(sql, params);
  persist();
}
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function initDatabase() {
  const SQL = await initSqlJs({
    locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/${file}`
  });
  const stored = await idbGet(IDB_KEY);
  db = stored ? new SQL.Database(new Uint8Array(stored)) : new SQL.Database();
  db.run(SCHEMA_SQL); // safe even on an existing DB (CREATE TABLE IF NOT EXISTS)
  ensureColumn("events", "deleted_at", "TEXT");   // migration for DBs created before the trash feature
  ensureColumn("records", "deleted_at", "TEXT");
  ensureColumn("records", "breaks", "TEXT");       // migration for DBs created before pause/resume break tracking
  ensureColumn("timer_state", "breaks", "TEXT");
  purgeOldTrash();
}

function ensureColumn(table, column, definition) {
  const cols = queryAll(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    persist();
  }
}

// Anything sitting in the trash for more than 30 days is permanently deleted.
function purgeOldTrash() {
  const cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  run("DELETE FROM records WHERE deleted_at IS NOT NULL AND deleted_at < ?", [cutoff]);
  run("DELETE FROM events WHERE deleted_at IS NOT NULL AND deleted_at < ?", [cutoff]);
}

/* ---- data-access functions used by the UI below ---- */
function dbGetCourses() {
  return queryAll("SELECT name FROM courses ORDER BY rowid").map(r => r.name);
}
function dbAddCourse(name) {
  run("INSERT OR IGNORE INTO courses (name) VALUES (?)", [name]);
}
function dbDeleteCourse(name) {
  // Only removes it from the course/work-type list; past events and records that
  // reference this name by text are left untouched.
  run("DELETE FROM courses WHERE name = ?", [name]);
}

function dbGetEvents() {
  return queryAll("SELECT * FROM events WHERE deleted_at IS NULL").map(r => ({
    id: r.id,
    course: r.course,
    kind: r.kind,
    type: r.type,
    day: r.day === null ? undefined : r.day,
    date: r.date || undefined,
    start: r.start,
    end: r.end_time,
    loc: r.loc || "",
    startDate: r.start_date || undefined,
    endDate: r.end_date || undefined,
    excludeDates: r.exclude_dates ? JSON.parse(r.exclude_dates) : undefined
  }));
}
function dbAddEvent(ev) {
  run(
    `INSERT INTO events (id, course, kind, type, day, date, start, end_time, loc, start_date, end_date, exclude_dates)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      ev.id, ev.course, ev.kind, ev.type,
      ev.day === undefined ? null : ev.day,
      ev.date || null, ev.start, ev.end, ev.loc || null,
      ev.startDate || null, ev.endDate || null,
      ev.excludeDates ? JSON.stringify(ev.excludeDates) : null
    ]
  );
}
function dbDeleteEvent(id) { run("UPDATE events SET deleted_at = ? WHERE id = ?", [new Date().toISOString(), id]); }
function dbRestoreEvent(id) { run("UPDATE events SET deleted_at = NULL WHERE id = ?", [id]); }
function dbPermanentlyDeleteEvent(id) { run("DELETE FROM events WHERE id = ?", [id]); }
function dbGetAllEventIds() {
  // includes trashed events too — needed to avoid primary-key collisions on import
  return new Set(queryAll("SELECT id FROM events").map(r => r.id));
}
function dbGetDeletedEvents() {
  return queryAll("SELECT * FROM events WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").map(r => ({
    id: r.id, course: r.course, kind: r.kind, type: r.type,
    day: r.day === null ? undefined : r.day, date: r.date || undefined,
    start: r.start, end: r.end_time, loc: r.loc || "", deletedAt: r.deleted_at
  }));
}
function dbUpdateEvent(id, ev) {
  run(
    `UPDATE events SET course=?, kind=?, type=?, day=?, date=?, start=?, end_time=?, loc=?, start_date=?, end_date=? WHERE id=?`,
    [
      ev.course, ev.kind, ev.type,
      ev.day === undefined ? null : ev.day,
      ev.date || null, ev.start, ev.end, ev.loc || null,
      ev.startDate || null, ev.endDate || null,
      id
    ]
  );
}

function dbGetRecords() {
  return queryAll("SELECT * FROM records WHERE deleted_at IS NULL ORDER BY id").map(r => ({
    id: r.id,
    course: r.course,
    date: r.date,
    seconds: r.seconds,
    note: r.note || "",
    startTime: r.start_time || undefined,
    endTime: r.end_time || undefined,
    savedAt: r.saved_at,
    // Pause/resume intervals within this session, each {start, end} as ISO timestamps.
    // The stored `seconds` already excludes this time; it's kept only so the calendar
    // can show the gap inside the block instead of silently shrinking the block.
    breaks: r.breaks ? JSON.parse(r.breaks) : []
  }));
}
function dbAddRecord(rec) {
  run(
    `INSERT INTO records (course, date, seconds, note, start_time, end_time, saved_at, breaks) VALUES (?,?,?,?,?,?,?,?)`,
    [
      rec.course, rec.date, rec.seconds, rec.note || null, rec.startTime || null, rec.endTime || null, rec.savedAt,
      rec.breaks && rec.breaks.length ? JSON.stringify(rec.breaks) : null
    ]
  );
}
function dbDeleteRecord(id) { run("UPDATE records SET deleted_at = ? WHERE id = ?", [new Date().toISOString(), id]); }
function dbRestoreRecord(id) { run("UPDATE records SET deleted_at = NULL WHERE id = ?", [id]); }
function dbPermanentlyDeleteRecord(id) { run("DELETE FROM records WHERE id = ?", [id]); }
function dbGetDeletedRecords() {
  return queryAll("SELECT * FROM records WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").map(r => ({
    id: r.id, course: r.course, date: r.date, seconds: r.seconds, note: r.note || "",
    startTime: r.start_time || undefined, endTime: r.end_time || undefined,
    savedAt: r.saved_at, deletedAt: r.deleted_at,
    breaks: r.breaks ? JSON.parse(r.breaks) : []
  }));
}
function dbUpdateRecordTime(id, startTime, endTime, seconds) {
  run("UPDATE records SET start_time = ?, end_time = ?, seconds = ? WHERE id = ?", [startTime, endTime, seconds, id]);
}
function dbUpdateRecordNote(id, note) {
  run("UPDATE records SET note = ? WHERE id = ?", [note || null, id]);
}
function dbUpdateRecordCourse(id, course) {
  run("UPDATE records SET course = ? WHERE id = ?", [course, id]);
}

function dbGetPref(key, fallback) {
  const rows = queryAll("SELECT value FROM prefs WHERE key = ?", [key]);
  if (!rows.length) return fallback;
  try { return JSON.parse(rows[0].value); } catch { return fallback; }
}
function dbSetPref(key, value) {
  run(
    `INSERT INTO prefs (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)]
  );
}

function dbGetTimerState() {
  const rows = queryAll("SELECT * FROM timer_state WHERE id = 1");
  if (!rows.length || rows[0].course === null) return null;
  const r = rows[0];
  return {
    course: r.course,
    startEpoch: r.start_epoch,
    firstStartEpoch: r.first_start_epoch,
    elapsedBeforePause: r.elapsed_before_pause,
    running: !!r.running,
    breaks: r.breaks ? JSON.parse(r.breaks) : []
  };
}
function dbSetTimerState(state) {
  if (!state) { run("DELETE FROM timer_state WHERE id = 1"); return; }
  run(
    `INSERT INTO timer_state (id, course, start_epoch, first_start_epoch, elapsed_before_pause, running, breaks)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       course = excluded.course, start_epoch = excluded.start_epoch,
       first_start_epoch = excluded.first_start_epoch,
       elapsed_before_pause = excluded.elapsed_before_pause, running = excluded.running,
       breaks = excluded.breaks`,
    [state.course, state.startEpoch, state.firstStartEpoch, state.elapsedBeforePause, state.running ? 1 : 0, JSON.stringify(state.breaks || [])]
  );
}

/* =========================================================================
   UI — everything below reads/writes through the dbXxx() functions above.
   ========================================================================= */

let timerState = null; // mirrors dbGetTimerState(), kept in memory while ticking

function escapeHtml(str) {
  const div = document.createElement("div"); div.textContent = str; return div.innerHTML;
}
// Safe for embedding inside a double-quoted HTML attribute (escapeHtml alone
// doesn't escape " or ', which matters for things like data-course="...").
function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------------- modal (avoids native prompt/alert, which some preview frames block) ---------------- */
const modalOverlay = document.getElementById("modalOverlay");
const modalCard = document.getElementById("modalCard");
function showModal(html) { modalCard.innerHTML = html; modalOverlay.style.display = "flex"; }
function hideModal() { modalOverlay.style.display = "none"; modalCard.innerHTML = ""; modalCard.style.maxWidth = ""; }
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) hideModal(); });

/* ---------------- tabs ---------------- */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "calTab") renderCalendar();
  });
});

/* ================= TIMER LOGIC ================= */
const courseSelect = document.getElementById("courseSelect");
const newCourseInput = document.getElementById("newCourseInput");
const addCourseBtn = document.getElementById("addCourseBtn");
const timerDisplay = document.getElementById("timerDisplay");
const statusText = document.getElementById("statusText");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const stopBtn = document.getElementById("stopBtn");
const noteInput = document.getElementById("noteInput");
const recordsContainer = document.getElementById("recordsContainer");
const filterDate = document.getElementById("filterDate");
const clearFilterBtn = document.getElementById("clearFilterBtn");
const exportBtn = document.getElementById("exportBtn");

let tickInterval = null;

function renderCourseOptions() {
  const courses = dbGetCourses();
  [courseSelect, document.getElementById("evCourseSelect")].forEach(sel => {
    const prevVal = sel.value;
    sel.innerHTML = "";
    courses.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c; opt.textContent = c;
      sel.appendChild(opt);
    });
    if (courses.includes(prevVal)) sel.value = prevVal;
  });
  if (timerState && timerState.course) courseSelect.value = timerState.course;
}

function formatSeconds(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
}
function formatClock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function currentElapsedSeconds() {
  if (!timerState) return 0;
  let elapsed = timerState.elapsedBeforePause || 0;
  if (timerState.running && timerState.startEpoch) elapsed += (Date.now() - timerState.startEpoch) / 1000;
  return elapsed;
}
function updateDisplay() { timerDisplay.textContent = formatSeconds(currentElapsedSeconds()); }

function setButtonsForState() {
  if (!timerState) {
    startBtn.disabled = false; pauseBtn.disabled = true; stopBtn.disabled = true;
    pauseBtn.textContent = t("timer.pause"); statusText.textContent = t("timer.pickHint");
    courseSelect.disabled = false;
    return;
  }
  courseSelect.disabled = true; startBtn.disabled = true; stopBtn.disabled = false;
  if (timerState.running) {
    pauseBtn.disabled = false; pauseBtn.textContent = t("timer.pause");
    statusText.textContent = t("timer.running", { course: timerState.course });
  } else {
    pauseBtn.disabled = false; pauseBtn.textContent = t("timer.resume");
    statusText.textContent = t("timer.paused", { course: timerState.course });
  }
}

function startTicking() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(updateDisplay, 1000);
}
function stopTicking() { if (tickInterval) clearInterval(tickInterval); tickInterval = null; }

function todayStr() {
  return dateStrOf(new Date());
}
function dateStrOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// The local calendar date a stored ISO timestamp falls on — used instead of the
// record's stored `date` field wherever we need to know exactly which day a
// specific clock-time actually happened on (the record's `date` reflects which
// day the session is attributed to, which may differ for overnight sessions).
function isoLocalDate(iso) { return dateStrOf(new Date(iso)); }

startBtn.addEventListener("click", () => {
  const course = courseSelect.value;
  if (!course) return;
  timerState = { course, startEpoch: Date.now(), firstStartEpoch: Date.now(), elapsedBeforePause: 0, running: true, breaks: [] };
  dbSetTimerState(timerState); setButtonsForState(); updateDisplay(); startTicking();
});

pauseBtn.addEventListener("click", () => {
  if (!timerState) return;
  timerState.breaks = timerState.breaks || [];
  if (timerState.running) {
    timerState.elapsedBeforePause = currentElapsedSeconds();
    timerState.running = false; timerState.startEpoch = null;
    // Open a break interval — closed when resumed (or, if the timer is stopped
    // while still paused, closed at stop time instead).
    timerState.breaks.push({ start: Date.now(), end: null });
    stopTicking();
  } else {
    const last = timerState.breaks[timerState.breaks.length - 1];
    if (last && last.end === null) last.end = Date.now();
    timerState.running = true; timerState.startEpoch = Date.now();
    startTicking();
  }
  dbSetTimerState(timerState); setButtonsForState(); updateDisplay();
});

stopBtn.addEventListener("click", () => {
  if (!timerState) return;
  const totalSeconds = Math.round(currentElapsedSeconds());
  if (totalSeconds >= 1) {
    const endEpoch = Date.now();
    const startEpoch = timerState.firstStartEpoch || (endEpoch - totalSeconds * 1000);
    const breaks = (timerState.breaks || [])
      .map(b => ({
        start: new Date(b.start).toISOString(),
        end: new Date(b.end === null || b.end === undefined ? endEpoch : b.end).toISOString()
      }))
      .filter(b => new Date(b.end).getTime() > new Date(b.start).getTime());
    dbAddRecord({
      // Attributed to the day the session STARTED, not the day Stop happened to be
      // clicked — otherwise a session begun before midnight and ended after it would
      // get filed under the wrong day.
      course: timerState.course, date: dateStrOf(new Date(startEpoch)), seconds: totalSeconds,
      note: noteInput.value.trim(), savedAt: new Date().toISOString(),
      startTime: new Date(startEpoch).toISOString(),
      endTime: new Date(endEpoch).toISOString(),
      breaks
    });
  }
  timerState = null; dbSetTimerState(null); stopTicking();
  timerDisplay.textContent = "00:00:00";
  noteInput.value = "";
  setButtonsForState(); renderRecords();
});

addCourseBtn.addEventListener("click", addCourseFromInput);
newCourseInput.addEventListener("keydown", e => { if (e.key === "Enter") addCourseFromInput(); });
function addCourseFromInput() {
  const name = newCourseInput.value.trim();
  if (!name) return;
  dbAddCourse(name);
  renderCourseOptions();
  courseSelect.value = name;
  newCourseInput.value = "";
}

document.getElementById("manageCourseBtn").addEventListener("click", showCourseManageModal);
function showCourseManageModal() {
  const courses = dbGetCourses();
  let html = `<h3>${t("mc.title")}</h3><p>${t("mc.help")}</p>`;
  if (courses.length === 0) {
    html += `<div class="empty" style="padding:0 0 8px;">${t("mc.none")}</div>`;
  } else {
    courses.forEach(c => {
      const isRunning = timerState && timerState.course === c;
      html += `<div class="modal-detail-row" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <span>${escapeHtml(c)}${isRunning ? t("mc.running") : ""}</span>
        <button class="btn-danger small course-del-btn" data-course="${escapeAttr(c)}" ${isRunning ? "disabled" : ""}>${t("common.delete")}</button>
      </div>`;
    });
  }
  html += `<div class="modal-actions"><button class="btn-outline small" id="modalCloseBtn">${t("common.close")}</button></div>`;
  modalCard.style.maxWidth = "420px";
  showModal(html);
  document.getElementById("modalCloseBtn").addEventListener("click", () => { modalCard.style.maxWidth = ""; hideModal(); });
  document.querySelectorAll(".course-del-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      dbDeleteCourse(btn.dataset.course);
      renderCourseOptions();
      showCourseManageModal();
    });
  });
}

filterDate.addEventListener("input", renderRecords);
clearFilterBtn.addEventListener("click", () => { filterDate.value = ""; renderRecords(); });

exportBtn.addEventListener("click", () => {
  const records = dbGetRecords();
  if (records.length === 0) return;
  let csv = t("csv.header") + "\n";
  records.forEach(r => {
    const note = (r.note || "").replace(/"/g, '""');
    csv += `${r.date},${formatClock(r.startTime)},${formatClock(r.endTime)},${r.course},${r.seconds},${formatSeconds(r.seconds)},"${note}"\n`;
  });
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "study_records.csv"; a.click();
  URL.revokeObjectURL(url);
});

function deleteRecord(id) { dbDeleteRecord(id); renderRecords(); }

document.getElementById("trashBtn").addEventListener("click", showTrashModal);

function showTrashModal() {
  const deletedRecords = dbGetDeletedRecords();
  const deletedEvents = dbGetDeletedEvents();

  let html = `<h3>${t("trash.title")}</h3><p>${t("trash.help")}</p>`;

  html += `<div style="font-weight:700; font-size:13px; margin:10px 0 6px;">${t("trash.records", { n: deletedRecords.length })}</div>`;
  if (deletedRecords.length === 0) {
    html += `<div class="empty" style="padding:0 0 8px;">${t("trash.none")}</div>`;
  } else {
    deletedRecords.forEach(r => {
      const clockRange = (r.startTime && r.endTime) ? `${formatClock(r.startTime)}–${formatClock(r.endTime)}` : "";
      html += `<div class="modal-detail-row" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <span>${r.date} ${clockRange}　${escapeHtml(r.course)}　${formatSeconds(r.seconds)}</span>
        <span style="white-space:nowrap;">
          <button class="btn-outline small" onclick="restoreRecordFromTrash(${r.id})">${t("trash.restore")}</button>
          <button class="btn-danger small" onclick="permanentlyDeleteRecordFromTrash(${r.id})">${t("trash.purge")}</button>
        </span>
      </div>`;
    });
  }

  html += `<div style="font-weight:700; font-size:13px; margin:14px 0 6px;">${t("trash.events", { n: deletedEvents.length })}</div>`;
  if (deletedEvents.length === 0) {
    html += `<div class="empty" style="padding:0 0 8px;">${t("trash.none")}</div>`;
  } else {
    deletedEvents.forEach(ev => {
      const whenLabel = ev.type === "recurring" ? DAY_NAMES[ev.day] : ev.date;
      html += `<div class="modal-detail-row" style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <span>${whenLabel} ${ev.start}-${ev.end}　${escapeHtml(ev.course)}</span>
        <span style="white-space:nowrap;">
          <button class="btn-outline small" onclick="restoreEventFromTrash('${ev.id}')">${t("trash.restore")}</button>
          <button class="btn-danger small" onclick="permanentlyDeleteEventFromTrash('${ev.id}')">${t("trash.purge")}</button>
        </span>
      </div>`;
    });
  }

  html += `<div class="modal-actions"><button class="btn-outline small" id="modalCloseBtn">${t("common.close")}</button></div>`;
  modalCard.style.maxWidth = "480px";
  showModal(html);
  document.getElementById("modalCloseBtn").addEventListener("click", () => {
    modalCard.style.maxWidth = "";
    hideModal();
  });
}
function restoreRecordFromTrash(id) { dbRestoreRecord(id); renderRecords(); renderCalendar(); showTrashModal(); }
function permanentlyDeleteRecordFromTrash(id) { dbPermanentlyDeleteRecord(id); showTrashModal(); }
function restoreEventFromTrash(id) { dbRestoreEvent(id); renderCalendar(); showTrashModal(); }
function permanentlyDeleteEventFromTrash(id) { dbPermanentlyDeleteEvent(id); showTrashModal(); }

function editRecordNote(id) {
  const r = dbGetRecords().find(x => x.id === id);
  if (!r) return;
  showModal(`
    <h3>${t("note.title")}</h3>
    <p>${t("note.info", { course: escapeHtml(r.course), date: r.date })}</p>
    <textarea id="modalNoteInput" style="width:100%; min-height:80px;">${escapeHtml(r.note || "")}</textarea>
    <div class="modal-actions">
      <button class="btn-outline small" id="modalCancelBtn">${t("common.cancel")}</button>
      <button class="btn-primary small" id="modalSaveBtn">${t("common.save")}</button>
    </div>
  `);
  document.getElementById("modalCancelBtn").addEventListener("click", hideModal);
  document.getElementById("modalSaveBtn").addEventListener("click", () => {
    const val = document.getElementById("modalNoteInput").value.trim();
    dbUpdateRecordNote(id, val);
    renderRecords();
    renderCalendar();
    hideModal();
  });
}

function editRecordCourse(id) {
  const r = dbGetRecords().find(x => x.id === id);
  if (!r) return;
  const courses = dbGetCourses();
  const options = courses.map(c =>
    `<option value="${escapeAttr(c)}" ${c === r.course ? "selected" : ""}>${escapeHtml(c)}</option>`
  ).join("");
  showModal(`
    <h3>${t("ec.title")}</h3>
    <p>${t("ec.current", { course: escapeHtml(r.course), date: r.date, dur: formatSeconds(r.seconds) })}</p>
    <label class="form-label">${t("ec.pick")}</label>
    <select id="modalCourseSelect">${options}</select>
    <label class="form-label" style="margin-top:10px;">${t("ec.new")}</label>
    <input type="text" id="modalCourseNew" placeholder="${escapeAttr(t("ec.newPh"))}">
    <div class="modal-actions">
      <button class="btn-outline small" id="modalCancelBtn">${t("common.cancel")}</button>
      <button class="btn-primary small" id="modalSaveBtn">${t("common.save")}</button>
    </div>
  `);
  document.getElementById("modalCancelBtn").addEventListener("click", hideModal);
  document.getElementById("modalSaveBtn").addEventListener("click", () => {
    const newName = document.getElementById("modalCourseNew").value.trim();
    const selected = document.getElementById("modalCourseSelect").value;
    const finalCourse = newName || selected;
    if (!finalCourse) { hideModal(); return; }
    dbAddCourse(finalCourse);
    dbUpdateRecordCourse(id, finalCourse);
    renderCourseOptions();
    renderRecords();
    renderCalendar();
    hideModal();
  });
}

function editRecordTime(id) {
  const r = dbGetRecords().find(x => x.id === id);
  if (!r) return;
  const currentStart = r.startTime ? formatClock(r.startTime) : "";
  const currentEnd = r.endTime ? formatClock(r.endTime) : "";
  showModal(`
    <h3>${t("et.title")}</h3>
    <p>${t("et.info", { course: escapeHtml(r.course), dur: formatSeconds(r.seconds) })}</p>
    <label class="form-label">${t("form.start")}</label>
    <input type="time" id="modalStartInput" value="${currentStart}">
    <label class="form-label">${t("form.end")}</label>
    <input type="time" id="modalEndInput" value="${currentEnd}">
    <label style="display:flex; align-items:center; gap:6px; font-size:13px; margin:10px 0;">
      <input type="checkbox" id="modalOvernightInput"> ${t("et.overnight")}
    </label>
    <p id="modalTimeError" style="color:var(--danger); display:none; margin-top:-6px;"></p>
    <p style="margin-top:-6px;">${t("et.help")}</p>
    <div class="modal-actions">
      <button class="btn-outline small" id="modalCancelBtn">${t("common.cancel")}</button>
      <button class="btn-primary small" id="modalSaveBtn">${t("common.save")}</button>
    </div>
  `);
  document.getElementById("modalCancelBtn").addEventListener("click", hideModal);
  document.getElementById("modalSaveBtn").addEventListener("click", () => {
    const startVal = document.getElementById("modalStartInput").value;
    const endVal = document.getElementById("modalEndInput").value;
    const overnight = document.getElementById("modalOvernightInput").checked;
    const errorEl = document.getElementById("modalTimeError");
    const showError = (msg) => { errorEl.textContent = msg; errorEl.style.display = "block"; };
    if (!startVal || !endVal) { showError(t("err.times")); return; }

    const [sh, sm] = startVal.split(":").map(Number);
    const [eh, em] = endVal.split(":").map(Number);
    const startDate = new Date(r.date + "T00:00:00");
    startDate.setHours(sh, sm, 0, 0);
    const endDate = new Date(r.date + "T00:00:00");
    endDate.setHours(eh, em, 0, 0);
    if (overnight) endDate.setDate(endDate.getDate() + 1);

    if (endDate <= startDate) {
      showError(overnight ? t("et.errStillNotLater") : t("et.errEarlier"));
      return;
    }
    const now = new Date();
    if (startDate > now || endDate > now) {
      showError(t("et.errFuture"));
      return;
    }

    const newSeconds = Math.round((endDate - startDate) / 1000);
    dbUpdateRecordTime(id, startDate.toISOString(), endDate.toISOString(), newSeconds);
    renderRecords();
    renderCalendar();
    hideModal();
  });
}

function renderRecords() {
  const allRecords = dbGetRecords();
  const filter = filterDate.value.trim();
  let filtered = allRecords;
  if (filter) filtered = allRecords.filter(r => r.date.includes(filter));

  if (filtered.length === 0) {
    recordsContainer.innerHTML = `<div class="empty">${filter ? t("rec.emptyFiltered") : t("rec.empty")}</div>`;
    return;
  }
  const byDate = {};
  filtered.forEach(r => { (byDate[r.date] = byDate[r.date] || []).push(r); });
  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

  let html = "";
  dates.forEach(date => {
    const items = byDate[date];
    const dayTotal = items.reduce((sum, r) => sum + r.seconds, 0);
    html += `<table style="margin-bottom:14px;">
      <thead><tr>
        <th>${date} <span class="day-total">${t("rec.dayTotal", { total: formatSeconds(dayTotal) })}</span></th>
        <th>${t("rec.colCourse")}</th><th>${t("rec.colDuration")}</th><th></th>
      </tr></thead><tbody>`;
    items.forEach(r => {
      const clockRange = (r.startTime && r.endTime) ? `${formatClock(r.startTime)}–${formatClock(r.endTime)}` : "—";
      html += `<tr>
        <td><span class="delete-x" onclick="editRecordTime(${r.id})" title="${escapeAttr(t("rec.editTimeTitle"))}">${clockRange} ✎</span></td>
        <td><span class="delete-x" onclick="editRecordCourse(${r.id})" title="${escapeAttr(t("rec.editCourseTitle"))}">${escapeHtml(r.course)} ✎</span>${r.note ? `<div class="note-text">${escapeHtml(r.note)}</div>` : ""}<div><span class="delete-x" onclick="editRecordNote(${r.id})">${r.note ? t("rec.editNote") : t("rec.addNote")}</span></div></td>
        <td>${formatSeconds(r.seconds)}</td>
        <td><span class="delete-x" onclick="deleteRecord(${r.id})">${t("common.delete")}</span></td>
      </tr>`;
    });
    html += `</tbody></table>`;
  });
  recordsContainer.innerHTML = html;
}

/* ================= CALENDAR LOGIC ================= */
const calHeaderRow = document.getElementById("calHeaderRow");
const calTimeAxis = document.getElementById("calTimeAxis");
const calDays = document.getElementById("calDays");
const weekLabel = document.getElementById("weekLabel");
const prevWeekBtn = document.getElementById("prevWeekBtn");
const nextWeekBtn = document.getElementById("nextWeekBtn");
const toggleOH = document.getElementById("toggleOH");
const toggleActivity = document.getElementById("toggleActivity");
const toggleLog = document.getElementById("toggleLog");
const toggleExpand = document.getElementById("toggleExpand");
const evCourseSelect = document.getElementById("evCourseSelect");
const evNewCourseInput = document.getElementById("evNewCourseInput");
const evKindSelect = document.getElementById("evKindSelect");
const evDayWrap = document.getElementById("evDayWrap");
const evDateWrap = document.getElementById("evDateWrap");
const evRangeWrap = document.getElementById("evRangeWrap");
const evStartDateInput = document.getElementById("evStartDateInput");
const evEndDateInput = document.getElementById("evEndDateInput");
const evDaySelect = document.getElementById("evDaySelect");
const evDateInput = document.getElementById("evDateInput");
const evStartInput = document.getElementById("evStartInput");
const evEndInput = document.getElementById("evEndInput");
const evLocInput = document.getElementById("evLocInput");
const addEventBtn = document.getElementById("addEventBtn");

const DAY_NAMES = t("days");
const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;
const NORMAL_ZONE_START = 8;
const NORMAL_ZONE_END = 22;
const NORMAL_HOUR_HEIGHT = 48;
const COMPRESSED_HOUR_HEIGHT = 9;
let weekOffset = 0;
let calPrefs = { showOH: false, showActivity: false, showLog: true, expandCompressed: false };

function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Colors are derived purely from each course's position in the (database-backed) course
// list, spaced by the golden angle so adjacent courses land far apart on the color wheel.
// No course name or color is hard-coded — add any course through the UI and it gets a
// well-spread color automatically.
function courseHue(name) {
  const courses = dbGetCourses();
  const idx = courses.indexOf(name);
  if (idx === -1) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return Math.abs(hash) % 360;
  }
  return Math.round((idx * 137.508) % 360);
}

function timeToMinutes(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

function minutesToY(minutes) {
  const normalPerMin = NORMAL_HOUR_HEIGHT / 60;
  // When the person has expanded the compressed (0-8 / 22-24) zones — via the toggle
  // or a double-click on empty calendar background — just use the normal scale
  // everywhere, so nothing in those hours has to squeeze together anymore.
  if (calPrefs.expandCompressed) return minutes * normalPerMin;
  const compressedPerMin = COMPRESSED_HOUR_HEIGHT / 60;
  const zoneStartMin = NORMAL_ZONE_START * 60;
  const zoneEndMin = NORMAL_ZONE_END * 60;
  if (minutes <= zoneStartMin) return minutes * compressedPerMin;
  if (minutes <= zoneEndMin) return zoneStartMin * compressedPerMin + (minutes - zoneStartMin) * normalPerMin;
  return zoneStartMin * compressedPerMin + (zoneEndMin - zoneStartMin) * normalPerMin + (minutes - zoneEndMin) * compressedPerMin;
}
function pixelTop(t) { return minutesToY(timeToMinutes(t)); }
function pixelHeight(start, end) { return Math.max(minutesToY(timeToMinutes(end)) - minutesToY(timeToMinutes(start)), 20); }

function computeDayLayout(dayEvents) {
  const sorted = [...dayEvents].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  const clusters = [];
  let current = [];
  let currentEnd = -1;
  sorted.forEach(ev => {
    const s = timeToMinutes(ev.start), e = timeToMinutes(ev.end);
    if (current.length && s >= currentEnd) {
      clusters.push(current);
      current = [];
      currentEnd = -1;
    }
    current.push(ev);
    currentEnd = Math.max(currentEnd, e);
  });
  if (current.length) clusters.push(current);

  clusters.forEach(cluster => {
    const colEndTimes = [];
    cluster.forEach(ev => {
      const s = timeToMinutes(ev.start);
      let placedCol = colEndTimes.findIndex(endT => endT <= s);
      if (placedCol === -1) { placedCol = colEndTimes.length; colEndTimes.push(0); }
      colEndTimes[placedCol] = timeToMinutes(ev.end);
      ev._col = placedCol;
    });
    cluster.forEach(ev => { ev._totalCols = colEndTimes.length; });
  });
  return sorted;
}

toggleOH.addEventListener("change", () => { calPrefs.showOH = toggleOH.checked; dbSetPref("showOH", calPrefs.showOH); renderCalendar(); });
toggleActivity.addEventListener("change", () => { calPrefs.showActivity = toggleActivity.checked; dbSetPref("showActivity", calPrefs.showActivity); renderCalendar(); });
toggleLog.addEventListener("change", () => { calPrefs.showLog = toggleLog.checked; dbSetPref("showLog", calPrefs.showLog); renderCalendar(); });
toggleExpand.addEventListener("change", () => { calPrefs.expandCompressed = toggleExpand.checked; dbSetPref("expandCompressed", calPrefs.expandCompressed); renderCalendar(); });

// Double-clicking empty calendar background (not on an event block) toggles the
// same expand/collapse — handy for quickly opening up the compressed 0-8/22-24
// hours right where several blocks look squeezed together, without reaching for
// the checkbox. Attached once to the stable container, so it survives re-renders.
calDays.addEventListener("dblclick", (e) => {
  if (!e.target.classList.contains("cal-daycol")) return;
  calPrefs.expandCompressed = !calPrefs.expandCompressed;
  dbSetPref("expandCompressed", calPrefs.expandCompressed);
  toggleExpand.checked = calPrefs.expandCompressed;
  renderCalendar();
});

document.querySelectorAll('input[name="evType"]').forEach(r => {
  r.addEventListener("change", () => {
    const val = document.querySelector('input[name="evType"]:checked').value;
    evDayWrap.style.display = val === "recurring" ? "block" : "none";
    evDateWrap.style.display = val === "oneoff" ? "block" : "none";
    evRangeWrap.style.display = val === "recurring" ? "block" : "none";
  });
});

prevWeekBtn.addEventListener("click", () => { weekOffset--; renderCalendar(); });
nextWeekBtn.addEventListener("click", () => { weekOffset++; renderCalendar(); });

addEventBtn.addEventListener("click", () => {
  let course = evNewCourseInput.value.trim() || evCourseSelect.value;
  if (!course) return;
  dbAddCourse(course);
  renderCourseOptions();
  const type = document.querySelector('input[name="evType"]:checked').value;
  const kind = evKindSelect.value;
  const start = evStartInput.value, end = evEndInput.value;
  if (!start || !end) {
    showModal(`<h3>${t("add.noTimeTitle")}</h3><p>${t("add.noTimeMsg")}</p><div class="modal-actions"><button class="btn-primary small" id="modalOkBtn">${t("common.ok")}</button></div>`);
    document.getElementById("modalOkBtn").addEventListener("click", hideModal);
    return;
  }
  const loc = evLocInput.value.trim();

  const ev = { id: "e" + Date.now(), course, kind, type, start, end, loc };
  if (type === "recurring") {
    ev.day = parseInt(evDaySelect.value, 10);
    const sd = evStartDateInput.value, ed = evEndDateInput.value;
    if (sd && ed && ed < sd) {
      showModal(`<h3>${t("add.badRangeTitle")}</h3><p>${t("add.badRangeMsg")}</p><div class="modal-actions"><button class="btn-primary small" id="modalOkBtn">${t("common.ok")}</button></div>`);
      document.getElementById("modalOkBtn").addEventListener("click", hideModal);
      return;
    }
    if (sd) ev.startDate = sd;
    if (ed) ev.endDate = ed;
  } else {
    if (!evDateInput.value) {
      showModal(`<h3>${t("add.noDateTitle")}</h3><p>${t("add.noDateMsg")}</p><div class="modal-actions"><button class="btn-primary small" id="modalOkBtn">${t("common.ok")}</button></div>`);
      document.getElementById("modalOkBtn").addEventListener("click", hideModal);
      return;
    }
    ev.date = evDateInput.value;
    const d = new Date(evDateInput.value + "T00:00:00");
    ev.day = (d.getDay() + 6) % 7;
  }
  dbAddEvent(ev);
  evNewCourseInput.value = ""; evLocInput.value = ""; evStartInput.value = ""; evEndInput.value = "";
  evStartDateInput.value = ""; evEndDateInput.value = "";
  renderCalendar();
});

function deleteEvent(id) { dbDeleteEvent(id); renderCalendar(); }

/* ---------------- backup import/export (generic — no course data hard-coded here) ---------------- */
function exportBackup() {
  const data = {
    exportedAt: new Date().toISOString(),
    courses: dbGetCourses(),
    events: dbGetEvents(),
    records: dbGetRecords()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "study_timer_backup.json"; a.click();
  URL.revokeObjectURL(url);
}

// Imported study-log records are matched against existing ones by course+date+time
// range rather than inserted blindly: an exact-duplicate range is skipped, an
// overlapping/adjacent range is merged into their union (so 1–2pm existing +
// 1–3pm imported becomes one 1–3pm record), and a genuinely new range is added as-is.
function importRecordsMerged(incomingRecords) {
  let added = 0, merged = 0, skipped = 0;
  incomingRecords.forEach(r => {
    if (!r.startTime || !r.endTime) {
      dbAddRecord({
        course: r.course, date: r.date, seconds: r.seconds, note: r.note || "",
        savedAt: r.savedAt || new Date().toISOString(), startTime: r.startTime, endTime: r.endTime,
        breaks: r.breaks || []
      });
      added++;
      return;
    }
    const rStart = new Date(r.startTime).getTime();
    const rEnd = new Date(r.endTime).getTime();
    const sameDayCourse = dbGetRecords().filter(e => e.course === r.course && e.date === r.date && e.startTime && e.endTime);
    const overlapping = sameDayCourse.filter(e => {
      const eStart = new Date(e.startTime).getTime();
      const eEnd = new Date(e.endTime).getTime();
      return rStart <= eEnd && eStart <= rEnd; // overlapping or touching ranges
    });

    if (overlapping.length === 0) {
      dbAddRecord({
        course: r.course, date: r.date, seconds: r.seconds, note: r.note || "",
        savedAt: r.savedAt || new Date().toISOString(), startTime: r.startTime, endTime: r.endTime,
        breaks: r.breaks || []
      });
      added++;
      return;
    }
    const isExactDuplicate = overlapping.length === 1 &&
      new Date(overlapping[0].startTime).getTime() === rStart &&
      new Date(overlapping[0].endTime).getTime() === rEnd;
    if (isExactDuplicate) { skipped++; return; }

    let minStart = rStart, maxEnd = rEnd;
    const notes = new Set(r.note ? [r.note] : []);
    let earliestSavedAt = r.savedAt || new Date().toISOString();
    const mergedBreaks = Array.isArray(r.breaks) ? [...r.breaks] : [];
    overlapping.forEach(e => {
      minStart = Math.min(minStart, new Date(e.startTime).getTime());
      maxEnd = Math.max(maxEnd, new Date(e.endTime).getTime());
      if (e.note) notes.add(e.note);
      if (e.savedAt && e.savedAt < earliestSavedAt) earliestSavedAt = e.savedAt;
      if (Array.isArray(e.breaks)) mergedBreaks.push(...e.breaks);
      dbDeleteRecord(e.id);
    });
    dbAddRecord({
      course: r.course, date: r.date, seconds: Math.round((maxEnd - minStart) / 1000),
      note: Array.from(notes).join(" / "), savedAt: earliestSavedAt,
      startTime: new Date(minStart).toISOString(), endTime: new Date(maxEnd).toISOString(),
      breaks: mergedBreaks
    });
    merged++;
  });
  return { added, merged, skipped };
}

// Tidy up one schedule item from an imported file (which may have been written by hand or by
// another AI tool). Returns null when it can't be used. Files exported by this app pass unchanged.
function normalizeImportedEvent(raw, usedIds) {
  if (!raw || typeof raw !== "object") return null;
  const course = typeof raw.course === "string" ? raw.course.trim() : "";
  if (!course) return null;
  const type = raw.type === "recurring" || raw.type === "oneoff" ? raw.type : null;
  if (!type) return null;
  const toMin = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2], total = h * 60 + mi;
    return mi < 60 && total <= 24 * 60 ? total : null;
  };
  const fmt = (min) => String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
  const a = toMin(raw.start), b = toMin(raw.end);
  if (a === null || b === null || a >= b) return null;
  const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const ev = {
    id: raw.id !== undefined && raw.id !== null && String(raw.id) !== "" ? String(raw.id) : "",
    course,
    kind: ["class", "officehour", "activity", "exam"].includes(raw.kind) ? raw.kind : "class",
    type, start: fmt(a), end: fmt(b),
    loc: typeof raw.loc === "string" ? raw.loc : ""
  };
  if (type === "recurring") {
    if (!Number.isInteger(raw.day) || raw.day < 0 || raw.day > 6) return null;
    ev.day = raw.day;
    if (isDate(raw.startDate)) ev.startDate = raw.startDate;
    if (isDate(raw.endDate)) ev.endDate = raw.endDate;
    if (ev.startDate && ev.endDate && ev.endDate < ev.startDate) return null;
    if (Array.isArray(raw.excludeDates)) { const x = raw.excludeDates.filter(isDate); if (x.length) ev.excludeDates = x; }
  } else {
    if (!isDate(raw.date)) return null;
    ev.date = raw.date;
  }
  if (!ev.id) { // no id in the file: make one that is not taken yet
    let n = 0; do { ev.id = "imp-" + Date.now().toString(36) + "-" + (n++); } while (usedIds && usedIds.has(ev.id));
  }
  return ev;
}

function importBackupFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (err) {
      showModal(`<h3>${t("imp.failTitle")}</h3><p>${t("imp.failMsg", { err: escapeHtml(err.message) })}</p><div class="modal-actions"><button class="btn-outline small" id="modalOkBtn">${t("common.close")}</button></div>`);
      document.getElementById("modalOkBtn").addEventListener("click", hideModal);
      return;
    }
    const existingEventIds = dbGetAllEventIds();
    let addedCourses = 0, addedEvents = 0, skippedEvents = 0;

    (Array.isArray(data.courses) ? data.courses : []).forEach(c => {
      if (typeof c === "string" && c.trim()) { dbAddCourse(c.trim()); addedCourses++; }
    });
    let invalidEvents = 0;
    // Same item already in the schedule (even under another id) counts as already existing.
    const sig = (e) => [e.course, e.kind || "class", e.type, e.type === "recurring" ? e.day : e.date, e.start, e.end, e.startDate || "", e.endDate || ""].join("|");
    const existingSigs = new Set(dbGetEvents().map(sig));
    (Array.isArray(data.events) ? data.events : []).forEach(raw => {
      const ev = normalizeImportedEvent(raw, existingEventIds);
      if (!ev) { invalidEvents++; return; }
      if (existingEventIds.has(ev.id) || existingSigs.has(sig(ev))) { skippedEvents++; return; }
      existingSigs.add(sig(ev));
      dbAddCourse(ev.course);
      dbAddEvent(ev);
      existingEventIds.add(ev.id);
      addedEvents++;
    });
    const { added: addedRecords, merged: mergedRecords, skipped: skippedRecords } = importRecordsMerged(data.records || []);

    renderCourseOptions(); renderRecords(); renderCalendar();
    showModal(`
      <h3>${t("imp.doneTitle")}</h3>
      <p>${t("imp.line1", { c: addedCourses, e: addedEvents, skip: (skippedEvents ? t("imp.skipped", { n: skippedEvents }) : "") + (invalidEvents ? t("imp.invalid", { n: invalidEvents }) : "") })}<br>
      ${t("imp.line2", { a: addedRecords, m: mergedRecords, s: skippedRecords })}</p>
      <div class="modal-actions"><button class="btn-primary small" id="modalOkBtn">${t("common.ok")}</button></div>
    `);
    document.getElementById("modalOkBtn").addEventListener("click", hideModal);
  };
  reader.readAsText(file);
}

document.getElementById("exportBackupBtn").addEventListener("click", exportBackup);
document.getElementById("importBackupBtn").addEventListener("click", () => document.getElementById("importBackupInput").click());
document.getElementById("importBackupInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) importBackupFile(file);
  e.target.value = "";
});

function showEventDetail(ev) {
  const kind = ev.kind || "class";
  const kindLabel = t("kind." + (["officehour", "activity", "exam"].includes(kind) ? kind : "class"));
  const rangeLabel = ev.type === "recurring" && (ev.startDate || ev.endDate)
    ? t("ev.range", { from: ev.startDate || "…", to: ev.endDate || "…" }) : "";
  const whenLabel = ev.type === "recurring" ? t("ev.whenRecurring", { day: DAY_NAMES[ev.day], range: rangeLabel }) : t("ev.whenOneoff", { date: ev.date });
  showModal(`
    <h3>${escapeHtml(ev.course)}</h3>
    <div class="modal-detail-row"><span class="label">${t("ev.type")}</span>${kindLabel}</div>
    <div class="modal-detail-row"><span class="label">${t("ev.time")}</span>${t("ev.timeVal", { time: `${ev.start}–${ev.end}`, when: whenLabel })}</div>
    ${ev.loc ? `<div class="modal-detail-row"><span class="label">${t("ev.loc")}</span>${escapeHtml(ev.loc)}</div>` : ""}
    <div class="modal-actions">
      <button class="btn-outline small" id="modalCloseBtn">${t("common.close")}</button>
      <button class="btn-outline small" id="modalEditEvBtn">${t("common.edit")}</button>
      <button class="btn-danger small" id="modalDeleteEvBtn">${t("ev.deleteBtn")}</button>
    </div>
  `);
  document.getElementById("modalCloseBtn").addEventListener("click", hideModal);
  document.getElementById("modalEditEvBtn").addEventListener("click", () => editEventModal(ev));
  document.getElementById("modalDeleteEvBtn").addEventListener("click", () => {
    deleteEvent(ev.id);
    hideModal();
  });
}

function editEventModal(ev) {
  const kind = ev.kind || "class";
  const kindOptions = ["class", "officehour", "activity", "exam"].map(v => [v, t("kind." + v)]).map(([v, label]) => `<option value="${v}" ${kind === v ? "selected" : ""}>${label}</option>`).join("");
  const dayOptions = DAY_NAMES.map((n, i) => `<option value="${i}" ${ev.day === i ? "selected" : ""}>${n}</option>`).join("");
  const isRecurring = ev.type === "recurring";

  showModal(`
    <h3>${t("ee.title")}</h3>
    <label class="form-label">${t("form.course")}</label>
    <input type="text" id="modalEvCourse" value="${escapeHtml(ev.course)}">
    <label class="form-label">${t("form.type")}</label>
    <select id="modalEvKind">${kindOptions}</select>
    <label style="display:flex; gap:14px; font-size:13px; margin:10px 0;">
      <label><input type="radio" name="modalEvType" value="recurring" ${isRecurring ? "checked" : ""}> ${t("ee.recurring")}</label>
      <label><input type="radio" name="modalEvType" value="oneoff" ${!isRecurring ? "checked" : ""}> ${t("ee.oneoff")}</label>
    </label>
    <div id="modalEvDayWrap" style="display:${isRecurring ? "block" : "none"};">
      <label class="form-label">${t("form.day")}</label>
      <select id="modalEvDay">${dayOptions}</select>
    </div>
    <div id="modalEvDateWrap" style="display:${isRecurring ? "none" : "block"};">
      <label class="form-label">${t("form.date")}</label>
      <input type="date" id="modalEvDate" value="${ev.date || ""}">
    </div>
    <div id="modalEvRangeWrap" style="display:${isRecurring ? "block" : "none"};">
      <label class="form-label">${t("ee.range")}</label>
      <div class="row" style="gap:8px; flex-wrap:nowrap; margin-bottom:10px;">
        <input type="date" id="modalEvStartDate" value="${ev.startDate || ""}" style="flex:1; min-width:0;">
        <span style="color:var(--muted);">~</span>
        <input type="date" id="modalEvEndDate" value="${ev.endDate || ""}" style="flex:1; min-width:0;">
      </div>
    </div>
    <label class="form-label">${t("form.start")}</label>
    <input type="time" id="modalEvStart" value="${ev.start}">
    <label class="form-label">${t("form.end")}</label>
    <input type="time" id="modalEvEnd" value="${ev.end}">
    <label class="form-label">${t("ev.loc")}</label>
    <input type="text" id="modalEvLoc" value="${escapeHtml(ev.loc || "")}">
    <p id="modalEvError" style="color:var(--danger); display:none;"></p>
    <div class="modal-actions">
      <button class="btn-outline small" id="modalEvCancelBtn">${t("common.cancel")}</button>
      <button class="btn-primary small" id="modalEvSaveBtn">${t("common.save")}</button>
    </div>
  `);
  document.querySelectorAll('input[name="modalEvType"]').forEach(r => {
    r.addEventListener("change", () => {
      const recurring = document.querySelector('input[name="modalEvType"]:checked').value === "recurring";
      document.getElementById("modalEvDayWrap").style.display = recurring ? "block" : "none";
      document.getElementById("modalEvDateWrap").style.display = recurring ? "none" : "block";
      document.getElementById("modalEvRangeWrap").style.display = recurring ? "block" : "none";
    });
  });
  document.getElementById("modalEvCancelBtn").addEventListener("click", () => showEventDetail(ev));
  document.getElementById("modalEvSaveBtn").addEventListener("click", () => {
    const course = document.getElementById("modalEvCourse").value.trim();
    const newKind = document.getElementById("modalEvKind").value;
    const type = document.querySelector('input[name="modalEvType"]:checked').value;
    const start = document.getElementById("modalEvStart").value;
    const end = document.getElementById("modalEvEnd").value;
    const loc = document.getElementById("modalEvLoc").value.trim();
    const errorEl = document.getElementById("modalEvError");
    const showError = (msg) => { errorEl.textContent = msg; errorEl.style.display = "block"; };
    if (!course) { showError(t("ee.errName")); return; }
    if (!start || !end) { showError(t("err.times")); return; }

    const updated = { course, kind: newKind, type, start, end, loc };
    if (type === "recurring") {
      updated.day = parseInt(document.getElementById("modalEvDay").value, 10);
      const sd = document.getElementById("modalEvStartDate").value, ed = document.getElementById("modalEvEndDate").value;
      if (sd && ed && ed < sd) { showError(t("err.range")); return; }
      if (sd) updated.startDate = sd;
      if (ed) updated.endDate = ed;
    } else {
      const dateVal = document.getElementById("modalEvDate").value;
      if (!dateVal) { showError(t("err.date")); return; }
      updated.date = dateVal;
      updated.day = (new Date(dateVal + "T00:00:00").getDay() + 6) % 7;
    }
    dbAddCourse(course);
    renderCourseOptions();
    dbUpdateEvent(ev.id, updated);
    renderCalendar();
    hideModal();
  });
}

function showLogDetail(recordId) {
  const r = dbGetRecords().find(x => x.id === recordId);
  if (!r) return;
  const clockRange = (r.startTime && r.endTime) ? `${formatClock(r.startTime)}–${formatClock(r.endTime)}` : t("log.noClock");
  const breaks = r.breaks || [];
  let breaksHtml = "";
  if (breaks.length) {
    const totalBreakSec = breaks.reduce((sum, b) => sum + Math.max(0, (new Date(b.end || b.start) - new Date(b.start)) / 1000), 0);
    const rows = breaks.map(b => `${formatClock(b.start)}–${b.end ? formatClock(b.end) : "…"}`).join(t("log.sep"));
    breaksHtml = `<div class="modal-detail-row"><span class="label">${t("log.breaks")}</span>${t("log.breaksVal", { rows, total: formatSeconds(Math.round(totalBreakSec)) })}</div>`;
  }
  showModal(`
    <h3>${t("log.title", { course: escapeHtml(r.course) })}</h3>
    <div class="modal-detail-row"><span class="label">${t("log.date")}</span>${r.date}</div>
    <div class="modal-detail-row"><span class="label">${breaks.length ? t("log.rangeBreaks") : t("log.range")}</span>${clockRange}</div>
    ${breaksHtml}
    <div class="modal-detail-row"><span class="label">${t("log.actual")}</span>${formatSeconds(r.seconds)}</div>
    ${r.note ? `<div class="modal-detail-row"><span class="label">${t("log.note")}</span>${escapeHtml(r.note)}</div>` : ""}
    <div class="modal-actions">
      <button class="btn-outline small" id="modalCloseBtn">${t("common.close")}</button>
      <button class="btn-outline small" id="modalEditCourseBtn">${t("log.editCourse")}</button>
      <button class="btn-outline small" id="modalEditNoteBtn">${t("rec.editNote")}</button>
      <button class="btn-danger small" id="modalDeleteLogBtn">${t("log.delete")}</button>
    </div>
  `);
  document.getElementById("modalCloseBtn").addEventListener("click", hideModal);
  document.getElementById("modalEditCourseBtn").addEventListener("click", () => editRecordCourse(recordId));
  document.getElementById("modalEditNoteBtn").addEventListener("click", () => editRecordNote(recordId));
  document.getElementById("modalDeleteLogBtn").addEventListener("click", () => {
    deleteRecord(recordId);
    hideModal();
    renderCalendar();
  });
}

function renderCalendar() {
  const events = dbGetEvents();
  const records = dbGetRecords();

  // Build day-accurate log segments from each record's real start/end timestamps
  // (not the record's `date` field) — a session that crosses midnight is split into
  // two segments, one on each actual calendar day, so it never gets misplaced onto
  // a day it didn't happen on.
  const logSegments = [];
  if (calPrefs.showLog) {
    records.forEach(r => {
      if (!r.startTime || !r.endTime) return;
      const startDateKey = isoLocalDate(r.startTime);
      const endDateKey = isoLocalDate(r.endTime);
      const fullStartMs = new Date(r.startTime).getTime();
      const fullEndMs = new Date(r.endTime).getTime();
      if (startDateKey === endDateKey) {
        logSegments.push({
          id: "log-" + r.id, dateKey: startDateKey, course: r.course, kind: "log", type: "oneoff",
          start: formatClock(r.startTime), end: formatClock(r.endTime), loc: r.note, recordId: r.id,
          segStartMs: fullStartMs, segEndMs: fullEndMs, breaks: r.breaks || []
        });
      } else {
        const midnight = new Date(startDateKey + "T00:00:00");
        midnight.setDate(midnight.getDate() + 1);
        const midnightMs = midnight.getTime();
        logSegments.push({
          id: "log-" + r.id + "-a", dateKey: startDateKey, course: r.course, kind: "log", type: "oneoff",
          start: formatClock(r.startTime), end: "24:00", loc: r.note, recordId: r.id,
          segStartMs: fullStartMs, segEndMs: midnightMs, breaks: r.breaks || []
        });
        logSegments.push({
          id: "log-" + r.id + "-b", dateKey: endDateKey, course: r.course, kind: "log", type: "oneoff",
          start: "00:00", end: formatClock(r.endTime), loc: r.note, recordId: r.id,
          segStartMs: midnightMs, segEndMs: fullEndMs, breaks: r.breaks || []
        });
      }
    });
  }

  const monday = getMondayOf(new Date());
  monday.setDate(monday.getDate() + weekOffset * 7);
  const weekDates = [];
  for (let i = 0; i < 7; i++) { const d = new Date(monday); d.setDate(monday.getDate() + i); weekDates.push(d); }
  const sunday = weekDates[6];
  weekLabel.textContent = `${fmtDate(monday)} ~ ${fmtDate(sunday)}` + (weekOffset === 0 ? t("cal.thisWeek") : "");
  const todayKey = fmtDate(new Date());

  let headerHtml = `<div></div>`;
  weekDates.forEach((d, i) => {
    const isToday = fmtDate(d) === todayKey;
    headerHtml += `<div class="cal-header-cell${isToday ? " today" : ""}">${DAY_NAMES[i]}<br>${d.getMonth() + 1}/${d.getDate()}</div>`;
  });
  calHeaderRow.innerHTML = headerHtml;

  const totalHeight = minutesToY(DAY_END_HOUR * 60);
  let axisHtml = "";
  for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
    axisHtml += `<div class="hour-label" style="top:${minutesToY(h * 60)}px;">${h}:00</div>`;
  }
  calTimeAxis.style.height = totalHeight + "px";
  calTimeAxis.innerHTML = axisHtml;
  calDays.style.height = totalHeight + "px";

  calDays.innerHTML = "";
  const gridlines = document.createElement("div");
  gridlines.style.cssText = "position:absolute; inset:0; pointer-events:none;";
  for (let h = DAY_START_HOUR; h <= DAY_END_HOUR; h++) {
    const line = document.createElement("div");
    line.style.cssText = `position:absolute; left:0; right:0; top:${minutesToY(h * 60)}px; height:1px; background:var(--border);`;
    gridlines.appendChild(line);
  }
  calDays.appendChild(gridlines);

  weekDates.forEach((d, dayIdx) => {
    const dateKey = fmtDate(d);
    const col = document.createElement("div");
    col.className = "cal-daycol";
    col.style.height = totalHeight + "px";

    const dayEvents = events.filter(ev => {
      if (ev.type === "recurring") {
        if (ev.day !== dayIdx) return false;
        if (ev.startDate && dateKey < ev.startDate) return false;
        if (ev.endDate && dateKey > ev.endDate) return false;
        if (ev.excludeDates && ev.excludeDates.includes(dateKey)) return false;
      } else {
        if (ev.date !== dateKey) return false;
      }
      const kind = ev.kind || "class";
      if (kind === "officehour" && !calPrefs.showOH) return false;
      if (kind === "activity" && !calPrefs.showActivity) return false;
      return true;
    });

    const logEvents = logSegments.filter(seg => seg.dateKey === dateKey);

    const laidOut = computeDayLayout(dayEvents.concat(logEvents));
    laidOut.forEach(ev => {
      const kind = ev.kind || "class";
      const isLog = kind === "log";
      const hue = courseHue(ev.course);
      const top = pixelTop(ev.start);
      const height = Math.max(pixelHeight(ev.start, ev.end) - 2, 32);
      const totalCols = ev._totalCols || 1;
      const colWidth = 100 / totalCols;
      const block = document.createElement("div");
      block.className = `cal-event-block kind-${kind}`;
      block.style.top = top + "px";
      block.style.height = height + "px";
      block.style.left = `calc(${ev._col * colWidth}% + 2px)`;
      block.style.width = `calc(${colWidth}% - 4px)`;
      if (isLog) {
        block.style.background = "#7C5CFC";
        block.style.color = "#fff";
        block.style.boxShadow = "0 1px 4px rgba(124,92,252,0.4)";
      } else {
        block.style.background = `hsl(${hue}, 55%, ${kind === "class" ? "87%" : "93%"})`;
        block.style.color = `hsl(${hue}, 50%, 24%)`;
      }
      block.style.setProperty("--accent", isLog ? "#5b3fd9" : `hsl(${hue}, 90%, 40%)`);
      block.innerHTML = `
        ${isLog ? "" : `<span class="ev-del" onclick="deleteEvent('${ev.id}')">✕</span>`}
        <div class="ev-time">${ev.start}-${ev.end}</div>
        <div class="ev-course">${escapeHtml(ev.course)}${kind === "officehour" ? t("tag.oh") : kind === "activity" ? t("tag.activity") : kind === "exam" ? t("tag.exam") : isLog ? t("tag.log") : ""}</div>
        ${ev.loc ? `<div class="ev-loc">${escapeHtml(ev.loc)}</div>` : ""}
      `;
      // A paused (暂停) stretch inside this study block is kept as one continuous
      // block (start → final stop), but the paused portion is marked with a
      // hatched stripe rather than silently shrinking the block.
      if (isLog && ev.breaks && ev.breaks.length && ev.segEndMs > ev.segStartMs) {
        ev.breaks.forEach(b => {
          const bs = Math.max(new Date(b.start).getTime(), ev.segStartMs);
          const be = Math.min(new Date(b.end || b.start).getTime(), ev.segEndMs);
          if (be <= bs) return;
          const topPct = (bs - ev.segStartMs) / (ev.segEndMs - ev.segStartMs) * 100;
          const heightPct = (be - bs) / (ev.segEndMs - ev.segStartMs) * 100;
          const stripe = document.createElement("div");
          stripe.className = "log-break-stripe";
          stripe.style.top = topPct + "%";
          stripe.style.height = heightPct + "%";
          stripe.title = t("stripe.title");
          block.appendChild(stripe);
        });
      }
      col.appendChild(block);
      block.addEventListener("dblclick", () => isLog ? showLogDetail(ev.recordId) : showEventDetail(ev));
    });
    calDays.appendChild(col);
  });
}

/* ================= SETTINGS: Claude API key ================= */
// The key is stored only in this browser's local database (the `prefs` table), next
// to your other data. It is never part of the JSON/CSV exports and is never sent
// anywhere except directly to Anthropic when an AI feature is used.
const API_KEY_PREF = "anthropicApiKey";

function getApiKey() { return dbGetPref(API_KEY_PREF, ""); }
function setApiKey(key) { dbSetPref(API_KEY_PREF, key); }
function clearApiKey() { run("DELETE FROM prefs WHERE key = ?", [API_KEY_PREF]); }
function maskKey(key) {
  if (!key) return "";
  return key.length <= 12 ? "••••" : `${key.slice(0, 7)}••••${key.slice(-4)}`;
}

document.getElementById("settingsBtn").addEventListener("click", showSettingsModal);

function showSettingsModal() {
  const current = getApiKey();
  const statusHtml = current
    ? `<span style="color:#2e7d32; font-weight:700;">${t("set.on")}</span>　<code>${escapeHtml(maskKey(current))}</code>`
    : `<span style="color:var(--muted); font-weight:700;">${t("set.off")}</span>`;

  modalCard.style.maxWidth = "460px";
  showModal(`
    <h3>${t("set.title")}</h3>
    <div class="modal-detail-row"><span class="label">${t("set.keyLabel")}</span>${statusHtml}</div>
    <input type="password" id="modalApiKeyInput" placeholder="${escapeAttr(t("set.keyPh"))}" autocomplete="off" spellcheck="false">
    <p id="modalApiKeyError" style="color:var(--danger); display:none; margin-top:-6px;"></p>
    <p style="margin-top:-4px;">
      ${t("set.help1")}
    </p>
    <p style="margin-top:-6px;">
      ${t("set.help2")}
    </p>
    <div class="modal-actions">
      <button class="btn-outline small" id="modalSettingsCloseBtn">${t("common.close")}</button>
      ${current ? `<button class="btn-danger small" id="modalApiKeyClearBtn">${t("set.clear")}</button>` : ""}
      <button class="btn-primary small" id="modalApiKeySaveBtn">${t("common.save")}</button>
    </div>
  `);

  document.getElementById("modalSettingsCloseBtn").addEventListener("click", hideModal);
  if (current) {
    document.getElementById("modalApiKeyClearBtn").addEventListener("click", () => {
      clearApiKey();
      showSettingsModal();
    });
  }
  document.getElementById("modalApiKeySaveBtn").addEventListener("click", () => {
    const val = document.getElementById("modalApiKeyInput").value.trim();
    const errorEl = document.getElementById("modalApiKeyError");
    const showError = (msg) => { errorEl.textContent = msg; errorEl.style.display = "block"; };
    if (!val) { showError(t("set.errEmpty")); return; }
    if (!val.startsWith("sk-ant-")) { showError(t("set.errPrefix")); return; }
    if (/\s/.test(val)) { showError(t("set.errSpace")); return; }
    setApiKey(val);
    showSettingsModal();
  });
}

/* ================= init ================= */
async function init() {
  const statusEl = document.getElementById("dbStatus");
  try {
    await initDatabase();
    statusEl.textContent = t("db.ok");
  } catch (err) {
    statusEl.textContent = t("db.fail", { err: err.message });
    console.error(err);
    return;
  }

  calPrefs = {
    showOH: dbGetPref("showOH", false),
    showActivity: dbGetPref("showActivity", false),
    showLog: dbGetPref("showLog", true),
    expandCompressed: dbGetPref("expandCompressed", false)
  };
  toggleOH.checked = calPrefs.showOH;
  toggleActivity.checked = calPrefs.showActivity;
  toggleLog.checked = calPrefs.showLog;
  toggleExpand.checked = calPrefs.expandCompressed;

  timerState = dbGetTimerState();

  renderCourseOptions();
  setButtonsForState();
  updateDisplay();
  renderRecords();
  renderCalendar();
  if (timerState && timerState.running) startTicking();
}

// Language selector (switching reloads the page; the running timer is kept in the database).
// (The single-language download packages ship without the selector.)
const langSelect = document.getElementById("langSelect");
if (langSelect) {
  I18N_AVAILABLE.forEach(l => {
    const o = document.createElement("option");
    o.value = l; o.textContent = I18N_LANG_NAMES[l]; o.selected = (l === I18N_LANG);
    langSelect.appendChild(o);
  });
  langSelect.addEventListener("change", () => setLang(langSelect.value));
}

window.addEventListener("beforeunload", (e) => {
  if (timerState && !window.skipUnloadWarning) { e.preventDefault(); e.returnValue = ""; }
});

init();
