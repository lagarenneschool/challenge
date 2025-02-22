/********************************************************
 * app.js
 *
 * Key Features:
 *  - 120s optional countdown for a brand-new race start
 *  - Resume a paused race immediately
 *  - End race => always confirms, checks incomplete
 *  - Latency display in top-left (ping/pong)
 *  - 4 groups: lowerPrimary, minis, junior, senior
 *  - 5-col grid layout for student names, +/– buttons
 *  - “minus” button calls `removeLap` server event
 ********************************************************/

let socket;
let configData = null;   // from /api/config
let raceData   = null;   // from server
let currentGroup = 'lowerPrimary';
let userRole   = null;
let timerInterval = null;

// We'll measure round-trip latency
let currentLatency = 0;

window.addEventListener('DOMContentLoaded', async () => {
  checkIfLoggedIn();

  // 1) fetch config
  const resp = await fetch('/api/config');
  configData = await resp.json();

  // 2) connect socket
  socket = io();

  // 2a) optional ping/pong for latency
  setInterval(sendPing, 2000);
  socket.on('pongCheck', (serverTime) => {
    const now = performance.now();
    currentLatency = Math.round(now - serverTime);
    const latEl = document.getElementById('latencyDisplay');
    if(latEl) {
      latEl.textContent = `Latency: ${currentLatency}ms`;
    }
  });

  // 3) handle init state
  socket.on('initState', (payload) => {
    raceData = payload.raceData;
    initUI();
    updateUI();
  });

  // 4) handle updates
  socket.on('raceDataUpdated', (payload) => {
    raceData = payload.raceData;
    updateUI();
  });

  // 5) timeRegistered => push
  socket.on('timeRegistered', ({ group, raceId, studentName, time }) => {
    const rObj = raceData[group].races[raceId];
    if(!rObj.recordedTimes[studentName]){
      rObj.recordedTimes[studentName] = [];
    }
    rObj.recordedTimes[studentName].push(time);
    computeFinalTime(rObj, studentName);

    updateUI();
    showConfirmation(
      time==='Injured'
       ? `Student "${studentName}" => Injured`
       : `Student "${studentName}" => ${time} s`
    );
  });

  // Reassigned
  socket.on('studentReassigned', ({ group, raceId, oldStudent, newStudent, newTime }) => {
    const rObj = raceData[group].races[raceId];
    const oldArr = rObj.recordedTimes[oldStudent]||[];
    delete rObj.recordedTimes[oldStudent];
    if(!rObj.recordedTimes[newStudent]){
      rObj.recordedTimes[newStudent] = [];
    }
    if(newTime!==undefined){
      rObj.recordedTimes[newStudent].push(newTime);
    }else{
      rObj.recordedTimes[newStudent].push("Reassigned");
    }
    computeFinalTime(rObj, newStudent);
    updateUI();
    showConfirmation(`Reassigned ${oldStudent} => ${newStudent}`);
  });

  // timeEdited => edit last lap
  socket.on('timeEdited', ({ group, raceId, studentName, newTime }) => {
    const arr = raceData[group].races[raceId].recordedTimes[studentName];
    if(arr && arr.length){
      arr[arr.length-1] = newTime;
    }
    computeFinalTime(raceData[group].races[raceId], studentName);
    updateUI();
    showConfirmation(`Edited ${studentName} => ${newTime}s`);
  });

  timerInterval = setInterval(updateTimers, 200);
});

/********************************
 * HELPER: measure final time
 ********************************/
function computeFinalTime(rObj, studentName){
  if(!rObj.finalTimes){
    rObj.finalTimes = {};
  }
  const arr = rObj.recordedTimes[studentName]||[];
  if(arr.includes('Injured')){
    rObj.finalTimes[studentName] = 'Injured';
    return;
  }
  let sum=0;
  for(let val of arr){
    if(typeof val==='number'){
      sum+= val;
    }
  }
  rObj.finalTimes[studentName] = parseFloat(sum.toFixed(3));
}

/********************************
 * LOGIN
 ********************************/
function checkIfLoggedIn(){
  userRole = localStorage.getItem('userRole');
  if(!userRole){
    window.location.href='index.html';
  }
}

/********************************
 * INIT UI
 ********************************/
