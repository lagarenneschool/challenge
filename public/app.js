/********************************************************
 * app.js
 * 
 * Changes:
 * - We removed local setInterval for the countdown.
 * - We rely on the server to handle the countdown; 
 *   whenever raceData updates, we check if isCountingDown 
 *   is true and display the countdown in the timers.
 * - The concurrency bug is fixed by storing all race data 
 *   in memory on the server side (no changes needed 
 *   here except removing the old local countdown).
 ********************************************************/

let socket;
let configData;
let raceData;
let currentGroup = 'lowerPrimary'; // default group
let userRole = null;
let timerInterval = null;

// optional latency measure
let currentLatency = 0;

window.addEventListener('DOMContentLoaded', async () => {
  checkIfLoggedIn();

  // fetch config
  const cfg = await fetch('/api/config');
  configData = await cfg.json();
  console.log("[app.js] configData =>", configData);

  // connect socket
  socket = io();

  // optional ping/pong for latency
  setInterval(sendPing, 2000);
  socket.on('pongCheck', (serverTime) => {
    const now = performance.now();
    currentLatency = Math.round(now - serverTime);
    const latEl = document.getElementById('latencyDisplay');
    if (latEl) {
      latEl.textContent = `Latency: ${currentLatency}ms`;
    }
  });

  socket.on('initState', (payload) => {
    raceData = payload.raceData;
    initUI();
    updateUI();
  });
  socket.on('raceDataUpdated', (payload) => {
    raceData = payload.raceData;
    updateUI();
  });

  socket.on('timeRegistered', ({ group, raceId, studentName, time }) => {
    const rObj = raceData[group].races[raceId];
    if (!rObj.recordedTimes[studentName]) {
      rObj.recordedTimes[studentName] = [];
    }
    rObj.recordedTimes[studentName].push(time);
    computeFinalTime(rObj, studentName);
    updateUI();
    showConfirmation(
      time === 'Injured'
        ? `Student "${studentName}" => Injured`
        : `Student "${studentName}" => ${time} s`
    );
  });

  socket.on('studentReassigned', ({ group, raceId, oldStudent, newStudent, newTime }) => {
    const rObj = raceData[group].races[raceId];
    const oldArr = rObj.recordedTimes[oldStudent] || [];
    delete rObj.recordedTimes[oldStudent];
    if (!rObj.recordedTimes[newStudent]) {
      rObj.recordedTimes[newStudent] = [];
    }
    if (newTime !== undefined) {
      rObj.recordedTimes[newStudent].push(newTime);
    } else {
      rObj.recordedTimes[newStudent].push("Reassigned");
    }
    computeFinalTime(rObj, newStudent);
    updateUI();
    showConfirmation(`Reassigned ${oldStudent} => ${newStudent}`);
  });

  socket.on('timeEdited', ({ group, raceId, studentName, newTime }) => {
    const arr = raceData[group].races[raceId].recordedTimes[studentName];
    if (arr && arr.length) {
      arr[arr.length - 1] = newTime;
    }
    computeFinalTime(raceData[group].races[raceId], studentName);
    updateUI();
    showConfirmation(`Edited ${studentName} => ${newTime}s`);
  });

  timerInterval = setInterval(updateTimers, 200);
});

/*******************************
 * OPTIONAL: measure latency
 *******************************/
function sendPing() {
  const now = performance.now();
  socket.emit('pingCheck', now);
}

/*******************************
 * finalTime calculation
 *******************************/
function computeFinalTime(rObj, studentName) {
  if (!rObj.finalTimes) {
    rObj.finalTimes = {};
  }
  const arr = rObj.recordedTimes[studentName] || [];
  if (arr.includes('Injured')) {
    rObj.finalTimes[studentName] = 'Injured';
    return;
  }
  let sum = 0;
  for (let val of arr) {
    if (typeof val === 'number') {
      sum += val;
    }
  }
  rObj.finalTimes[studentName] = parseFloat(sum.toFixed(3));
}

/*******************************
 * CHECK LOGIN
 *******************************/
function checkIfLoggedIn() {
  userRole = localStorage.getItem('userRole');
  if (!userRole) {
    window.location.href = 'index.html';
  }
}

/*******************************
 * INIT UI
 *******************************/
