/* =========================================================================
   timer.js
   -------------------------------------------------------------------------
   Reliable match timer based on Firebase stored timestamps.

   The displayed time is ALWAYS calculated from the database state, never
   from a local setInterval counter. This means the timer stays correct
   after a browser refresh, a connection drop, or when viewed from a
   different device.

   Database shape (under matches/<id>/timer):
     {
       status:  "idle" | "running" | "paused" | "finished",
       elapsed: <number of seconds accumulated while not running>,
       startedAt: <server timestamp ms when the current run started>,
       pausedAt: <server timestamp ms when paused> (optional)
     }

   Displayed elapsed while RUNNING:
       elapsed + (serverNow - startedAt) / 1000

   While PAUSED / FINISHED / IDLE we just show `elapsed`.
   ========================================================================= */

const Timer = (function () {
  // Internal ticking only refreshes the on-screen number. The source of
  // truth is always the database.
  let tickHandle = null;
  let onTick = null;

  function startTicking(cb) {
    onTick = cb;
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(() => {
      if (onTick) onTick();
    }, 250);
  }

  function stopTicking() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = null;
  }

  // Calculate the current elapsed seconds from a timer database object.
  function computeElapsed(timer) {
    if (!timer) return 0;
    let elapsed = Number(timer.elapsed) || 0;
    if (timer.status === "running" && timer.startedAt) {
      elapsed += (getServerTime() - timer.startedAt) / 1000;
    }
    return elapsed;
  }

  // Returns the timer object to write when STARTING a fresh timer.
  function startPayload() {
    return {
      status: "running",
      elapsed: 0,
      startedAt: firebase.database.ServerValue.TIMESTAMP,
      pausedAt: null
    };
  }

  // Returns the timer object to write when PAUSING.
  // We freeze the accumulated elapsed time first.
  function pausePayload(timer) {
    const frozen = computeElapsed(timer);
    return {
      status: "paused",
      elapsed: Math.floor(frozen),
      startedAt: null,
      pausedAt: firebase.database.ServerValue.TIMESTAMP
    };
  }

  // Returns the timer object to write when RESUMING from a pause.
  // We must preserve the frozen accumulated `elapsed` from the pause.
  function resumePayload(timer) {
    return {
      status: "running",
      elapsed: Number(timer && timer.elapsed) || 0,
      startedAt: firebase.database.ServerValue.TIMESTAMP,
      pausedAt: null
    };
  }

  // Returns the timer object to write when RESETTING.
  function resetPayload() {
    return {
      status: "idle",
      elapsed: 0,
      startedAt: null,
      pausedAt: null
    };
  }

  // Returns the timer object to write when ENDING the match.
  function endPayload(timer) {
    return {
      status: "finished",
      elapsed: Math.floor(computeElapsed(timer)),
      startedAt: null,
      pausedAt: null
    };
  }

  return {
    startTicking,
    stopTicking,
    computeElapsed,
    startPayload,
    pausePayload,
    resumePayload,
    resetPayload,
    endPayload
  };
})();
