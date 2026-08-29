/* =========================================================================
   firebase.js
   -------------------------------------------------------------------------
   Initializes the Firebase app and exposes the database + auth objects.

   >>> IMPORTANT <<<
   Replace the placeholder values in `firebaseConfig` below with the
   configuration from your own Firebase project:
     Firebase Console -> Project Settings -> Your apps -> Web app
   ========================================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyAeoScw5UK53ElBnNdhtJVAETb3_isOEKs",
  authDomain: "fram-and-go.firebaseapp.com",
  databaseURL: "https://fram-and-go-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "fram-and-go",
  storageBucket: "fram-and-go.firebasestorage.app",
  messagingSenderId: "781295119002",
  appId: "1:781295119002:web:4be2d54934395b491c0d23",
  measurementId: "G-TKPPF986Z0"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Realtime Database + Auth handles shared across all pages
const db = firebase.database();
const auth = firebase.auth();

/* -------------------------------------------------------------------------
   Server time helpers
   -------------------------------------------------------------------------
   We cannot trust the browser clock alone. Firebase exposes
   `/.info/serverTimeOffset` which is the difference (in ms) between the
   server's time and the device's time. We use it so that the match timer
   stays accurate even when the admin's or viewer's device clock is wrong.
   ------------------------------------------------------------------------- */

let SERVER_TIME_OFFSET = 0;

// Keep the offset up to date for the lifetime of the page.
db.ref("/.info/serverTimeOffset").on("value", (snap) => {
  SERVER_TIME_OFFSET = snap.val() || 0;
});

// Returns the best estimate of the current Firebase server time (ms).
function getServerTime() {
  return Date.now() + SERVER_TIME_OFFSET;
}

/* -------------------------------------------------------------------------
   Small shared helpers used by every page
   ------------------------------------------------------------------------- */

// Short id generator (good enough for client-side keys)
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Format a number of seconds as mm:ss
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
}

// Convert a Firebase timestamp (ms) or date string to a readable time
function formatTime(ts) {
  if (!ts) return "--:--";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Convert a Firebase timestamp (ms) or date string to a readable date
function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

// Escape user provided strings before inserting into innerHTML
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Show a simple toast/error message. Pages can override #toast element.
function showToast(message, isError) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.className = "toast";
  }, 3500);
}

/* -------------------------------------------------------------------------
   Admin action log
   -------------------------------------------------------------------------
   Records notable admin actions (goal added, match started, etc.) so the
   dashboard can show a recent-activity feed. Stored at /adminLog.
   ------------------------------------------------------------------------- */
function logAdminAction(text) {
  const entry = { text: text, timestamp: firebase.database.ServerValue.TIMESTAMP };
  return db.ref("adminLog").push(entry).catch((e) => console.error("log failed", e));
}

/* -------------------------------------------------------------------------
   Standings recomputation
   -------------------------------------------------------------------------
   Recomputes the whole standings table for a tournament from its FINISHED
   matches and writes it back to /standings/<tournamentId>.
   Points: win = 3, draw = 1, loss = 0.  GD = GF - GA.
   ------------------------------------------------------------------------- */
function recomputeStandings(tournamentId) {
  // Load both the tournament's matches and all teams (for group info).
  return Promise.all([
    db.ref("matches").orderByChild("tournamentId").equalTo(tournamentId).once("value"),
    db.ref("teams").once("value")
  ]).then(([msnap, tsnap]) => {
    const matches = msnap.val() || {};
    const teams = tsnap.val() || {};
    const table = {};

    // Initialise every team that appears in this tournament's matches,
    // carrying over its group name.
    Object.keys(matches).forEach((mid) => {
      const m = matches[mid];
      [m.teamA, m.teamB].forEach((tid) => {
        if (tid && !table[tid]) {
          table[tid] = {
            group: (teams[tid] && teams[tid].group) || "",
            played: 0, wins: 0, draws: 0, losses: 0,
            goalsFor: 0, goalsAgainst: 0
          };
        }
      });
    });

    // Tally only FINISHED matches.
    Object.keys(matches).forEach((mid) => {
      const m = matches[mid];
      if (m.status !== "Finished") return;
      const a = m.teamA, b = m.teamB;
      if (!a || !b || !table[a] || !table[b]) return;
      const sa = Number(m.scoreA) || 0, sb = Number(m.scoreB) || 0;
      table[a].played++; table[b].played++;
      table[a].goalsFor += sa; table[a].goalsAgainst += sb;
      table[b].goalsFor += sb; table[b].goalsAgainst += sa;
      if (sa > sb) { table[a].wins++; table[b].losses++; }
      else if (sb > sa) { table[b].wins++; table[a].losses++; }
      else { table[a].draws++; table[b].draws++; }
    });

    const updates = {};
    Object.keys(table).forEach((t) => {
      const r = table[t];
      r.goalDifference = r.goalsFor - r.goalsAgainst;
      r.points = r.wins * 3 + r.draws;
      updates["standings/" + tournamentId + "/" + t] = r;
    });
    return db.ref().update(updates);
  });
}