function initUI() {
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  // Hide "switchRaceBtn" if desired
  document.getElementById('switchRaceBtn').style.display = 'none';

  document.getElementById('startRaceBtn').addEventListener('click', handleStartRace);
  document.getElementById('pauseRaceBtn').addEventListener('click', handlePauseRace);
  document.getElementById('endRaceBtn').addEventListener('click', handleEndRace);
  document.getElementById('manageBtn').addEventListener('click', handleManage);
  document.getElementById('createRaceBtn').addEventListener('click', handleCreateRace);
  document.getElementById('loadRaceBtn').addEventListener('click', handleLoadRace);
  document.getElementById('injureOneBtn').addEventListener('click', handleInjureOne);

  document.getElementById('lowerPrimaryTab').addEventListener('click',() => switchTab('lowerPrimary'));
  document.getElementById('minisTab').addEventListener('click',() => switchTab('minis'));
  document.getElementById('juniorTab').addEventListener('click',() => switchTab('junior'));
  document.getElementById('seniorTab').addEventListener('click',() => switchTab('senior'));

  const sInput = document.getElementById('searchInput');
  const sResults = document.getElementById('searchResults');
  sInput.addEventListener('input', () => handleSearchInput(sInput, sResults));
  sResults.addEventListener('click', handleSearchClick);
}

function doLogout() {
  localStorage.removeItem('userRole');
  window.location.href = 'index.html';
}

/*******************************
 * RACE ACTIONS
 *******************************/
function handleCreateRace() {
  if (userRole !== 'admin') {
    alert("Admin only");
    return;
  }
  const name = prompt("Race name?") || '';
  const lapsStr = prompt("How many laps?") || '1';
  let laps = parseInt(lapsStr, 10);
  if (isNaN(laps) || laps < 1) laps = 1;

  socket.emit('createNewRace', { group: currentGroup, raceName: name, laps });
}

function handleLoadRace() {
  const sel = document.getElementById('raceListSelect');
  const rId = sel.value;
  if (rId) {
    socket.emit('selectRace', { group: currentGroup, raceId: rId });
  }
}

/**
 * If the race is brand-new, we optionally do a 120s countdown.
 * If the race is paused, we resume immediately (no countdown).
 */
function handleStartRace() {
  if (userRole !== 'admin') {
    alert("Admin only");
    return;
  }
  const rObj = getRaceObj();
  if (!rObj) {
    showConfirmation("No race selected");
    return;
  }

  if (rObj.isPaused) {
    // Just resume
    if (!confirm("Resume the paused race now?")) return;
    socket.emit('startRace', { group: currentGroup, useCountdown: false });
    return;
  }

  // If we get here, it's presumably brand-new or not paused
  const useCountdown = confirm("Start with a 120s countdown?");
  socket.emit('startRace', { group: currentGroup, useCountdown });
}

function handlePauseRace() {
  if (userRole !== 'admin') {
    alert("Admin only");
    return;
  }
  const rObj = getRaceObj();
  if (!rObj || !rObj.isRunning) {
    showConfirmation("No running race to pause.");
    return;
  }
  socket.emit('pauseRace', currentGroup);
}

/**
 * Always prompt to confirm end, then do "endRace".
 */
function handleEndRace() {
  if (userRole !== 'admin') {
    alert("Admin only");
    return;
  }
  const rObj = getRaceObj();
  if (!rObj) {
    showConfirmation("No race selected");
    return;
  }
  // check incomplete
  const incomplete = getIncompleteStudents(rObj);
  if (incomplete.length > 0) {
    let msg = "Some students are not done:\n\n" + incomplete.join("\n");
    msg += "\n\nPress CANCEL to register them, or OK to end anyway.";
    if (!confirm(msg)) return;
  }
  // final confirm
  if (!confirm("Are you sure you want to end this race?")) return;

  socket.emit('endRace', currentGroup);
}

/** gather incomplete students for a given raceObj */
function getIncompleteStudents(rObj) {
  const groupCfg = configData[rObj.group];
  const out = [];
  if (!groupCfg) return out;
  groupCfg.classes.forEach(cls => {
    cls.students.forEach(stu => {
      const arr = rObj.recordedTimes[stu] || [];
      if(!arr.includes('Injured') && arr.length < rObj.laps){
        out.push(stu);
      }
    });
  });
  return out;
}

/*******************************
 * INJURE
 *******************************/
