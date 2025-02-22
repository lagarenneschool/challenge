const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const CONFIG_PATH = path.join(__dirname, 'config.json');
const configData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const RACES_DIR = path.join(__dirname, 'races');
if (!fs.existsSync(RACES_DIR)) {
  fs.mkdirSync(RACES_DIR);
}

// =============== In-memory store of all races ===============
// raceStore[raceId] = {
//    group, name, laps, isRunning, isPaused, isEnded,
//    pausedOffset, startTime, recordedTimes, isCountingDown, countdownRemaining
// }
let raceStore = {};

// Maps group => active raceId (or null)
let activeRaces = {};

// Keep track of countdown intervals by group so we can clear them if needed
let countdownIntervals = {};

// ----- Initialization: load any existing races into memory -----
function loadAllRaces() {
  const files = fs.readdirSync(RACES_DIR);
  files.forEach((f) => {
    if (!f.startsWith('race_') || !f.endsWith('.json')) return;
    const raceId = f.slice(5, -5);
    const data = JSON.parse(fs.readFileSync(path.join(RACES_DIR, f), 'utf8'));
    raceStore[raceId] = data;
  });
}
loadAllRaces();

// Initialize activeRaces so that each group is null by default
Object.keys(configData).forEach((g) => {
  activeRaces[g] = null;
});

// =============== Utility FS functions ===============
function getRacePath(raceId) {
  return path.join(RACES_DIR, `race_${raceId}.json`);
}
function writeRace(raceId, data) {
  fs.writeFileSync(getRacePath(raceId), JSON.stringify(data, null, 2), 'utf8');
}

// =============== Utility to build the raceData structure for the client ===============
function listRacesForGroup(group) {
  const out = {};
  for (const [raceId, rData] of Object.entries(raceStore)) {
    if (rData.group === group) {
      out[raceId] = rData;
    }
  }
  return out;
}
function buildRaceData() {
  const out = {};
  Object.keys(configData).forEach((g) => {
    out[g] = {
      currentRaceId: activeRaces[g],
      races: listRacesForGroup(g),
    };
  });
  return out;
}

// =============== All server logic now modifies raceStore in-memory ===============
function loadModifySave(group, modifyFn) {
  const rid = activeRaces[group];
  if (!rid) return null;
  const raceObj = raceStore[rid];
  if (!raceObj) return null;

  modifyFn(raceObj);

  // Write back to disk
  writeRace(rid, raceObj);
  return raceObj;
}

// Helper: generate a unique raceId
function generateRaceId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// =============== Force-end all races at startup (optional) ===============
(function forceEndAllRaces() {
  Object.keys(raceStore).forEach((rid) => {
    let r = raceStore[rid];
    r.isRunning = false;
    r.isEnded = true;
    r.startTime = null;
    r.isPaused = false;
    r.pausedOffset = 0;
    r.isCountingDown = false;
    r.countdownRemaining = 0;
    writeRace(rid, r);
  });
  Object.keys(activeRaces).forEach((g) => (activeRaces[g] = null));
  console.log("[server.js] All races ended at startup.");
})();

// =============== Countdown manager ===============
function startCountdownForRace(group, raceObj, totalSeconds) {
  // If there's a leftover interval, clear it
  if (countdownIntervals[group]) {
    clearInterval(countdownIntervals[group]);
    countdownIntervals[group] = null;
  }

  raceObj.isCountingDown = true;
  raceObj.countdownRemaining = totalSeconds;
  writeRace(activeRaces[group], raceObj);
  io.emit('raceDataUpdated', { raceData: buildRaceData() });

  countdownIntervals[group] = setInterval(() => {
    // Re-get from memory to ensure we keep the latest state
    let r = raceStore[activeRaces[group]];
    if (!r || r.isEnded) {
      clearInterval(countdownIntervals[group]);
      countdownIntervals[group] = null;
      return;
    }
    // If race was paused or forcibly ended during countdown, stop
    if (r.isPaused || r.isRunning) {
      r.isCountingDown = false;
      r.countdownRemaining = 0;
      clearInterval(countdownIntervals[group]);
      countdownIntervals[group] = null;
      writeRace(activeRaces[group], r);
      io.emit('raceDataUpdated', { raceData: buildRaceData() });
      return;
    }

    r.countdownRemaining -= 1;
    if (r.countdownRemaining <= 0) {
      // Countdown finished => start race
      r.isCountingDown = false;
      r.countdownRemaining = 0;
      r.isRunning = true;
      r.startTime = Date.now();
      clearInterval(countdownIntervals[group]);
      countdownIntervals[group] = null;
    }
    // Save & broadcast
    writeRace(activeRaces[group], r);
    io.emit('raceDataUpdated', { raceData: buildRaceData() });
  }, 1000);
}

