/* =========================================================================
   match.js
   -------------------------------------------------------------------------
   Renders a single match page (match.html?m=<matchId>) for the PUBLIC and,
   when an admin is signed in, also powers the LIVE CONTROL panel.

   The clock is always derived from the stored timer timestamps (timer.js),
   so it survives refreshes and connection drops.
   ========================================================================= */

const params = new URLSearchParams(location.search);
const MATCH_ID = params.get("m");
let teamsMap = {};
let matchData = null;
let isAdmin = false;
let myTournament = null;

const EVENT_ICON = {
  Goal: "⚽", "Yellow Card": "🟨", "Red Card": "🟥",
  Substitution: "🔄", "Half Time": "⏸", "Second Half": "▶",
  "Full Time": "🏁", Other: "📝"
};

function placeholderLogo(name) {
  const initials = (name || "?").slice(0, 2).toUpperCase();
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'>` +
    `<rect width='100' height='100' rx='50' fill='#1e2a36'/>` +
    `<text x='50' y='60' font-size='38' fill='#2ecc71' text-anchor='middle' ` +
    `font-family='Arial' font-weight='bold'>${initials}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function teamImg(teamId) {
  const t = teamsMap[teamId];
  return (t && t.logo) ? t.logo : placeholderLogo(t ? t.name : "?");
}
function teamName(teamId) {
  const t = teamsMap[teamId];
  return t ? t.name : "TBD";
}

document.addEventListener("DOMContentLoaded", () => {
  if (!MATCH_ID) {
    showToast("No match specified.", true);
    return;
  }

  // Teams for names/logos.
  db.ref("teams").on("value", (snap) => {
    teamsMap = snap.val() || {};
    if (matchData) renderMatch();
  });

  // Live match data.
  db.ref("matches/" + MATCH_ID).on("value", (snap) => {
    matchData = snap.val() || {};
    myTournament = matchData.tournamentId;
    const stageTxt = matchData.stage ? matchData.stage + " · " : "";
    document.getElementById("matchTitle").textContent =
      stageTxt + teamName(matchData.teamA) + " vs " + teamName(matchData.teamB);
    renderMatch();
    renderControl();
  });

  // Live events.
  db.ref("matches/" + MATCH_ID + "/events").on("value", (snap) => {
    const evs = snap.val() || {};
    const list = Object.keys(evs).map((k) => ({ id: k, ...evs[k] }));
    renderEvents(list);
  });

  // Determine admin state.
  auth.onAuthStateChanged((user) => {
    isAdmin = !!user;
    const panel = document.getElementById("adminPanel");
    const toggle = document.getElementById("adminToggle");
    if (isAdmin) {
      panel.style.display = "block";
      toggle.textContent = "Dashboard";
      toggle.href = "admin.html";
    } else {
      panel.style.display = "none";
      toggle.textContent = "Admin";
      toggle.href = "login.html";
    }
  });

  // Tick the clocks from stored timestamps.
  Timer.startTicking(renderClocks);
});

// ---- public rendering ----------------------------------------------------

function renderMatch() {
  if (!matchData) return;
  const a = matchData.teamA, b = matchData.teamB;
  document.getElementById("teamALogo").src = teamImg(a);
  document.getElementById("teamBLogo").src = teamImg(b);
  document.getElementById("teamAName").textContent = teamName(a);
  document.getElementById("teamBName").textContent = teamName(b);
  document.getElementById("scoreA").textContent = matchData.scoreA || 0;
  document.getElementById("scoreB").textContent = matchData.scoreB || 0;

  // Live badge
  const badge = document.getElementById("liveBadge");
  if (matchData.status === "Live") {
    badge.innerHTML = `<span class="live-badge"><span class="live-dot"></span> LIVE</span>`;
  } else if (matchData.status) {
    badge.innerHTML = `<span class="badge ${matchData.status === "Finished" ? "finished" : matchData.status === "Half Time" ? "halftime" : matchData.status === "Paused" ? "paused" : "scheduled"}">${esc(matchData.status)}</span>`;
  } else {
    badge.innerHTML = "";
  }
  document.getElementById("bigStatus").textContent =
    (matchData.stage ? matchData.stage + " · " : "") + (matchData.status || "Scheduled");
  const kick = matchData.scheduledTime ? "Kickoff: " + formatLocalTime(matchData.scheduledTime) : "";
  document.getElementById("matchDuration").textContent =
    (kick ? kick + (matchData.duration ? "  ·  " : "") : "") +
    (matchData.duration ? "Duration: " + matchData.duration + " min" : "");
}

function formatLocalTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getDate()} ${d.toLocaleString([], { month: "short" })}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderClocks() {
  if (!matchData) return;
  const big = document.getElementById("bigClock");
  const cc = document.getElementById("ctrlClock");
  const statusEl = document.getElementById("bigStatus");
  let txt = "00:00";

  if (matchData.status === "Scheduled" && matchData.scheduledTime) {
    // Countdown until the match starts.
    const remain = (matchData.scheduledTime - getServerTime()) / 1000;
    if (!isNaN(remain) && remain > 0) {
      txt = formatClock(remain);
      if (statusEl) statusEl.textContent = "Starts in";
    } else {
      txt = "00:00";
      if (statusEl) statusEl.textContent = "Starting";
    }
  } else if (matchData.status === "Finished") {
    txt = formatClock(Timer.computeElapsed(matchData.timer));
    if (statusEl) statusEl.textContent = "Full Time";
  } else if (matchData.timer) {
    // Live / Paused / Half Time -> elapsed match time.
    txt = formatClock(Timer.computeElapsed(matchData.timer));
  }

  big.textContent = txt;
  if (cc) cc.textContent = txt;
}

function renderEvents(list) {
  const ul = document.getElementById("eventList");
  if (!list || list.length === 0) {
    ul.innerHTML = `<li class="empty">No events yet.</li>`;
    return;
  }
  list.sort((x, y) => (y.timestamp || 0) - (x.timestamp || 0));
  ul.innerHTML = list
    .map((e) => {
      const icon = EVENT_ICON[e.type] || "📝";
      const team = teamName(e.teamId);
      const min = e.minute ? e.minute + "'" : "";
      const who = e.playerName ? esc(e.playerName) : esc(team);
      const del = isAdmin
        ? `<button class="mini-btn danger" style="flex:none; padding:4px 8px;" onclick="deleteEvent('${e.id}')">Delete</button>`
        : "";
      return `
      <li>
        <span class="min">${min}</span>
        <span class="icon">${icon}</span>
        <span class="ev-text">
          <span class="pname">${who}</span>
          ${e.type && e.type !== "Goal" ? `— ${esc(e.type)}` : ""}
          ${e.description ? `<div class="desc">${esc(e.description)}</div>` : ""}
        </span>
        ${del}
      </li>`;
    })
    .join("");
}

// ---- admin control panel -------------------------------------------------

function renderControl() {
  if (!matchData || !isAdmin) return;
  const a = matchData.teamA, b = matchData.teamB;
  document.getElementById("cTeamALogo").src = teamImg(a);
  document.getElementById("cTeamBLogo").src = teamImg(b);
  document.getElementById("cTeamAName").textContent = teamName(a);
  document.getElementById("cTeamBName").textContent = teamName(b);
  document.getElementById("cScoreA").textContent = matchData.scoreA || 0;
  document.getElementById("cScoreB").textContent = matchData.scoreB || 0;
  document.getElementById("optTeamA").textContent = teamName(a);
  document.getElementById("optTeamB").textContent = teamName(b);

  const t = matchData.timer || {};
  const stxt =
    t.status === "running" ? "Running" :
    t.status === "paused" ? "Paused" :
    t.status === "finished" ? "Finished" : "Idle";
  document.getElementById("ctrlStatus").textContent = stxt;
}

// Manually adjust a team's score (never below 0).
function adminScore(side, delta) {
  if (!matchData) return;
  const field = side === "A" ? "scoreA" : "scoreB";
  const teamId = side === "A" ? matchData.teamA : matchData.teamB;
  db.ref("matches/" + MATCH_ID + "/" + field)
    .transaction((cur) => {
      cur = Number(cur) || 0;
      let n = cur + delta;
      return n < 0 ? 0 : n;
    })
    .then(() => logAdminAction("Score changed for " + teamName(teamId)))
    .catch(() => showToast("Score update failed.", true));
}

function writeMatch(patch, logText) {
  db.ref("matches/" + MATCH_ID).update(patch)
    .then(() => { if (logText) logAdminAction(logText); })
    .catch(() => showToast("Update failed.", true));
}

function adminStart() {
  writeMatch(
    { status: "Live", timer: Timer.startPayload() },
    "Match started"
  );
}
function adminPause() {
  if (!matchData.timer) return;
  writeMatch(
    { status: "Paused", timer: Timer.pausePayload(matchData.timer) },
    "Match paused"
  );
}
function adminResume() {
  writeMatch(
    { status: "Live", timer: Timer.resumePayload(matchData.timer) },
    "Match resumed"
  );
}
function adminHalfTime() {
  if (!matchData.timer) return;
  writeMatch(
    { status: "Half Time", timer: Timer.pausePayload(matchData.timer) },
    "Half Time"
  );
}
function adminSecondHalf() {
  writeMatch(
    { status: "Live", timer: Timer.resumePayload(matchData.timer) },
    "Second Half"
  );
}
function adminResetTimer() {
  writeMatch(
    { status: "Scheduled", timer: Timer.resetPayload() },
    "Timer reset"
  );
}
function adminEnd() {
  if (!matchData.timer) return;
  const finished = Timer.endPayload(matchData.timer);
  db.ref("matches/" + MATCH_ID).update({ status: "Finished", timer: finished })
    .then(() => {
      logAdminAction("Match ended");
      if (myTournament) recomputeStandings(myTournament);
    })
    .catch(() => showToast("Failed to end match.", true));
}

// ---- event modal ---------------------------------------------------------

function openEventModal() {
  document.getElementById("eventModal").classList.add("open");
}
function closeEventModal() {
  document.getElementById("eventModal").classList.remove("open");
}

function saveEvent() {
  if (!matchData) return;
  const type = document.getElementById("evType").value;
  const side = document.getElementById("evTeam").value; // A or B
  const teamId = side === "A" ? matchData.teamA : matchData.teamB;
  const playerName = document.getElementById("evPlayer").value.trim();
  const minute = parseInt(document.getElementById("evMinute").value, 10);
  const description = document.getElementById("evDesc").value.trim();

  const event = {
    type: type,
    teamId: teamId,
    playerName: playerName,
    minute: isNaN(minute) ? null : minute,
    description: description,
    timestamp: firebase.database.ServerValue.TIMESTAMP
  };

  db.ref("matches/" + MATCH_ID + "/events").push(event)
    .then(() => {
      // A Goal automatically bumps the team's score.
      if (type === "Goal" && teamId) {
        const field = side === "A" ? "scoreA" : "scoreB";
        db.ref("matches/" + MATCH_ID + "/" + field).transaction((cur) => (Number(cur) || 0) + 1);
        logAdminAction("Goal added for " + teamName(teamId));
      } else {
        logAdminAction(type + " added");
      }
      closeEventModal();
      // reset form
      document.getElementById("evPlayer").value = "";
      document.getElementById("evMinute").value = "";
      document.getElementById("evDesc").value = "";
      showToast("Event added.");
    })
    .catch(() => showToast("Failed to add event.", true));
}

// Delete an event. If it was a Goal, safely undo the score.
function deleteEvent(eventId) {
  if (!confirm("Delete this event?")) return;
  db.ref("matches/" + MATCH_ID + "/events/" + eventId).once("value")
    .then((snap) => {
      const ev = snap.val() || {};
      const removals = [];
      removals.push(db.ref("matches/" + MATCH_ID + "/events/" + eventId).remove());
      if (ev.type === "Goal" && ev.teamId) {
        const side = ev.teamId === matchData.teamA ? "A" : "B";
        const field = side === "A" ? "scoreA" : "scoreB";
        removals.push(
          db.ref("matches/" + MATCH_ID + "/" + field).transaction((cur) =>
            Math.max(0, (Number(cur) || 0) - 1)
          )
        );
      }
      return Promise.all(removals);
    })
    .then(() => logAdminAction("Event deleted"))
    .catch(() => showToast("Failed to delete event.", true));
}