function handleInjureOne() {
  if (!userRole) {
    alert("Please log in first");
    return;
  }
  const rObj = getRaceObj();
  if (!rObj || !rObj.isRunning) {
    alert("No running race => can't injure");
    return;
  }
  const allStus = getAllStudentsInGroup(rObj.group);
  if (!allStus.length) {
    alert("No students found");
    return;
  }
  const choice = prompt("Select student to injure:\n" + allStus.join("\n"));
  if (!choice) return;
  if (!allStus.includes(choice)) {
    alert("That name wasn't recognized. Must match exactly.");
    return;
  }
  socket.emit('injureStudent', { group: currentGroup, studentName: choice });
}
function getAllStudentsInGroup(g) {
  const arr = [];
  configData[g].classes.forEach(cls => {
    arr.push(...cls.students);
  });
  return arr;
}

/*******************************
 * UI RENDER
 *******************************/
function updateUI() {
  if (!raceData[currentGroup]) return;

  const cRId = raceData[currentGroup].currentRaceId;
  const selDiv = document.querySelector('.race-selection');
  selDiv.style.display = cRId ? 'none' : 'block';

  let isRunning = false, isPaused = false;
  if (cRId) {
    const rO = raceData[currentGroup].races[cRId];
    if (rO) {
      isRunning = rO.isRunning;
      isPaused = rO.isPaused;
    }
  }
  const isAdmin = (userRole === 'admin');

  // Start Race => if paused => "Continue" label
  const stBtn= document.getElementById('startRaceBtn');
  stBtn.textContent = isPaused ? "Continue Race" : "Start Race";
  stBtn.disabled = (!isAdmin || !cRId || (isRunning && !isPaused));

  // Pause
  document.getElementById('pauseRaceBtn').disabled = (!isAdmin || !cRId || !isRunning);

  // End
  document.getElementById('endRaceBtn').disabled = (!isAdmin || !cRId || !isRunning);

  // Manage
  const hasTimes = hasAnyRecordedTimes();
  document.getElementById('manageBtn').disabled = (!isAdmin || (!cRId && !hasTimes));

  renderRaceSelectionUI();
  renderClassesUI();

  if (!document.getElementById('manageSection').classList.contains('hidden')) {
    renderManageTable();
  }
}

function switchTab(g) {
  currentGroup = g;

  document.getElementById('lowerPrimaryTab')
    .classList.toggle('active', g==='lowerPrimary');
  document.getElementById('minisTab')
    .classList.toggle('active', g==='minis');
  document.getElementById('juniorTab')
    .classList.toggle('active', g==='junior');
  document.getElementById('seniorTab')
    .classList.toggle('active', g==='senior');

  updateUI();
}

/*******************************
 * RACE SELECT UI
 *******************************/
function renderRaceSelectionUI(){
  const sList= document.getElementById('raceListSelect');
  const sTitle= document.getElementById('raceSelectionTitle');
  const gObj= raceData[currentGroup];
  if(!gObj) return;
  sTitle.textContent= `Select or Create Race for ${currentGroup.toUpperCase()}`;
  sList.innerHTML='';
  Object.entries(gObj.races).forEach(([rId,rO])=>{
    const opt= document.createElement('option');
    opt.value= rId;
    let lbl= rO.name || rId;
    if(rO.isRunning) lbl+=' (running)';
    if(rO.isPaused) lbl+=' (paused)';
    if(rO.isEnded) lbl+=' (ended)';
    opt.textContent= lbl;
    if(gObj.currentRaceId === rId) opt.selected=true;
    sList.appendChild(opt);
  });
}

/*******************************
 * CLASSES UI => 5-col grid
 *******************************/