function initUI(){
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  // optional: hide switch
  document.getElementById('switchRaceBtn').style.display='none';

  document.getElementById('startRaceBtn').addEventListener('click', handleStartRace);
  document.getElementById('pauseRaceBtn').addEventListener('click', handlePauseRace);
  document.getElementById('endRaceBtn').addEventListener('click', handleEndRace);
  document.getElementById('manageBtn').addEventListener('click', handleManage);

  document.getElementById('createRaceBtn').addEventListener('click', handleCreateRace);
  document.getElementById('loadRaceBtn').addEventListener('click', handleLoadRace);

  document.getElementById('injureOneBtn').addEventListener('click', handleInjureOne);

  // tabs
  document.getElementById('lowerPrimaryTab').addEventListener('click',()=>switchTab('lowerPrimary'));
  document.getElementById('minisTab').addEventListener('click',()=>switchTab('minis'));
  document.getElementById('juniorTab').addEventListener('click',()=>switchTab('junior'));
  document.getElementById('seniorTab').addEventListener('click',()=>switchTab('senior'));

  // search
  const sInput = document.getElementById('searchInput');
  const sResults= document.getElementById('searchResults');
  sInput.addEventListener('input', ()=> handleSearchInput(sInput, sResults));
  sResults.addEventListener('click', handleSearchClick);
}

function doLogout(){
  localStorage.removeItem('userRole');
  window.location.href='index.html';
}

/********************************
 * RACE ACTIONS
 ********************************/
function handleCreateRace(){
  if(userRole!=='admin'){
    alert("Admin only");
    return;
  }
  const name = prompt("Race name?")||'';
  const lapsStr = prompt("How many laps?")||'1';
  let laps = parseInt(lapsStr,10);
  if(isNaN(laps)|| laps<1) laps=1;
  socket.emit('createNewRace',{ group:currentGroup, raceName:name, laps});
}

function handleLoadRace(){
  const sel= document.getElementById('raceListSelect');
  const rId= sel.value;
  if(rId){
    socket.emit('selectRace',{ group:currentGroup, raceId:rId });
  }
}

/** 
 * Start race => if paused => resume
 * else => optionally 120s countdown 
 */
function handleStartRace(){
  if(userRole!=='admin'){
    alert("Admin only");
    return;
  }
  const rObj= getRaceObj();
  if(!rObj){
    showConfirmation("No race selected");
    return;
  }
  if(rObj.isPaused){
    // resume
    if(!confirm("Resume the paused race now?")) return;
    socket.emit('startRace', currentGroup);
    return;
  }
  // brand new start
  const useCountdown = confirm("Start with a 120s countdown?");
  if(!useCountdown){
    socket.emit('startRace', currentGroup);
  } else {
    if(!confirm("120s countdown will begin. OK?")) return;
    let cdown = 120;
    showConfirmation(`Countdown: ${cdown}s`);
    const intId = setInterval(()=>{
      cdown--;
      if(cdown<=0){
        clearInterval(intId);
        showConfirmation("Countdown done. Starting race...");
        socket.emit('startRace', currentGroup);
      }else{
        showConfirmation(`Countdown: ${cdown}s`);
      }
    },1000);
  }
}

function handlePauseRace(){
  if(userRole!=='admin'){
    alert("Admin only");
    return;
  }
  const rObj= getRaceObj();
  if(!rObj|| !rObj.isRunning){
    showConfirmation("No running race to pause.");
    return;
  }
  socket.emit('pauseRace', currentGroup);
}

/** 
 * End => always confirm, check incomplete, then confirm again
 */
function handleEndRace(){
  if(userRole!=='admin'){
    alert("Admin only");
    return;
  }
  const rObj= getRaceObj();
  if(!rObj){
    showConfirmation("No race selected");
    return;
  }
  // incomplete
  const incomplete = getIncompleteStudents(rObj);
  if(incomplete.length>0){
    let msg = "Some students are not done:\n\n"+ incomplete.join("\n");
    msg += "\n\nPress CANCEL to register them, or OK to end anyway.";
    if(!confirm(msg)) return;
  }
  if(!confirm("Are you sure you want to end this race?")) return;
  socket.emit('endRace', currentGroup);
}
function getIncompleteStudents(rObj){
  const gCfg= configData[rObj.group];
  const out=[];
  if(!gCfg) return out;
  gCfg.classes.forEach(cls=>{
    cls.students.forEach(stu=>{
      const arr= rObj.recordedTimes[stu]||[];
      if(!arr.includes("Injured") && arr.length< rObj.laps){
        out.push(stu);
      }
    });
  });
  return out;
}

/********************************
 * INJURE => single prompt
 ********************************/
function handleInjureOne(){
  if(!userRole){
    alert("Log in first");
    return;
  }
  const rObj= getRaceObj();
  if(!rObj|| !rObj.isRunning){
    alert("No running race => can't injure");
    return;
  }
  const allStus= getAllStudentsInGroup(rObj.group);
  if(!allStus.length){
    alert("No students found");
    return;
  }
  const choice= prompt("Select student to injure:\n"+ allStus.join("\n"));
  if(!choice) return;
  if(!allStus.includes(choice)){
    alert("Name not recognized. Must match exactly.");
    return;
  }
  socket.emit('injureStudent',{ group:currentGroup, studentName: choice });
}
function getAllStudentsInGroup(g){
  const arr=[];
  configData[g].classes.forEach(cls=>{
    arr.push(...cls.students);
  });
  return arr;
}