// =============== Express & Socket.io Setup ===============
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.redirect('/index.html');
});

app.get('/api/config', (req, res) => {
  res.json(configData);
});

io.on('connection', (socket) => {
  console.log("[server.js] New client:", socket.id);

  // Send full state immediately
  socket.emit('initState', { raceData: buildRaceData() });

  // =============== CREATE A NEW RACE ===============
  socket.on('createNewRace', ({ group, raceName, laps }) => {
    const rId = generateRaceId();
    const raceDataObj = {
      group,
      name: raceName || `Race ${rId}`,
      laps: laps || 1,
      isRunning: false,
      isPaused: false,
      isEnded: false,
      pausedOffset: 0,
      startTime: null,
      recordedTimes: {},
      isCountingDown: false,
      countdownRemaining: 0,
    };
    // Add to in-memory store
    raceStore[rId] = raceDataObj;
    writeRace(rId, raceDataObj);

    // Set as active
    activeRaces[group] = rId;
    io.emit('raceDataUpdated', { raceData: buildRaceData() });
  });

  // =============== SELECT AN EXISTING RACE ===============
  socket.on('selectRace', ({ group, raceId }) => {
    const rd = raceStore[raceId];
    if (!rd || rd.group !== group) return;
    activeRaces[group] = raceId;
    io.emit('raceDataUpdated', { raceData: buildRaceData() });
  });

  // =============== START or RESUME a race ===============
  // payload => {group, useCountdown: bool}
  socket.on('startRace', ({ group, useCountdown }) => {
    const rid = activeRaces[group];
    if (!rid) return;
    let r = raceStore[rid];
    if (!r || r.isEnded) return;

    if (r.isPaused) {
      // resume
      r.isPaused = false;
      r.isRunning = true;
      const offset = r.pausedOffset;
      r.pausedOffset = 0;
      r.startTime = Date.now() - offset;
      writeRace(rid, r);
      io.emit('raceDataUpdated', { raceData: buildRaceData() });
      return;
    }

    // If brand-new or not paused => check if user wants countdown
    if (useCountdown) {
      // Start server-driven countdown
      startCountdownForRace(group, r, 120); // 120 seconds
    } else {
      // start immediately
      r.isRunning = true;
      r.startTime = Date.now();
      writeRace(rid, r);
      io.emit('raceDataUpdated', { raceData: buildRaceData() });
    }
  });

  // =============== PAUSE RACE ===============
  socket.on('pauseRace', (group) => {
    const updated = loadModifySave(group, (r) => {
      if (r.isEnded || !r.isRunning) return;
      // If it's counting down, stop countdown
      if (r.isCountingDown) {
        r.isCountingDown = false;
        r.countdownRemaining = 0;
        if (countdownIntervals[group]) {
          clearInterval(countdownIntervals[group]);
          countdownIntervals[group] = null;
        }
      }
      r.isPaused = true;
      r.isRunning = false;
      const elapsed = Date.now() - (r.startTime || 0);
      r.pausedOffset = elapsed;
      r.startTime = null;
    });
    if (updated) {
      io.emit('raceDataUpdated', { raceData: buildRaceData() });
    }
  });

  // =============== END RACE ===============
  socket.on('endRace', (group) => {
    const updated = loadModifySave(group, (r) => {
      r.isEnded = true;
      r.isPaused = false;
      r.isRunning = false;
      r.pausedOffset = 0;
      r.startTime = null;
      r.isCountingDown = false;
      r.countdownRemaining = 0;
      if (countdownIntervals[group]) {
        clearInterval(countdownIntervals[group]);
        countdownIntervals[group] = null;
      }
    });
    if (updated) {
      activeRaces[group] = null;
      io.emit('raceDataUpdated', { raceData: buildRaceData() });
    }
  });

  // =============== REGISTER A LAP TIME ===============
  socket.on('registerTime', ({ group, studentName, time }) => {
    const rid = activeRaces[group];
    if (!rid) return;
    let r = raceStore[rid];
    if (!r || !r.isRunning) return;

    if (!r.recordedTimes[studentName]) {
      r.recordedTimes[studentName] = [];
    }
    const arr = r.recordedTimes[studentName];
    // prevent going over laps
    if (arr.length >= r.laps) {
      console.log("User tried to record more laps than allowed => ignoring");
      return;
    }

    arr.push(time);
    writeRace(rid, r); // persist

    // Let all clients know specifically about this new time
    io.emit('timeRegistered', {
      group,
      raceId: rid,
      studentName,
      time,
    });
  });

  // =============== INJURE A STUDENT ===============
  socket.on('injureStudent', ({ group, studentName }) => {
    const rid = activeRaces[group];
    if (!rid) return;
    let r = raceStore[rid];
    if (!r || !r.isRunning) return;

    if (!r.recordedTimes[studentName]) {
      r.recordedTimes[studentName] = [];
    }
    r.recordedTimes[studentName].push("Injured");
    writeRace(rid, r);

    io.emit('timeRegistered', {
      group,
      raceId: rid,
      studentName,
      time: "Injured",
    });
  });

  // =============== REASSIGN STUDENT (MOVE LAST LAP) ===============
  socket.on('reassignStudent', ({ group, oldStudent, newStudent, newTime }) => {
    loadModifySave(group, (r) => {
      const oldArr = r.recordedTimes[oldStudent];
      if (!oldArr) return;
      delete r.recordedTimes[oldStudent];
      if (!r.recordedTimes[newStudent]) {
        r.recordedTimes[newStudent] = [];
      }
      if (newTime !== undefined) {
        r.recordedTimes[newStudent].push(newTime);
      } else {
        // Move the entire array
        r.recordedTimes[newStudent].push(...oldArr);
      }
    });
    io.emit('studentReassigned', {
      group,
      raceId: activeRaces[group],
      oldStudent,
      newStudent,
      newTime,
    });
  });

  // =============== EDIT TIME (LAST LAP) ===============
  socket.on('editTime', ({ group, studentName, newTime }) => {
    loadModifySave(group, (r) => {
      const arr = r.recordedTimes[studentName];
      if (!arr || !arr.length) return;
      arr[arr.length - 1] = newTime;
    });
    io.emit('timeEdited', {
      group,
      raceId: activeRaces[group],
      studentName,
      newTime,
    });
  });

  // =============== REMOVE LAST LAP ===============
  socket.on('removeLap', ({ group, studentName }) => {
    loadModifySave(group, (r) => {
      // if you want to allow removing even if not running, remove the next line:
      if (!r.isRunning) return;
      const arr = r.recordedTimes[studentName];
      if (!arr || !arr.length) return;
      arr.pop();
    });
    // Just broadcast full data
    io.emit('raceDataUpdated', { raceData: buildRaceData() });
  });

  // =============== PING for latency ===============
  socket.on('pingCheck', (clientTime) => {
    socket.emit('pongCheck', clientTime);
  });

  socket.on('disconnect', () => {
    console.log("[server.js] Client disconnected:", socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[server.js] Server listening on port ${PORT}`);
});