function renderClassesUI() {
  const cEl = document.getElementById('classContainer');

  // Create an in-memory fragment to build out the new contents.
  const frag = document.createDocumentFragment();

  const gCfg = configData[currentGroup];
  if (!gCfg) {
    const div = document.createElement('div');
    div.textContent = 'No group data.';
    frag.appendChild(div);
    // Replace the old container's children with the new fragment.
    cEl.replaceChildren(frag);
    return;
  }

  const cRId = raceData[currentGroup].currentRaceId;
  if (!cRId) {
    const div = document.createElement('div');
    div.textContent = 'No race selected.';
    frag.appendChild(div);
    cEl.replaceChildren(frag);
    return;
  }

  const rO = raceData[currentGroup].races[cRId];

  gCfg.classes.forEach(cls => {
    const clsDiv = document.createElement('div');
    clsDiv.classList.add('class-block');

    const clsTitle = document.createElement('h4');
    clsTitle.textContent = cls.name;
    clsDiv.appendChild(clsTitle);

    // Grid container
    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(5, minmax(100px, 1fr))';
    grid.style.gap = '4px';

    cls.students.forEach(stu => {
      const cell = document.createElement('div');
      cell.style.border = '1px solid #ccc';
      cell.style.padding = '4px';

      const nameLabel = document.createElement('div');
      nameLabel.style.fontSize = '0.8rem';
      nameLabel.style.fontWeight = 'bold';
      nameLabel.textContent = stu;
      cell.appendChild(nameLabel);

      const lapsArr = rO.recordedTimes[stu] || [];
      let doneStr = lapsArr.includes('Injured') ? 'Injured' : `${lapsArr.length}/${rO.laps}`;
      const lapsDiv = document.createElement('div');
      lapsDiv.textContent = 'Laps: ' + doneStr;
      lapsDiv.style.margin = '4px 0';
      cell.appendChild(lapsDiv);

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';

      // PLUS button
      const plusBtn = document.createElement('button');
      plusBtn.textContent = '+';
      plusBtn.style.width = '24px';
      plusBtn.style.height = '24px';
      if (lapsArr.includes('Injured') || lapsArr.length >= rO.laps) {
        plusBtn.disabled = true;
      }
      plusBtn.addEventListener('click', () => handlePlusLap(stu));
      row.appendChild(plusBtn);

      // MINUS button
      const minusBtn = document.createElement('button');
      minusBtn.textContent = '-';
      minusBtn.style.width = '24px';
      minusBtn.style.height = '24px';
      if (!lapsArr.length || lapsArr.includes('Injured')) {
        minusBtn.disabled = true;
      }
      minusBtn.addEventListener('click', () => handleMinusLap(stu));
      row.appendChild(minusBtn);

      cell.appendChild(row);
      grid.appendChild(cell);
    });

    clsDiv.appendChild(grid);
    frag.appendChild(clsDiv);
  });

  // Finally, replace the children of #classContainer in one go
  cEl.replaceChildren(frag);
}


function handlePlusLap(stu){
  const rObj= getRaceObj();
  if(!rObj||!rObj.isRunning){
    showConfirmation("No running race");
    return;
  }
  let arr= rObj.recordedTimes[stu]||[];
  if(arr.includes("Injured")|| arr.length>= rObj.laps){
    showConfirmation("Student is done or injured");
    return;
  }
  const elapsed= Date.now()- (rObj.startTime||0);
  const timeSec= parseFloat((elapsed/1000).toFixed(3));
  socket.emit('registerTime',{ group:currentGroup, studentName:stu, time: timeSec});
}
function handleMinusLap(stu){
  const rObj= getRaceObj();
  if(!rObj|| !rObj.isRunning){
    showConfirmation("No running race => can't remove lap");
    return;
  }
  let arr= rObj.recordedTimes[stu]||[];
  if(!arr.length|| arr.includes("Injured")){
    showConfirmation("No laps or student is injured");
    return;
  }
  // confirm
  if(!confirm(`Remove last lap from ${stu}?`)) return;
  // We'll call the server "removeLap" event
  socket.emit('removeLap', { group: currentGroup, studentName: stu });
  // The server will broadcast raceDataUpdated, so no local mutation needed
}

/***************************************
 * TIMERS
 ***************************************/
function updateTimers(){
  updateGroupTimer('lowerPrimary', document.getElementById('timeDisplayLowerPrimary'));
  updateGroupTimer('minis', document.getElementById('timeDisplayMinis'));
  updateGroupTimer('junior', document.getElementById('timeDisplayJunior'));
  updateGroupTimer('senior', document.getElementById('timeDisplaySenior'));
}

function updateGroupTimer(g, el){
  if(!raceData[g]){
    el.textContent= `${g} Timer: 00:00:00.000`;
    return;
  }
  const cR= raceData[g].currentRaceId;
  if(!cR){
    el.textContent= `${g} Timer: 00:00:00.000`;
    return;
  }
  const rO= raceData[g].races[cR];
  // If there's a server-driven countdown in progress, show that
  if (rO.isCountingDown && rO.countdownRemaining > 0) {
    el.textContent= `${g} Countdown: ${rO.countdownRemaining}s`;
    return;
  }
  // else show normal timer
  if(rO.isRunning && rO.startTime){
    const elapsed= Date.now()- rO.startTime;
    el.textContent= g+" Timer: "+ formatMs(elapsed);
  } else if(rO.isPaused && rO.pausedOffset){
    el.textContent= g+" Timer: "+ formatMs(rO.pausedOffset);
  } else {
    el.textContent= g+" Timer: 00:00:00.000";
  }
}