/********************************
 * UI RENDER + update
 ********************************/
function updateUI(){
  if(!raceData[currentGroup]) return;
  const cRId= raceData[currentGroup].currentRaceId|| null;
  const selDiv= document.querySelector('.race-selection');
  selDiv.style.display = cRId ? 'none' : 'block';

  let isRunning=false, isPaused=false;
  if(cRId){
    const rO= raceData[currentGroup].races[cRId];
    isRunning= rO.isRunning;
    isPaused= rO.isPaused;
  }
  const isAdmin= (userRole==='admin');

  // Start Race
  const stBtn= document.getElementById('startRaceBtn');
  stBtn.textContent= isPaused? "Continue Race" : "Start Race";
  stBtn.disabled= (!isAdmin|| !cRId || (isRunning && !isPaused));

  // Pause
  document.getElementById('pauseRaceBtn').disabled= (!isAdmin|| !cRId|| !isRunning);

  // End
  document.getElementById('endRaceBtn').disabled= (!isAdmin|| !cRId|| !isRunning);

  // Manage
  const hasTimes= hasAnyRecordedTimes();
  document.getElementById('manageBtn').disabled= (!isAdmin|| (!cRId && !hasTimes));

  renderRaceSelectionUI();
  renderClassesUI();

  if(!document.getElementById('manageSection').classList.contains('hidden')){
    renderManageTable();
  }
}

function switchTab(g){
  currentGroup=g;
  document.getElementById('lowerPrimaryTab').classList.toggle('active', g==='lowerPrimary');
  document.getElementById('minisTab').classList.toggle('active', g==='minis');
  document.getElementById('juniorTab').classList.toggle('active', g==='junior');
  document.getElementById('seniorTab').classList.toggle('active', g==='senior');
  updateUI();
}

/********************************
 * RACE SELECT UI
 ********************************/
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
    let lbl= rO.name|| rId;
    if(rO.isRunning) lbl+=' (running)';
    if(rO.isPaused) lbl+=' (paused)';
    if(rO.isEnded) lbl+=' (ended)';
    opt.textContent= lbl;
    if(gObj.currentRaceId===rId){
      opt.selected= true;
    }
    sList.appendChild(opt);
  });
}

/********************************
 * CLASSES UI => 5-col grid
 ********************************/
function renderClassesUI(){
  const cEl= document.getElementById('classContainer');
  cEl.innerHTML='';
  const gCfg= configData[currentGroup];
  if(!gCfg){
    cEl.textContent='No group data.';
    return;
  }
  const cRId= raceData[currentGroup].currentRaceId;
  if(!cRId){
    cEl.textContent='No race selected.';
    return;
  }
  const rO= raceData[currentGroup].races[cRId];

  gCfg.classes.forEach(cls=>{
    const clsDiv= document.createElement('div');
    clsDiv.classList.add('class-block');

    const clsTitle= document.createElement('h4');
    clsTitle.textContent= cls.name;
    clsDiv.appendChild(clsTitle);

    // We'll do a 5-col grid
    const grid= document.createElement('div');
    grid.style.display='grid';
    grid.style.gridTemplateColumns='repeat(5, 1fr)';
    grid.style.gap='8px';

    cls.students.forEach(stu=>{
      const cell= document.createElement('div');
      cell.style.border='1px solid #ccc';
      cell.style.padding='6px';

      const nameEl= document.createElement('div');
      nameEl.style.fontSize='0.85rem';
      nameEl.style.fontWeight='bold';
      nameEl.textContent= stu;
      cell.appendChild(nameEl);

      const lapsArr= rO.recordedTimes[stu]||[];
      let doneStr= lapsArr.includes('Injured')? 'Injured': `${lapsArr.length}/${rO.laps}`;
      const lapsDiv= document.createElement('div');
      lapsDiv.textContent= "Laps: " + doneStr;
      lapsDiv.style.margin= '4px 0';
      cell.appendChild(lapsDiv);

      const row= document.createElement('div');
      row.style.display='flex';
      row.style.justifyContent='space-between';

      // plus
      const plusBtn= document.createElement('button');
      plusBtn.textContent='+';
      plusBtn.style.width='30px'; plusBtn.style.height='30px';
      if(lapsArr.includes('Injured')|| lapsArr.length>= rO.laps){
        plusBtn.disabled=true;
      }
      plusBtn.addEventListener('click',()=> handlePlusLap(stu));
      row.appendChild(plusBtn);

      // minus
      const minusBtn= document.createElement('button');
      minusBtn.textContent='-';
      minusBtn.style.width='30px'; minusBtn.style.height='30px';
      if(!lapsArr.length|| lapsArr.includes('Injured')){
        minusBtn.disabled=true;
      }
      minusBtn.addEventListener('click',()=> handleMinusLap(stu));
      row.appendChild(minusBtn);

      cell.appendChild(row);
      grid.appendChild(cell);
    });

    clsDiv.appendChild(grid);
    cEl.appendChild(clsDiv);
  });
}

