/* =========================================================================
   public.js
   -------------------------------------------------------------------------
   Drives the public live-score website (index.html).

   Real-time behavior:
     - Listens to the active tournament's matches with onValue().
     - The LIVE NOW clock is recalculated every tick from the stored timer
       timestamps (see timer.js) so it stays correct after refresh.
     - Standings are read live from /standings/<tournamentId>.
     - Recent events are gathered live from every match's /events node.
   ========================================================================= */

let CURRENT_TOURNAMENT = null;
let teamsMap = {};      // teamId -> team object
let tournamentsMap = {}; // tournamentId -> tournament
let matchesMap = {};    // matchId -> match object
let recentEvents = {};  // matchId -> [ {..., matchId} ]
let subscribedEvents = {}; // matchId -> bool (so we only attach once)

const EVENT_ICON = {
  Goal: "⚽", "Yellow Card": "🟨", "Red Card": "🟥",
  Substitution: "🔄", "Half Time": "⏸", "Second Half": "▶",
  "Full Time": "🏁", Other: "📝"
};

// ---- helpers -------------------------------------------------------------

function placeholderLogo(name) {
  const initials = (name || "?").slice(0, 2).toUpperCase();
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'>` +
    `<rect width='100' height='100' rx='50' fill='#1e2a36'/>` +
    `<text x='50' y='60' font-size='38' fill='#2ecc71' text-anchor='middle' ` +
    `font-family='Arial' font-weight='bold'>${initials}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function teamImg(teamId, cls) {
  const t = teamsMap[teamId];
  const logo = (t && t.logo) ? t.logo : placeholderLogo(t ? t.name : "?");
  return `<img src="${logo}" alt="" class="${cls}" />`;
}

function teamName(teamId) {
  const t = teamsMap[teamId];
  return t ? t.name : "TBD";
}

function statusBadge(status) {
  const map = {
    Scheduled: ["scheduled", "Upcoming"],
    Live: ["live", "Live"],
    "Half Time": ["halftime", "Half Time"],
    Paused: ["paused", "Paused"],
    Finished: ["finished", "Final"]
  };
  const [cls, label] = map[status] || ["scheduled", status || "—"];
  return `<span class="badge ${cls}">${label}</span>`;
}

function logoFromTournament(t) {
  // Header logo (next to tournament name)
  const header = document.getElementById("tourLogo");
  if (t && t.logo) {
    header.src = t.logo;
    header.style.display = "block";
  } else {
    header.style.display = "none";
  }

  // Standings banner (logo + name above the standings table)
  const banner = document.getElementById("standingsBanner");
  if (banner) {
    if (t && (t.logo || t.name)) {
      banner.style.display = "flex";
      document.getElementById("standTourName").textContent = t.name || "Tournament";
      const sLogo = document.getElementById("standLogo");
      if (t.logo) { sLogo.src = t.logo; sLogo.style.display = "block"; }
      else sLogo.style.display = "none";
    } else {
      banner.style.display = "none";
    }
  }
}

// ---- bootstrap -----------------------------------------------------------

function init() {
  // Determine which tournament to display.
  // Priority: ?t= URL param > settings/currentTournament > first tournament.
  const params = new URLSearchParams(location.search);
  const urlTour = params.get("t");

  // Keep an eye on all tournaments (for fallback) and the chosen one.
  db.ref("tournaments").on("value", (snap) => {
    tournamentsMap = snap.val() || {};
    if (!CURRENT_TOURNAMENT) pickTournament(urlTour);
  });

  db.ref("settings/currentTournament").on("value", (snap) => {
    const cur = snap.val();
    if (!CURRENT_TOURNAMENT && cur) {
      CURRENT_TOURNAMENT = cur;
      loadTournament(cur);
    } else if (!CURRENT_TOURNAMENT) {
      pickTournament(urlTour);
    }
  });

  // Teams are needed for names/logos everywhere.
  db.ref("teams").on("value", (snap) => {
    teamsMap = snap.val() || {};
    if (CURRENT_TOURNAMENT) renderAll();
  });
}

function pickTournament(preferred) {
  if (preferred && tournamentsMap[preferred]) {
    CURRENT_TOURNAMENT = preferred;
    loadTournament(preferred);
    return;
  }
  const keys = Object.keys(tournamentsMap);
  if (keys.length === 0) {
    showEmptySite();
    return;
  }
  // Prefer a tournament marked "Live", else the first one.
  let chosen = keys.find((k) => tournamentsMap[k].status === "Live") || keys[0];
  CURRENT_TOURNAMENT = chosen;
  loadTournament(chosen);
}

function loadTournament(tid) {
  db.ref("tournaments/" + tid).on("value", (snap) => {
    const t = snap.val() || {};
    document.getElementById("tourName").textContent = t.name || "Tournament";
    const meta = [];
    if (t.venue) meta.push(t.venue);
    if (t.date) meta.push(formatDate(t.date));
    document.getElementById("tourMeta").textContent = meta.join("  ·  ") || "—";
    logoFromTournament(t);
  });

  subscribeMatches(tid);
  subscribeStandings(tid);

  // Tick the LIVE NOW clock.
  Timer.startTicking(() => renderLiveNow());

  // (Admin access is intentionally NOT shown on the public site — the admin
  // panel lives at login.html / admin.html as a separate page.)
}

// ---- matches -------------------------------------------------------------

function subscribeMatches(tid) {
  // Query matches belonging to this tournament.
  db.ref("matches")
    .orderByChild("tournamentId")
    .equalTo(tid)
    .on("value", (snap) => {
      matchesMap = snap.val() || {};
      // Attach event listeners for the recent-events feed.
      Object.keys(matchesMap).forEach((mid) => subscribeMatchEvents(mid));
      renderAll();
    });
}

function subscribeMatchEvents(matchId) {
  if (subscribedEvents[matchId]) return;
  subscribedEvents[matchId] = true;
  db.ref("matches/" + matchId + "/events").on("value", (snap) => {
    const evs = snap.val() || {};
    recentEvents[matchId] = Object.keys(evs).map((k) => ({ id: k, matchId, ...evs[k] }));
    renderRecentEvents();
  });
}

function renderAll() {
  renderLiveNow();
  renderUpcoming();
  renderFinished();
}

function matchList() {
  return Object.keys(matchesMap).map((id) => ({ id, ...matchesMap[id] }));
}

function renderLiveNow() {
  const box = document.getElementById("liveNowBox");
  const live = matchList().filter((m) => m.status === "Live");
  if (live.length === 0) {
    box.innerHTML = `<div class="no-live">No Live Match right now</div>`;
    return;
  }
  const m = live[0];
  const elapsed = Timer.computeElapsed(m.timer);
  box.innerHTML = `
    <div class="card live-now">
      <div style="text-align:center; margin-bottom:12px;">
        <span class="live-badge"><span class="live-dot"></span> LIVE NOW</span>
      </div>
      <a class="match-row" href="match.html?m=${m.id}" style="text-decoration:none; color:inherit; display:flex;">
        <div class="team-side">
          ${teamImg(m.teamA, "")}
          <div class="name">${esc(teamName(m.teamA))}</div>
        </div>
        <div class="score-box">
          <div class="score">${m.scoreA || 0} - ${m.scoreB || 0}</div>
          <div class="clock">${formatClock(elapsed)}</div>
          <div class="status">LIVE</div>
        </div>
        <div class="team-side">
          ${teamImg(m.teamB, "")}
          <div class="name">${esc(teamName(m.teamB))}</div>
        </div>
      </a>
    </div>`;
}

function renderUpcoming() {
  const box = document.getElementById("upcomingBox");
  const list = matchList()
    .filter((m) => m.status === "Scheduled")
    .sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));
  if (list.length === 0) {
    box.innerHTML = `<div class="empty">No upcoming matches.</div>`;
    return;
  }
  box.innerHTML = list
    .map((m) => {
      const when = m.scheduledTime
        ? `${formatDate(m.scheduledTime)} · ${formatTime(m.scheduledTime)}`
        : "TBD";
      return `
      <a class="match-item" href="match.html?m=${m.id}" style="text-decoration:none; color:inherit;">
        <div class="teams">
          <div class="row">${teamImg(m.teamA, "")}<span class="tname">${esc(teamName(m.teamA))}</span></div>
          <div class="row">${teamImg(m.teamB, "")}<span class="tname">${esc(teamName(m.teamB))}</span></div>
        </div>
        <div class="meta">
          ${statusBadge(m.status)}<br/>
          <span>${esc(m.matchNumber ? "#" + m.matchNumber + " " : "")}${when}</span><br/>
          <span>${esc(m.venue || "")}</span>
        </div>
      </a>`;
    })
    .join("");
}

function renderFinished() {
  const box = document.getElementById("finishedBox");
  const list = matchList()
    .filter((m) => m.status === "Finished")
    .sort((a, b) => (b.scheduledTime || 0) - (a.scheduledTime || 0));
  if (list.length === 0) {
    box.innerHTML = `<div class="empty">No finished matches yet.</div>`;
    return;
  }
  box.innerHTML = list
    .map((m) => `
      <a class="match-item" href="match.html?m=${m.id}" style="text-decoration:none; color:inherit;">
        <div class="teams">
          <div class="row">${teamImg(m.teamA, "")}<span class="tname">${esc(teamName(m.teamA))}</span></div>
          <div class="row">${teamImg(m.teamB, "")}<span class="tname">${esc(teamName(m.teamB))}</span></div>
        </div>
        <div class="meta">
          ${statusBadge(m.status)}<br/>
          <span style="font-size:1.1rem; font-weight:800;">${m.scoreA || 0} - ${m.scoreB || 0}</span>
        </div>
      </a>`)
    .join("");
}

// ---- standings -----------------------------------------------------------

function subscribeStandings(tid) {
  db.ref("standings/" + tid).on("value", (snap) => {
    const data = snap.val() || {};
    renderStandings(data);
  });
}

function renderStandings(data) {
  const box = document.getElementById("standingsBox");
  const rows = Object.keys(data).map((teamId) => ({ teamId, ...data[teamId] }));
  if (rows.length === 0) {
    box.innerHTML = `<div class="empty">Standings will appear after matches are created.</div>`;
    return;
  }

  const sortRows = (arr) =>
    arr.sort(
      (a, b) =>
        (b.points || 0) - (a.points || 0) ||
        (b.goalDifference || 0) - (a.goalDifference || 0) ||
        (b.goalsFor || 0) - (a.goalsFor || 0)
    );

  // Group rows by their group name (empty group = ungrouped).
  const groups = {};
  rows.forEach((r) => {
    const g = r.group || "";
    (groups[g] = groups[g] || []).push(r);
  });

  const groupNames = Object.keys(groups).sort((a, b) => a.localeCompare(b));
  // If every team is ungrouped, render a single table without a heading.
  const onlyUngrouped = groupNames.length === 1 && groupNames[0] === "";

  const tableHTML = (groupRows) => {
    const body = sortRows(groupRows)
      .map((r, i) => {
        const t = teamsMap[r.teamId] || {};
        const logo = t.logo ? t.logo : placeholderLogo(t.name || "?");
        return `
        <tr>
          <td class="pos">${i + 1}</td>
          <td class="team-cell"><img src="${logo}" alt="" />${esc(t.name || "Unknown")}</td>
          <td>${r.played || 0}</td>
          <td>${r.wins || 0}</td>
          <td>${r.draws || 0}</td>
          <td>${r.losses || 0}</td>
          <td>${r.goalsFor || 0}</td>
          <td>${r.goalsAgainst || 0}</td>
          <td>${r.goalDifference || 0}</td>
          <td><b>${r.points || 0}</b></td>
        </tr>`;
      })
      .join("");

    return `
      <table class="standings">
        <thead>
          <tr>
            <th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th>
            <th>GF</th><th>GA</th><th>GD</th><th>Pts</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>`;
  };

  let html = "";
  groupNames.forEach((g) => {
    if (!onlyUngrouped) {
      html += `<h3 style="margin:18px 0 8px; font-size:.95rem; color:var(--accent); letter-spacing:.5px;">${esc(g)}</h3>`;
    }
    html += tableHTML(groups[g]);
  });
  box.innerHTML = html;
}

// ---- recent events -------------------------------------------------------

function renderRecentEvents() {
  const ul = document.getElementById("recentEvents");
  const all = [];
  Object.keys(recentEvents).forEach((mid) => {
    recentEvents[mid].forEach((e) => all.push(e));
  });
  all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const top = all.slice(0, 10);
  if (top.length === 0) {
    ul.innerHTML = `<li class="empty">No events yet.</li>`;
    return;
  }
  ul.innerHTML = top
    .map((e) => {
      const icon = EVENT_ICON[e.type] || "📝";
      const team = teamName(e.teamId);
      const min = e.minute ? e.minute + "'" : "";
      const who = e.playerName ? esc(e.playerName) : esc(team);
      return `
      <li>
        <span class="min">${min}</span>
        <span class="icon">${icon}</span>
        <span class="ev-text">
          <span class="pname">${who}</span>
          ${e.type && e.type !== "Goal" ? `— ${esc(e.type)}` : ""}
          ${e.description ? `<div class="desc">${esc(e.description)}</div>` : ""}
        </span>
      </li>`;
    })
    .join("");
}

function showEmptySite() {
  document.getElementById("tourName").textContent = "No Tournament";
  document.getElementById("tourMeta").textContent = "Create a tournament in the admin panel.";
  document.getElementById("liveNowBox").innerHTML = `<div class="no-live">No Live Match</div>`;
  document.getElementById("upcomingBox").innerHTML = `<div class="empty">Nothing scheduled.</div>`;
  document.getElementById("finishedBox").innerHTML = `<div class="empty">No matches yet.</div>`;
  document.getElementById("standingsBox").innerHTML = `<div class="empty">No standings yet.</div>`;
}

document.addEventListener("DOMContentLoaded", init);
