const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIO = require('socket.io');

// -------------- Basic Setup --------------
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Load config
const CONFIG_PATH = path.join(__dirname, 'config.json');
const configData = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// The "activeRaces" object tracks which race is active for each group
let activeRaces = {};

// Directory for storing race files
const RACES_DIR = path.join(__dirname, 'races');
if (!fs.existsSync(RACES_DIR)) {
  fs.mkdirSync(RACES_DIR);
}

// Initialize activeRaces to null
Object.keys(configData).forEach((g) => {
  activeRaces[g] = null;
});

// -------------- Helper Functions --------------
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

// -------------- Concurrency Queues --------------
/**
 * We maintain an in-memory queue for each group. Each incoming
 * "modify" event is placed into that group's queue. The server
 * processes them one at a time, ensuring we never read/write
 * the same file simultaneously from multiple events.
 *
 * queueMap[group] = [ { eventName, payload, resolveFn, rejectFn }, ... ]
 */
const queueMap = {};
Object.keys(configData).forEach((g) => {
  queueMap[g] = [];
});

// This function adds a "task" to the group's queue
function enqueueTask(group, task) {
  queueMap[group].push(task);
  if (queueMap[group].length === 1) {
    // If this is the only task, start processing
    processNextTask(group);
  }
}

// Process tasks in FIFO order
function processNextTask(group) {
  if (queueMap[group].length === 0) return;
  const { handler, resolveFn, rejectFn } = queueMap[group][0];

  // "handler" is an async or sync function that modifies the race
  // Then calls "done()" when finished
  const done = (err, result) => {
    if (err) {
      rejectFn(err);
    } else {
      resolveFn(result);
    }
    // remove the completed task from the queue
    queueMap[group].shift();
    // process next if any
    if (queueMap[group].length > 0) {
      processNextTask(group);
    }
  };

  // We call "handler(done)" to do the file read/write
  try {
    handler(done);
  } catch (ex) {
    done(ex);
  }
}

function loadModifySave(group, modifyFn) {
  return new Promise((resolve, reject) => {
    const task = {
      handler: (done) => {
        // read
        const rId = activeRaces[group];
        if (!rId) return done(null, null); // no active race
        const data = readRace(rId);
        if (!data) return done(null, null);

        // modify
        modifyFn(data);

        // write
        writeRace(rId, data);
        done(null, data);
      },
      resolveFn: resolve,
      rejectFn: reject
    };
    enqueueTask(group, task);
  });
}

// -------------- Force-End All Races at Startup --------------
(function forceEndAllRaces() {
  Object.keys(configData).forEach((g) => {
    const races = listRacesForGroup(g);
    Object.keys(races).forEach((rid) => {
      const rData = races[rid];
      rData.isRunning = false;
      rData.isEnded = true;
      rData.startTime = null;
      rData.isPaused = false;
      rData.pausedOffset = 0;
      writeRace(rid, rData);
    });
    activeRaces[g] = null;
  });
  console.log("[server.js] All races ended at startup.");
})();

// -------------- EXPRESS + STATIC --------------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.redirect('/index.html');
});
app.get('/api/config', (req, res) => {
  res.json(configData);
});