function formatMs(ms){
  const hh= Math.floor(ms/3600000); ms%=3600000;
  const mm= Math.floor(ms/60000);   ms%=60000;
  const ss= Math.floor(ms/1000);
  const msec= ms%1000;
  return (
    String(hh).padStart(2,'0')+':'+
    String(mm).padStart(2,'0')+':'+
    String(ss).padStart(2,'0')+'.'+
    String(msec).padStart(3,'0')
  );
}
function getRaceObj(){
  const grp= raceData[currentGroup];
  if(!grp) return null;
  const cR= grp.currentRaceId;
  if(!cR) return null;
  return grp.races[cR];
}

/***************************************
 * SEARCH
 ***************************************/
function handleSearchInput(inp, results){
  const q= inp.value.toLowerCase();
  if(!q){
    results.innerHTML='';
    results.style.display='none';
    return;
  }
  let matches=[];
  Object.keys(configData).forEach(g=>{
    configData[g].classes.forEach(cls=>{
      cls.students.forEach(s=>{
        if(s.toLowerCase().includes(q)){
          matches.push({group:g, student:s});
        }
      });
    });
  });
  if(!matches.length){
    results.innerHTML='';
    results.style.display='none';
    return;
  }
  results.innerHTML='';
  results.style.display='block';
  matches.forEach(m=>{
    const d= document.createElement('div');
    d.textContent= `${m.student} (${m.group})`;
    d.style.cursor='pointer';
    results.appendChild(d);
  });
}
function handleSearchClick(e){
  if(e.target && e.target.nodeName==='DIV'){
    const txt= e.target.textContent;
    const mat= txt.match(/^(.*)\s\((\w+)\)$/);
    if(!mat) return;
    const stu= mat[1];
    const grp= mat[2];
    quickRegisterStudent(grp, stu);
    document.getElementById('searchInput').value='';
    document.getElementById('searchResults').style.display='none';
  }
}
function quickRegisterStudent(g, stu){
  if(!userRole){
    alert("Login first");
    return;
  }
  const gObj= raceData[g];
  if(!gObj){
    showConfirmation("No group data");
    return;
  }
  const cR= gObj.currentRaceId;
  if(!cR){
    showConfirmation("No race selected for that group");
    return;
  }
  const rO= gObj.races[cR];
  if(!rO.isRunning){
    showConfirmation("Race not running");
    return;
  }
  let arr= rO.recordedTimes[stu]||[];
  if(arr.includes("Injured")|| arr.length>= rO.laps){
    showConfirmation("Student is done or injured");
    return;
  }
  const elapsed= Date.now()- (rO.startTime||0);
  const timeSec= parseFloat((elapsed/1000).toFixed(3));
  socket.emit('registerTime',{ group:g, studentName:stu, time:timeSec });
}

/***************************************
 * MANAGE
 ***************************************/
function handleManage(){
  if(userRole!=='admin'){
    alert("Admin only");
    return;
  }
  const allRaces= getAllRaceIDs();
  if(!allRaces.length){
    alert("No races found to edit");
    return;
  }
  // build a map => raceId => name
  const raceMap={};
  Object.keys(raceData).forEach(g=>{
    Object.entries(raceData[g].races).forEach(([rid,rObj])=>{
      raceMap[rid]= rObj.name|| rid;
    });
  });
  const lines= Object.entries(raceMap).map(([rid,nm])=> `${rid} => ${nm}`);
  const choice= prompt("Which Race?\n"+ lines.join("\n"));
  if(!choice) return;

  let chosenId= null;
  for(const [rid,nm] of Object.entries(raceMap)){
    if(choice.startsWith(rid) || choice===nm){
      chosenId= rid;
      break;
    }
  }
  if(!chosenId){
    alert("No matching ID or name found");
    return;
  }
  const foundGroup= findGroupForRace(chosenId);
  if(!foundGroup){
    alert("Could not find group for that race ID");
    return;
  }
  raceData[foundGroup].currentRaceId= chosenId;
  currentGroup= foundGroup;
  document.getElementById('manageSection').classList.remove('hidden');
  renderManageTable();
  switchTab(foundGroup);
  updateUI();
}

