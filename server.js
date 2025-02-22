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

let activeRaces = {};

const RACES_DIR = path.join(__dirname, 'races');
if (!fs.existsSync(RACES_DIR)) {
  fs.mkdirSync(RACES_DIR);
}

Object.keys(configData).forEach((g) => {
  activeRaces[g] = null;
});

// Helpers
function generateRaceId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function getRacePath(raceId) {
  return path.join(RACES_DIR, `race_${raceId}.json`);
}
function writeRace(raceId, data) {
  fs.writeFileSync(getRacePath(raceId), JSON.stringify(data, null, 2), 'utf8');
}
function readRace(raceId) {
  const fp = getRacePath(raceId);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}
function listRacesForGroup(group) {
  const out = {};
  const files = fs.readdirSync(RACES_DIR);
  for (const f of files) {
    if (!f.startsWith('race_') || !f.endsWith('.json')) continue;
    const rid = f.slice(5, -5);
    const rd = readRace(rid);
    if (rd && rd.group === group) {
      out[rid] = rd;
    }
  }
  return out;
}
function buildRaceData() {
  const out = {};
  Object.keys(configData).forEach((g) => {
    out[g] = {
      currentRaceId: activeRaces[g],
      races: listRacesForGroup(g)
    };
  });
  return out;
}
function loadModifySave(group, cb) {
  const rid = activeRaces[group];
  if (!rid) return null;
  const data = readRace(rid);
  if (!data) return null;
  cb(data);
  writeRace(rid, data);
  return data;
}

// Force-end all races at startup
(function forceEndAllRaces() {
  Object.keys(configData).forEach((g) => {
    const races = listRacesForGroup(g);
    Object.keys(races).forEach((rid) => {
      races[rid].isRunning = false;
      races[rid].isEnded = true;
      races[rid].startTime = null;
      races[rid].isPaused = false;
      races[rid].pausedOffset = 0;
      writeRace(rid, races[rid]);
    });
    activeRaces[g] = null;
  });
  console.log("[server.js] All races ended at startup.");
})();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.redirect('/index.html');
});
app.get('/api/config', (req, res) => {
  res.json(configData);
});