// -------------- SOCKET.IO --------------
io.on('connection', (socket) => {
  console.log("[server.js] New client:", socket.id);

  // Provide current data
  socket.emit('initState', { raceData: buildRaceData() });

  // Ping/pong for latency
  socket.on('pingCheck', (clientTime) => {
    // Return same timestamp so client can measure round-trip
    socket.emit('pongCheck', clientTime);
  });

  // CREATE NEW RACE
  socket.on('createNewRace', ({ group, raceName, laps }) => {
    enqueueTask(group, {
      handler: (done) => {
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
        done(null, raceDataObj);
      },
      resolveFn: () => {
        io.emit('raceDataUpdated', { raceData: buildRaceData() });
      },
      rejectFn: (err) => {
        console.error("Error creating race:", err);
      }
    });
  });

  // SELECT RACE
  socket.on('selectRace', ({ group, raceId }) => {
    enqueueTask(group, {
      handler: (done) => {
        const rd = readRace(raceId);
        if (!rd || rd.group !== group) {
          return done(null, null);
        }
        activeRaces[group] = raceId;
        done(null, rd);
      },
      resolveFn: () => {
        io.emit('raceDataUpdated', { raceData: buildRaceData() });
      },
      rejectFn: (err) => {
        console.error("Error selectRace:", err);
      }
    });
  });

  // START RACE
  socket.on('startRace', (group) => {
    loadModifySave(group, (r) => {
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
    }).then((updatedData) => {
      if (updatedData) {
        io.emit('raceDataUpdated', { raceData: buildRaceData() });
      }
    }).catch((err) => {
      console.error("Error startRace:", err);
    });
  });

  // PAUSE RACE
  socket.on('pauseRace', (group) => {
    loadModifySave(group, (r) => {
      if (r.isEnded || !r.isRunning) return;
      r.isPaused = true;
      r.isRunning = false;
      const elapsed = Date.now() - (r.startTime || 0);
      r.pausedOffset = elapsed;
      r.startTime = null;
    }).then((updatedData) => {
      if (updatedData) {
        io.emit('raceDataUpdated', { raceData: buildRaceData() });
      }
    }).catch((err) => {
      console.error("Error pauseRace:", err);
    });
  });

  // END RACE
  socket.on('endRace', (group) => {
    loadModifySave(group, (r) => {
      r.isEnded = true;
      r.isPaused = false;
      r.isRunning = false;
      r.pausedOffset = 0;
      r.startTime = null;
    }).then((updatedData) => {
      if (updatedData) {
        activeRaces[group] = null;
        io.emit('raceDataUpdated', { raceData: buildRaceData() });
      }
    }).catch((err) => {
      console.error("Error endRace:", err);
    });
  });

  // REGISTER TIME
  socket.on('registerTime', ({ group, studentName, time }) => {
    loadModifySave(group, (r) => {
      if (!r.isRunning) return;
      if (!r.recordedTimes[studentName]) {
        r.recordedTimes[studentName] = [];
      }
      const arr = r.recordedTimes[studentName];
      if (arr.length >= r.laps) {
        console.log("[server] ignoring extra lap for", studentName);
        return;
      }
      arr.push(time);
    }).then((updatedData) => {
      if (updatedData) {
        io.emit('timeRegistered', {
          group,
          raceId: activeRaces[group],
          studentName,
          time
        });
      }
    }).catch((err) => {
      console.error("Error registerTime:", err);
    });
  });

  // INJURE STUDENT
  socket.on('injureStudent', ({ group, studentName }) => {
    loadModifySave(group, (r) => {
      if (!r.isRunning) return;
      if (!r.recordedTimes[studentName]) {
        r.recordedTimes[studentName] = [];
      }
      r.recordedTimes[studentName].push("Injured");
    }).then((updatedData) => {
      if (updatedData) {
        io.emit('timeRegistered', {
          group,
          raceId: activeRaces[group],
          studentName,
          time: "Injured"
        });
      }
    }).catch((err) => {
      console.error("Error injureStudent:", err);
    });
  });

  // REASSIGN STUDENT
  socket.on('reassignStudent', ({ group, oldStudent, newStudent, newTime }) => {
    loadModifySave(group, (r) => {
      if (!r.recordedTimes[oldStudent]) return;
      const oldArr = r.recordedTimes[oldStudent];
      delete r.recordedTimes[oldStudent];
      if (!r.recordedTimes[newStudent]) {
        r.recordedTimes[newStudent] = [];
      }
      if (newTime !== undefined) {
        r.recordedTimes[newStudent].push(newTime);
      } else {
        // move entire array
        r.recordedTimes[newStudent].push(...oldArr);
      }
    }).then((updatedData) => {
      if (updatedData) {
        io.emit('studentReassigned', {
          group,
          raceId: activeRaces[group],
          oldStudent,
          newStudent,
          newTime
        });
      }
    }).catch((err) => {
      console.error("Error reassignStudent:", err);
    });
  });

  // EDIT TIME => modifies last lap
  socket.on('editTime', ({ group, studentName, newTime }) => {
    loadModifySave(group, (r) => {
      const arr = r.recordedTimes[studentName];
      if (!arr || !arr.length) return;
      arr[arr.length - 1] = newTime;
    }).then((updatedData) => {
      if (updatedData) {
        io.emit('timeEdited', {
          group,
          raceId: activeRaces[group],
          studentName,
          newTime
        });
      }
    }).catch((err) => {
      console.error("Error editTime:", err);
    });
  });

  // REMOVE LAST LAP => "pop"
  socket.on('removeLap', ({ group, studentName }) => {
    loadModifySave(group, (r) => {
      if (!r.isRunning) return; // or allow if not running
      const arr = r.recordedTimes[studentName];
      if (!arr || !arr.length) return;
      arr.pop();
    }).then((updatedData) => {
      if (updatedData) {
        // We can broadcast a generic "raceDataUpdated" or custom
        io.emit('raceDataUpdated', { raceData: buildRaceData() });
      }
    }).catch((err) => {
      console.error("Error removeLap:", err);
    });
  });

  socket.on('disconnect', () => {
    console.log("[server.js] Client disconnected:", socket.id);
  });
});

// -------------- START --------------
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[server.js] listening on port ${PORT}`);
});