function getAllRaceIDs(){
  const out=[];
  Object.keys(raceData).forEach(g=>{
    Object.keys(raceData[g].races).forEach(rId=>{
      out.push(rId);
    });
  });
  return out;
}
function findGroupForRace(rId){
  for(const g of Object.keys(raceData)){
    if(rId in raceData[g].races){
      return g;
    }
  }
  return null;
}

function renderManageTable(){
  const tBody= document.querySelector('#registrationsTable tbody');
  tBody.innerHTML='';
  const cG= raceData[currentGroup];
  if(!cG|| !cG.currentRaceId) return;
  const rObj= cG.races[cG.currentRaceId];
  if(!rObj) return;

  Object.entries(rObj.recordedTimes).forEach(([stu, arr])=>{
    const tr= document.createElement('tr');

    const groupTd= document.createElement('td');
    groupTd.textContent= currentGroup;
    tr.appendChild(groupTd);

    const raceTd= document.createElement('td');
    raceTd.textContent= rObj.name|| cG.currentRaceId;
    tr.appendChild(raceTd);

    const studentTd= document.createElement('td');
    studentTd.textContent= stu;
    tr.appendChild(studentTd);

    const timesTd= document.createElement('td');
    if(Array.isArray(arr)){
      timesTd.innerHTML= arr.map((val,i)=> `Lap ${i+1}: ${val}`).join('<br/>');
    } else {
      timesTd.textContent= arr;
    }
    tr.appendChild(timesTd);

    // actions
    const actionsTd= document.createElement('td');
    // reassign => last lap
    const reBtn= document.createElement('button');
    reBtn.textContent='Reassign';
    reBtn.classList.add('btn','btn-secondary');
    reBtn.addEventListener('click',()=>{
      if(!arr.length) return;
      const lastVal= arr[arr.length-1];
      doReassign(currentGroup, cG.currentRaceId, stu, lastVal);
    });
    actionsTd.appendChild(reBtn);

    // edit => last lap
    const edBtn= document.createElement('button');
    edBtn.textContent='Edit Time';
    edBtn.classList.add('btn','btn-primary');
    edBtn.style.marginLeft='5px';
    edBtn.addEventListener('click',()=>{
      if(!arr.length) return;
      const lastVal= arr[arr.length-1];
      doEditTime(currentGroup, cG.currentRaceId, stu, lastVal);
    });
    actionsTd.appendChild(edBtn);

    if(rObj.finalTimes && rObj.finalTimes[stu]!==undefined){
      const finalVal= rObj.finalTimes[stu];
      const finalSpan= document.createElement('span');
      finalSpan.style.marginLeft='10px';
      finalSpan.style.fontWeight='bold';
      finalSpan.textContent= (finalVal==='Injured')
        ? 'Injured'
        : `Final: ${finalVal}s`;
      actionsTd.appendChild(finalSpan);
    }

    tr.appendChild(actionsTd);
    tBody.appendChild(tr);
  });
}

function doReassign(grp, rId, oldStu, lastVal){
  const newStu= prompt("Enter new student name:");
  if(!newStu) return;
  socket.emit('reassignStudent',{
    group:grp,
    oldStudent:oldStu,
    newStudent:newStu,
    newTime:lastVal
  });
}
function doEditTime(grp, rId, stu, oldVal){
  const newValStr= prompt(`New time (old: ${oldVal})`);
  if(!newValStr|| isNaN(parseFloat(newValStr))) return;
  const newVal= parseFloat(newValStr);
  socket.emit('editTime',{ group:grp, studentName:stu, newTime:newVal});
}

/***************************************
 * UTILS
 ***************************************/
function showConfirmation(msg){
  const msgEl= document.getElementById('confirmationMsg');
  msgEl.textContent= msg;
  setTimeout(()=> { msgEl.textContent='';},3000);
}
function hasAnyRecordedTimes(){
  for(const grp of Object.keys(raceData)){
    const gObj= raceData[grp];
    for(const rId of Object.keys(gObj.races)){
      if(Object.keys(gObj.races[rId].recordedTimes).length>0){
        return true;
      }
    }
  }
  return false;
}