io.on('connection', (socket) => {
  console.log("[server.js] New client:", socket.id);

  // Send the entire raceData structure
  socket.emit('initState', { raceData: buildRaceData() });

  /**
   * CREATE A NEW RACE
   * payload = { group, raceName, laps }
   */
  socket.on('createNewRace', (payload) => {
    const { group, raceName, laps } = payload;
    console.log("[server.js] createNewRace => group:", group, " raceName:", raceName, " laps:", laps);

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
      recordedTimes: {}
    };
    writeRace(rId, raceDataObj);
    activeRaces[group] = rId;
    io.emit('raceDataUpdated', { raceData: buildRaceData() });
  });

  /**
   * SELECT (LOAD) AN EXISTING RACE
   */
  socket.on('selectRace', ({ group, raceId }) => {
    const rd = readRace(raceId);
    if (!rd || rd.group !== group) return;
    activeRaces[group] = raceId;
    io.emit('raceDataUpdated', { raceData: buildRaceData() });
  });

  /**
   * START or RESUME a race
   */
  socket.on('startRace', (group) => {
    const updated = loadModifySave(group, (r) => {
      if (r.isEnded) return;
      if (r.isPaused) {
        // resume
        r.isPaused = false;
        r.isRunning = true;
        const offset = r.pausedOffset;
        r.pausedOffset = 0;
        r.startTime = Date.now() - offset;
      } else {
        // normal start
        r.isRunning = true;
        r.startTime = Date.now();
      }
    });
    if (updated) {
      io.emit('raceDataUpdated', { raceData: buildRaceData() });
    }
  });

  /**
   * PAUSE a running race
   */
  socket.on('pauseRace', (group) => {
    const updated = loadModifySave(group, (r) => {
      if (r.isEnded || !r.isRunning) return;
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

  /**
   * END a race
   */
  socket.on('endRace', (group) => {
    const updated = loadModifySave(group, (r) => {
      r.isEnded = true;
      r.isPaused = false;
      r.isRunning = false;
      r.pausedOffset = 0;
      r.startTime = null;
    });
    if (updated) {
      activeRaces[group] = null;
      io.emit('raceDataUpdated', { raceData: buildRaceData() });
    }
  });

  /**
   * REGISTER a time (lap)
   */
  socket.on('registerTime', ({ group, studentName, time }) => {
    const updated = loadModifySave(group, (r) => {
      if (!r.isRunning) return;
      if (!r.recordedTimes[studentName]) {
        r.recordedTimes[studentName] = [];
      }
      const arr = r.recordedTimes[studentName];
      if (arr.length >= r.laps) {
        console.log("[server.js] user tried to record more laps than allowed => ignoring");
        return;
      }
      arr.push(time);
    });
    if (updated) {
      io.emit('timeRegistered', {
        group,
        raceId: activeRaces[group],
        studentName,
        time
      });
    }
  });

  /**
   * INJURE => mark student as "Injured"
   */
  socket.on('injureStudent', ({ group, studentName }) => {
    const updated = loadModifySave(group, (r) => {
      if (!r.isRunning) return;
      if (!r.recordedTimes[studentName]) {
        r.recordedTimes[studentName] = [];
      }
      r.recordedTimes[studentName].push("Injured");
    });
    if (updated) {
      io.emit('timeRegistered', {
        group,
        raceId: activeRaces[group],
        studentName,
        time: "Injured"
      });
    }
  });

  /**
   * REASSIGN student => new name
   * optional newTime
   */
  socket.on('reassignStudent', ({ group, oldStudent, newStudent, newTime }) => {
    const updated = loadModifySave(group, (r) => {
      if (!r.recordedTimes[oldStudent]) return;
      const oldArr = r.recordedTimes[oldStudent];
      delete r.recordedTimes[oldStudent];
      if (!r.recordedTimes[newStudent]) {
        r.recordedTimes[newStudent] = [];
      }
      if (newTime !== undefined) {
        r.recordedTimes[newStudent].push(newTime);
      } else {
        // just move the entire array
        r.recordedTimes[newStudent].push(...oldArr);
      }
    });
    if (updated) {
      io.emit('studentReassigned', {
        group,
        raceId: activeRaces[group],
        oldStudent,
        newStudent,
        newTime
      });
    }
  });

  socket.on('pingCheck', (clientTime) => {
    // Immediately emit 'pongCheck' with the same timestamp
    // so the client can measure round-trip
    socket.emit('pongCheck', clientTime);
  });

  /**
   * EDIT time => modifies last lap
   */
  socket.on('editTime', ({ group, studentName, newTime }) => {
    const updated = loadModifySave(group, (r) => {
      const arr = r.recordedTimes[studentName];
      if (!arr || !arr.length) return;
      arr[arr.length - 1] = newTime;
    });
    if (updated) {
      io.emit('timeEdited', {
        group,
        raceId: activeRaces[group],
        studentName,
        newTime
      });
    }
  });

  /**
   * REMOVE a lap => pop the last lap from the array
   */
  socket.on('removeLap', ({ group, studentName }) => {
    const updated = loadModifySave(group, (r) => {
      if (!r.isRunning) return; // or allow if not running
      const arr = r.recordedTimes[studentName];
      if (!arr || !arr.length) return;
      arr.pop();
    });
    if (updated) {
      // You can emit a custom event or just do raceDataUpdated
      io.emit('raceDataUpdated', { raceData: buildRaceData() });
    }
  });

  socket.on('disconnect', () => {
    console.log("[server.js] Client disconnected:", socket.id);
  });
});


const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[server.js] Server listening on port ${PORT}`);
});