/********************************
 * plus => registerTime
 ********************************/
function handlePlusLap(stu){
  const rObj= getRaceObj();
  if(!rObj|| !rObj.isRunning){
    showConfirmation("No running race");
    return;
  }
  let arr= rObj.recordedTimes[stu]||[];
  if(arr.includes('Injured')|| arr.length>= rObj.laps){
    showConfirmation("Student is done or injured");
    return;
  }
  const elapsed= Date.now()- (rObj.startTime||0);
  const timeSec= parseFloat((elapsed/1000).toFixed(3));
  socket.emit('registerTime',{ group:currentGroup, studentName: stu, time: timeSec});
}

/********************************
 * minus => removeLap
 ********************************/
function handleMinusLap(stu){
  const rObj= getRaceObj();
  if(!rObj|| !rObj.isRunning){
    showConfirmation("No running race => can't remove lap");
    return;
  }
  let arr= rObj.recordedTimes[stu]||[];
  if(!arr.length|| arr.includes('Injured')){
    showConfirmation("No laps or injured");
    return;
  }
  if(!confirm(`Remove last lap from ${stu}?`)) return;

  // We'll emit removeLap
  socket.emit('removeLap',{ group: currentGroup, studentName: stu });
}

/********************************
 * TIMERS
 ********************************/
function updateTimers(){
  updateGroupTimer('lowerPrimary', document.getElementById('timeDisplayLowerPrimary'));
  updateGroupTimer('minis', document.getElementById('timeDisplayMinis'));
  updateGroupTimer('junior', document.getElementById('timeDisplayJunior'));
  updateGroupTimer('senior', document.getElementById('timeDisplaySenior'));
}
function updateGroupTimer(g, el){
  if(!raceData[g]){
    el.textContent= g+" Timer: 00:00:00.000";
    return;
  }
  const cR= raceData[g].currentRaceId;
  if(!cR){
    el.textContent= g+" Timer: 00:00:00.000";
    return;
  }
  const rO= raceData[g].races[cR];
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
  const gO= raceData[currentGroup];
  if(!gO) return null;
  const cR= gO.currentRaceId;
  if(!cR) return null;
  return gO.races[cR];
}

/********************************
 * SEARCH
 ********************************/
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
          matches.push({ group:g, student:s });
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

/********************************
 * MANAGE
 ********************************/
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
  // build map => raceId => name
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
function toggleManageSection(){
  // not used
}
function renderManageTable(){
  const tBody= document.querySelector('#registrationsTable tbody');
  tBody.innerHTML='';
  const cG= raceData[currentGroup];
  if(!cG|| !cG.currentRaceId) return;
  const rObj= cG.races[cG.currentRaceId];
  if(!rObj) return;

  Object.entries(rObj.recordedTimes).forEach(([stu,arr])=>{
    const tr= document.createElement('tr');

    const grpTd= document.createElement('td');
    grpTd.textContent= currentGroup;
    tr.appendChild(grpTd);

    const raceTd= document.createElement('td');
    raceTd.textContent= rObj.name|| cG.currentRaceId;
    tr.appendChild(raceTd);

    const stuTd= document.createElement('td');
    stuTd.textContent= stu;
    tr.appendChild(stuTd);

    const timesTd= document.createElement('td');
    if(Array.isArray(arr)){
      timesTd.innerHTML= arr.map((val,i)=>`Lap ${i+1}: ${val}`).join('<br/>');
    } else {
      timesTd.textContent= arr;
    }
    tr.appendChild(timesTd);

    // actions
    const actionsTd= document.createElement('td');

    // Reassign => last lap
    const reBtn= document.createElement('button');
    reBtn.textContent='Reassign';
    reBtn.classList.add('btn','btn-secondary');
    reBtn.addEventListener('click',()=>{
      if(!arr.length) return;
      const lastVal= arr[arr.length-1];
      doReassign(currentGroup, cG.currentRaceId, stu, lastVal);
    });
    actionsTd.appendChild(reBtn);

    // Edit => last lap
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

    // finalTime
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
  socket.emit('editTime',{ group:grp, studentName: stu, newTime: newVal});
}

/********************************
 * UTILS
 ********************************/
function showConfirmation(msg){
  const el= document.getElementById('confirmationMsg');
  el.textContent= msg;
  setTimeout(()=> el.textContent='',3000);
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
function getRaceObj(){
  const grp= raceData[currentGroup];
  if(!grp) return null;
  const cR= grp.currentRaceId;
  if(!cR) return null;
  return grp.races[cR];
}
