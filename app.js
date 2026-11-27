import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { VRButton } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/webxr/VRButton.js";

const $ = id => document.getElementById(id);
const statusEl = $("status");
const setStatus = message => statusEl.textContent = message;

const DIFFS = ["Easy", "Normal", "Hard", "Expert", "ExpertPlus"];
const RANKS = { Easy:1, Normal:3, Hard:5, Expert:7, ExpertPlus:9 };
const DIRS = ["Up","Down","Left","Right","Up-Left","Up-Right","Down-Left","Down-Right","Dot"];
const GRID_X = 4, GRID_Y = 3, CELL = 0.48;
let activeDiff = "Expert";
let levels = Object.fromEntries(DIFFS.map(d => [d, []]));
let nextId = 1, selectedId = null, noteColor = 0, noteDirection = 0;
let bpm = 120, offset = 0, snap = 0.25, songTitle = "Untitled Song", artist = "Unknown Artist", mapper = "Mapper";
let audio = new Audio(), audioUrl = null, audioFile = null, audioDuration = 0;
let isPlaying = false, manualBeat = 0, lastFrame = performance.now();
let undoStack = [], redoStack = [];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x080d18);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, 1.55, 4.8);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures:["local-floor","bounded-floor"] }));
scene.add(new THREE.HemisphereLight(0xb9d4ff, 0x172036, 2.0));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(2, 5, 4); scene.add(keyLight);

const world = new THREE.Group(); scene.add(world);
const panelGroup = new THREE.Group(); scene.add(panelGroup);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const controllers = [];
const interactive = [];
const noteMeshes = new Map();
let dragNote = null;
let currentPanel = "editor";
let keyboardTarget = null;
let keyboardValue = "";

function roundedPanel(w,h,color=0x111b2d) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w,h), new THREE.MeshBasicMaterial({color, side:THREE.DoubleSide}));
  return mesh;
}
function canvasTexture(text, opts={}) {
  const c = document.createElement("canvas"); c.width = opts.width || 512; c.height = opts.height || 128;
  const ctx = c.getContext("2d");
  ctx.clearRect(0,0,c.width,c.height);
  ctx.fillStyle = opts.bg || "#17243b"; ctx.fillRect(0,0,c.width,c.height);
  ctx.fillStyle = opts.color || "#f0f4ff"; ctx.font = `${opts.weight || 700} ${opts.fontSize || 34}px system-ui`;
  ctx.textAlign = opts.align || "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(text), c.width/2, c.height/2, c.width-24);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function label(text, x,y,z,w=1.2,h=.24, opts={}) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w,h), new THREE.MeshBasicMaterial({map:canvasTexture(text,opts),transparent:false}));
  m.position.set(x,y,z); panelGroup.add(m); return m;
}
function button(text,x,y,z,action,opts={}) {
  const group = new THREE.Group(); group.position.set(x,y,z);
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(opts.w || 1.05, opts.h || .32), new THREE.MeshBasicMaterial({color:opts.color || 0x263a5c, side:THREE.DoubleSide}));
  const tx = new THREE.Mesh(new THREE.PlaneGeometry((opts.w || 1.05)-.05,(opts.h || .32)-.05), new THREE.MeshBasicMaterial({map:canvasTexture(text,{bg:"#263a5c",fontSize:opts.fontSize || 27}),side:THREE.DoubleSide}));
  tx.position.z = .006; group.add(bg,tx); panelGroup.add(group);
  bg.userData.action = action; bg.userData.kind = "button"; interactive.push(bg);
  tx.userData.action = action; tx.userData.kind = "button"; interactive.push(tx);
  return group;
}
function clearPanel() {
  for (const child of [...panelGroup.children]) {
    panelGroup.remove(child);
    child.traverse(o => { if(o.geometry)o.geometry.dispose(); if(o.material){ if(o.material.map)o.material.map.dispose(); o.material.dispose(); }});
  }
  interactive.splice(0, interactive.length);
}
function makePanel(title, subtitle="") {
  clearPanel();
  const bg = roundedPanel(3.0,2.0,0x101a2b); bg.position.set(0,1.55,-1.45); panelGroup.add(bg);
  label(title,0,2.36,-1.43,2.7,.25,{bg:"#101a2b",fontSize:34});
  if(subtitle) label(subtitle,0,2.12,-1.43,2.7,.17,{bg:"#101a2b",fontSize:19,color:"#9fb1d1",weight:500});
}
function currentNotes(){ return levels[activeDiff]; }
function beatNow() {
  if (isPlaying && audio && !audio.paused) return Math.max(0,(audio.currentTime-offset)*bpm/60);
  return Math.max(0,manualBeat);
}
function pushUndo() {
  undoStack.push(JSON.stringify({levels,activeDiff,nextId,selectedId}));
  if(undoStack.length>80) undoStack.shift();
  redoStack.length=0;
}
function restoreState(s) {
  const d=JSON.parse(s); levels=d.levels; activeDiff=d.activeDiff; nextId=d.nextId; selectedId=d.selectedId;
  rebuildNotes(); showEditor();
}
function undo(){ if(!undoStack.length)return; redoStack.push(JSON.stringify({levels,activeDiff,nextId,selectedId})); restoreState(undoStack.pop()); setStatus("Undo."); }
function redo(){ if(!redoStack.length)return; undoStack.push(JSON.stringify({levels,activeDiff,nextId,selectedId})); restoreState(redoStack.pop()); setStatus("Redo."); }

function createTextSprite(text,color="#ffffff") {
  const c=document.createElement("canvas"); c.width=256;c.height=128;
  const ctx=c.getContext("2d");ctx.clearRect(0,0,256,128);
  ctx.fillStyle=color;ctx.font="bold 78px system-ui";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(text,128,64);
  const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(.2,.2),new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false}));
}
function noteObject(n) {
  const g=new THREE.Group();
  const color=n.c===0?0xff465f:0x459bff;
  const body=new THREE.Mesh(new THREE.BoxGeometry(.31,.31,.09),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.18,roughness:.4}));
  g.add(body);
  const arrow=createTextSprite(["↑","↓","←","→","↖","↗","↙","↘","•"][n.d] || "↑");
  arrow.position.z=.055; arrow.scale.set(1.1,1.1,1); g.add(arrow);
  g.position.set((n.x-1.5)*CELL,(n.y-1)*CELL,-.08);
  g.userData.noteId=n.id; world.add(g); noteMeshes.set(n.id,g); return g;
}
function rebuildNotes(){
  for(const obj of noteMeshes.values()){world.remove(obj);obj.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material){if(o.material.map)o.material.map.dispose();o.material.dispose();}});}
  noteMeshes.clear(); currentNotes().forEach(noteObject); updateSelection();
}
function updateSelection(){
  for(const [id,g] of noteMeshes){const chosen=id===selectedId;g.scale.setScalar(chosen?1.16:1);g.children[0].material.emissiveIntensity=chosen?.8:.18;}
}
function selectNote(id){selectedId=id;updateSelection();showEditor();}
function addNote(x,y,beat=beatNow()){
  const b=Math.max(0,Math.round(beat/snap)*snap);
  if(currentNotes().some(n=>n.b===b&&n.x===x&&n.y===y)){setStatus("That cell already has a note at this beat.");return;}
  pushUndo();const n={id:nextId++,b:Number(b.toFixed(4)),x,y,c:noteColor,d:noteDirection,a:0};
  currentNotes().push(n);noteObject(n);selectedId=n.id;updateSelection();showEditor();setStatus(`Placed ${n.c===0?"red":"blue"} note at beat ${n.b.toFixed(2)}.`);
}
function deleteSelected(){
  if(selectedId==null)return;pushUndo();levels[activeDiff]=currentNotes().filter(n=>n.id!==selectedId);
  selectedId=null;rebuildNotes();showEditor();setStatus("Note deleted.");
}
function duplicateSelected(){
  const n=currentNotes().find(n=>n.id===selectedId);if(!n)return;pushUndo();
  const copy={...n,id:nextId++,b:Number((n.b+snap).toFixed(4))};currentNotes().push(copy);selectedId=copy.id;rebuildNotes();showEditor();
}
function rotateSelected(){
  const n=currentNotes().find(n=>n.id===selectedId);if(!n)return;pushUndo();n.d=(n.d+1)%9;rebuildNotes();showEditor();
}
function changeSelectedColor(){
  const n=currentNotes().find(n=>n.id===selectedId);if(!n)return;pushUndo();n.c=1-n.c;rebuildNotes();showEditor();
}

function addGrid(){
  const grid=new THREE.Group();world.add(grid);
  const board=new THREE.Mesh(new THREE.PlaneGeometry(2.25,1.75),new THREE.MeshBasicMaterial({color:0x0e1727,side:THREE.DoubleSide}));
  board.position.set(0,0,-.18);grid.add(board);
  for(let x=0;x<4;x++)for(let y=0;y<3;y++){
    const cell=new THREE.Mesh(new THREE.PlaneGeometry(.43,.43),new THREE.MeshBasicMaterial({color:0x1d2a40,side:THREE.DoubleSide}));
    cell.position.set((x-1.5)*CELL,(y-1)*CELL,-.12);cell.userData={kind:"cell",x,y};grid.add(cell);interactive.push(cell);
    const border=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(.43,.43)),new THREE.LineBasicMaterial({color:0x50617e}));
    border.position.copy(cell.position);border.position.z-=.002;grid.add(border);
  }
  label("NOTE GRID",0,1.05,-.1,1.5,.18,{bg:"#080d18",fontSize:20});
}
addGrid();

function showEditor(){
  currentPanel="editor";makePanel("NOTE EDITOR",`${activeDiff==="ExpertPlus"?"Expert+":activeDiff}  •  Beat ${beatNow().toFixed(2)}  •  ${currentNotes().length} notes`);
  button("SONG",-1.0,1.78,-1.42,showSong,{w:.75});
  button("DIFFICULTY",0,1.78,-1.42,showDifficulty,{w:1.05});
  button("TOOLS",1.0,1.78,-1.42,showTools,{w:.75});
  button("PLAY / PAUSE",-1.0,1.28,-1.42,togglePlay,{w:1.1});
  button("BEAT -",-0.05,1.28,-1.42,()=>seekBeat(-snap),{w:.65});
  button("BEAT +",.75,1.28,-1.42,()=>seekBeat(snap),{w:.65});
  button("RED / BLUE",-1.0,.78,-1.42,()=>{noteColor=1-noteColor;showEditor();setStatus(`New notes: ${noteColor===0?"red":"blue"}.`);},{w:1.1});
  button("DIRECTION",.05,.78,-1.42,()=>{noteDirection=(noteDirection+1)%9;showEditor();setStatus(`New direction: ${DIRS[noteDirection]}.`);},{w:1.0});
  button("SNAP",1.0,.78,-1.42,cycleSnap,{w:.65});
  const selected=currentNotes().find(n=>n.id===selectedId);
  label(selected?`Selected  ${selected.c===0?"RED":"BLUE"}  ${DIRS[selected.d]}  beat ${selected.b.toFixed(2)}`:"Point at a grid cell and press trigger to place a note",0,.25,-1.42,2.65,.18,{bg:"#101a2b",fontSize:19,color:"#c6d4ee",weight:500});
  button("DELETE",-.95,-.25,-1.42,deleteSelected,{w:.75,color:0x673144});
  button("DUPLICATE",0,-.25,-1.42,duplicateSelected,{w:.95});
  button("ROTATE",.95,-.25,-1.42,rotateSelected,{w:.75});
  button("UNDO",-.65,-.72,-1.42,undo,{w:.75});
  button("REDO",.25,-.72,-1.42,redo,{w:.75});
  button("EXPORT",-1.0,-1.12,-1.42,showExport,{w:.85,color:0x315b55});
  button("SAVE PROJECT",.15,-1.12,-1.42,saveProject,{w:1.25});
  button("LOAD PROJECT",1.1,-1.12,-1.42,()=> $("projectPicker").click(),{w:1.15});
  updateSelection();
}
function cycleSnap(){const vals=[1,.5,.25,.125,.0625];snap=vals[(vals.indexOf(snap)+1)%vals.length];showEditor();setStatus(`Snap is ${snap} beat.`);}
function seekBeat(delta){manualBeat=Math.max(0,beatNow()+delta);if(audio&&!audio.paused)audio.currentTime=Math.max(0,manualBeat*60/bpm+offset);showEditor();}
function togglePlay(){if(!audioFile){setStatus("Import a song in the Song panel first.");showSong();return;}if(audio.paused){audio.play().then(()=>{isPlaying=true;setStatus("Playing song.");}).catch(e=>setStatus("Playback failed: "+e.message));}else{audio.pause();isPlaying=false;setStatus("Paused.");}}
function showSong(){
  currentPanel="song";makePanel("SONG SETUP","Import and configure the audio entirely from the headset");
  button("IMPORT AUDIO FILE",0,1.68,-1.42,()=> $("audioPicker").click(),{w:2.1,h:.4,color:0x315b55});
  label(audioFile?audioFile.name:"No audio selected",0,1.27,-1.42,2.65,.18,{bg:"#101a2b",fontSize:18,color:"#c6d4ee",weight:500});
  button("TITLE  - / +",-.75,.82,-1.42,()=>editText("title"),{w:1.25});
  button("ARTIST",.75,.82,-1.42,()=>editText("artist"),{w:1.0});
  label(songTitle,0,.48,-1.42,2.4,.18,{bg:"#101a2b",fontSize:20});
  label(artist,0,.25,-1.42,2.4,.18,{bg:"#101a2b",fontSize:18,color:"#aebdd7",weight:500});
  button("MAPPER",0,-.02,-1.42,()=>editText("mapper"),{w:1.0});
  button("BPM -",-.8,-.2,-1.42,()=>{bpm=Math.max(1,bpm-1);showSong();},{w:.7});
  button(`BPM ${bpm}` ,0,-.2,-1.42,()=>{bpm=Math.max(1,bpm+1);showSong();},{w:.8});
  button("BPM +",.8,-.2,-1.42,()=>{bpm+=1;showSong();},{w:.7});
  button("OFFSET -",-.8,-.65,-1.42,()=>{offset-=.01;showSong();},{w:.9});
  button(`OFFSET ${offset.toFixed(2)}s`,0,-.65,-1.42,()=>{offset+=.01;showSong();},{w:1.0});
  button("OFFSET +",.8,-.65,-1.42,()=>{offset+=.01;showSong();},{w:.9});
  button("BACK TO EDITOR",0,-1.12,-1.42,showEditor,{w:1.6});
}
function editText(which){
  keyboardTarget=which;
  keyboardValue=which==="title"?songTitle:which==="artist"?artist:mapper;
  showKeyboard();
}
function showKeyboard(){
  currentPanel="keyboard";
  makePanel("VIRTUAL KEYBOARD",`Editing ${keyboardTarget}. Select keys with your controller`);
  label(keyboardValue || " ",0,1.72,-1.42,2.65,.24,{bg:"#101a2b",fontSize:25});
  const rows=["1234567890","QWERTYUIOP","ASDFGHJKL","ZXCVBNM"];
  rows.forEach((row,r)=>{
    const chars=row.split("");
    const start=-(chars.length-1)*.135;
    chars.forEach((ch,i)=>button(ch,start+i*.27,1.18-r*.36,-1.42,()=>{if(keyboardValue.length<32)keyboardValue+=ch;showKeyboard();},{w:.23,h:.25,fontSize:19}));
  });
  button("SPACE",-0.68,-.42,-1.42,()=>{if(keyboardValue.length<32)keyboardValue+=" ";showKeyboard();},{w:.75});
  button("BACKSPACE",.25,-.42,-1.42,()=>{keyboardValue=keyboardValue.slice(0,-1);showKeyboard();},{w:1.05});
  button("CANCEL",-.55,-.9,-1.42,()=>{keyboardTarget=null;showSong();},{w:.85,color:0x673144});
  button("DONE",.55,-.9,-1.42,()=>{if(keyboardTarget==="title")songTitle=keyboardValue;else if(keyboardTarget==="artist")artist=keyboardValue;else mapper=keyboardValue;keyboardTarget=null;showSong();},{w:.85,color:0x315b55});
}
function showDifficulty(){
  currentPanel="difficulty";makePanel("DIFFICULTIES","Select a difficulty to edit");
  DIFFS.forEach((d,i)=>button(d==="ExpertPlus"?"EXPERT +":d,0,1.55-i*.43,-1.42,()=>{activeDiff=d;selectedId=null;rebuildNotes();showEditor();setStatus(`Editing ${d}.`);},{w:1.8,color:d===activeDiff?0x315b55:0x263a5c}));
  button("COPY FROM LOWER",0,-.72,-1.42,()=>{const i=DIFFS.indexOf(activeDiff);if(i===0)return setStatus("Easy has no lower difficulty.");pushUndo();levels[activeDiff]=levels[DIFFS[i-1]].map(n=>({...n,id:nextId++}));selectedId=null;rebuildNotes();showEditor();},{w:1.8});
  button("BACK",0,-1.12,-1.42,showEditor,{w:1.1});
}
function showTools(){
  currentPanel="tools";makePanel("MAPPING TOOLS","Controller shortcuts and note settings");
  button("NEW NOTE RED / BLUE",0,1.62,-1.42,()=>{noteColor=1-noteColor;showTools();},{w:2.0});
  button("CYCLE CUT DIRECTION",0,1.12,-1.42,()=>{noteDirection=(noteDirection+1)%9;showTools();},{w:2.0});
  button("ROTATE SELECTED",0,.62,-1.42,rotateSelected,{w:1.8});
  button("DUPLICATE SELECTED",0,.12,-1.42,duplicateSelected,{w:1.8});
  button("DELETE SELECTED",0,-.38,-1.42,deleteSelected,{w:1.8,color:0x673144});
  button("CLEAR DIFFICULTY",0,-.78,-1.42,showClearConfirm,{w:1.8,color:0x673144});
  button("BACK",0,-1.15,-1.42,showEditor,{w:1.0});
}
function showClearConfirm(){
  currentPanel="clear-confirm";makePanel("CLEAR DIFFICULTY?","This removes every note in the selected difficulty");
  button("YES, DELETE ALL",-.65,.35,-1.42,()=>{pushUndo();levels[activeDiff]=[];selectedId=null;rebuildNotes();showEditor();setStatus("Difficulty cleared.");},{w:1.35,color:0x673144});
  button("CANCEL",.7,.35,-1.42,showTools,{w:1.0});
}
function showExport(){
  currentPanel="export";makePanel("EXPORT BEATMAP","Create a Beat Saber song folder ZIP");
  label("Exports Info.dat and all five Standard difficulties.",0,1.62,-1.42,2.65,.2,{bg:"#101a2b",fontSize:18,color:"#c6d4ee",weight:500});
  label("Audio must be OGG Vorbis for Beat Saber.",0,1.32,-1.42,2.65,.2,{bg:"#101a2b",fontSize:17,color:"#ffcf85",weight:500});
  button("EXPORT ZIP",0,.72,-1.42,exportZip,{w:1.8,h:.42,color:0x315b55});
  button("BACK",0,-1.12,-1.42,showEditor,{w:1.0});
}
function saveProject(){
  const data={format:"quest-vr-beatmap-project",version:1,metadata:{title:songTitle,artist,mapper,bpm,offset},levels};
  download(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),`${slug(songTitle)}.bsmapproject.json`);
  setStatus("Project downloaded. Audio is not embedded, so keep the original audio file.");
}
function loadProjectFile(file){
  const reader=new FileReader();reader.onload=()=>{try{const p=JSON.parse(reader.result);if(p.format!=="quest-vr-beatmap-project")throw Error("Not a Quest VR project.");levels=p.levels;for(const d of DIFFS)levels[d]=Array.isArray(levels[d])?levels[d]:[];songTitle=p.metadata?.title||"Untitled Song";artist=p.metadata?.artist||"Unknown Artist";bpm=p.metadata?.bpm||120;offset=p.metadata?.offset||0;nextId=Math.max(0,...Object.values(levels).flat().map(n=>n.id))+1;selectedId=null;rebuildNotes();showEditor();setStatus("Project loaded.");}catch(e){setStatus("Could not load project: "+e.message);}};reader.readAsText(file);
}
function download(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
function slug(s){return String(s||"beatmap").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"beatmap";}
function makeInfo(){
 return {_version:"2.1.0",_songName:songTitle,_songSubName:"",_songAuthorName:artist,_levelAuthorName:mapper,_beatsPerMinute:bpm,_songTimeOffset:offset,_shuffle:0,_shufflePeriod:0,_previewStartTime:0,_previewDuration:10,_songFilename:"song.ogg",_coverImageFilename:"",_environmentName:"DefaultEnvironment",_allDirectionsEnvironmentName:"GlassDesertEnvironment",_difficultyBeatmapSets:[{_beatmapCharacteristicName:"Standard",_difficultyBeatmaps:DIFFS.map(d=>({_difficulty:d,_difficultyRank:RANKS[d],_beatmapFilename:`${d}Standard.dat`,_noteJumpMovementSpeed:d==="ExpertPlus"?16:d==="Expert"?14:10,_noteJumpStartBeatOffset:0}))}]};
}
function makeBeatmap(notes){
 return {version:"3.3.0",bpmEvents:[],rotationEvents:[],colorNotes:notes.map(n=>({b:n.b,x:n.x,y:n.y,c:n.c,d:n.d,a:n.a||0})).sort((a,b)=>a.b-b.b),bombNotes:[],obstacles:[],sliders:[],burstSliders:[],basicBeatmapEvents:[],colorBoostBeatmapEvents:[],waypoints:[],basicEventTypesWithKeywords:{d:[]},lightColorEventBoxGroups:[],lightRotationEventBoxGroups:[],lightTranslationEventBoxGroups:[],vfxEventBoxGroups:[],useNormalEventsAsCompatibleEvents:false};
}
// Minimal ZIP writer using uncompressed entries. This avoids a third-party ZIP dependency.
const crcTable=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function zipStore(entries){
 const enc=new TextEncoder(),local=[],central=[];let offset=0;
 for(const e of entries){const name=enc.encode(e.name),data=typeof e.data==="string"?enc.encode(e.data):e.data,crc=crc32(data);
  const l=new Uint8Array(30+name.length),v=new DataView(l.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(8,0,true);v.setUint16(10,0,true);v.setUint16(12,0x21,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);l.set(name,30);local.push(l,data);
  const c=new Uint8Array(46+name.length),w=new DataView(c.buffer);w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint16(8,0x800,true);w.setUint16(10,0,true);w.setUint16(12,0,true);w.setUint16(14,0x21,true);w.setUint32(16,crc,true);w.setUint32(20,data.length,true);w.setUint32(24,data.length,true);w.setUint16(28,name.length,true);w.setUint32(42,offset,true);c.set(name,46);central.push(c);offset+=l.length+data.length;
 }
 const join=parts=>{const out=new Uint8Array(parts.reduce((s,p)=>s+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;};
 const cd=join(central),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,cd.length,true);v.setUint32(16,offset,true);return join([...local,cd,end]);
}
async function exportZip(){
 if(!audioFile){setStatus("Import audio first.");return;}
 let audioBytes=new Uint8Array(await audioFile.arrayBuffer());
 const sig=new TextDecoder().decode(audioBytes.slice(0,4));
 if(sig!=="OggS"){setStatus("This audio is not OGG Vorbis. Please import an .ogg file for Beat Saber export. MP3/WAV can be previewed but cannot be packaged directly.");return;}
 const entries=[{name:"Info.dat",data:JSON.stringify(makeInfo(),null,2)}];
 for(const d of DIFFS)entries.push({name:`${d}Standard.dat`,data:JSON.stringify(makeBeatmap(levels[d]),null,2)});
 entries.push({name:"song.ogg",data:audioBytes});
 const zip=zipStore(entries);download(new Blob([zip],{type:"application/zip"}),`${slug(songTitle)}.zip`);setStatus("Beat Saber ZIP exported. Check the Quest Browser downloads.");
}

$("audioPicker").addEventListener("change",e=>{
 const file=e.target.files?.[0];if(!file)return;audioFile=file;if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=URL.createObjectURL(file);audio.src=audioUrl;audio.load();
 audio.onloadedmetadata=()=>{audioDuration=audio.duration;manualBeat=0;showSong();setStatus(`Loaded ${file.name}.`);};
 audio.onerror=()=>setStatus("The browser could not decode this audio file.");e.target.value="";
});
$("projectPicker").addEventListener("change",e=>{const f=e.target.files?.[0];if(f)loadProjectFile(f);e.target.value="";});

function addController(index){
 const c=renderer.xr.getController(index);scene.add(c);
 const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(0,0,-8)]),new THREE.LineBasicMaterial({color:0x9dbdff,transparent:true,opacity:.75}));
 c.add(line);c.addEventListener("selectstart",()=>controllerClick(c));c.addEventListener("squeezestart",()=>controllerGrab(c));c.addEventListener("squeezeend",()=>dragNote=null);controllers.push(c);
}
function controllerRay(c){const p=new THREE.Vector3();const q=new THREE.Quaternion();c.getWorldPosition(p);c.getWorldQuaternion(q);return new THREE.Ray(p,new THREE.Vector3(0,0,-1).applyQuaternion(q));}
function controllerClick(c){
 const ray=controllerRay(c);raycaster.ray.copy(ray);const hits=raycaster.intersectObjects(interactive,true);
 if(hits.length){const o=hits[0].object;if(o.userData.action){o.userData.action();return;}if(o.userData.kind==="cell"){addNote(o.userData.x,o.userData.y);return;}}
 const noteHits=raycaster.intersectObjects([...noteMeshes.values()],true);if(noteHits.length){const root=noteHits[0].object.parent;selectNote(root.userData.noteId);}
}
function controllerGrab(c){
 const ray=controllerRay(c);raycaster.ray.copy(ray);const hits=raycaster.intersectObjects([...noteMeshes.values()],true);
 if(hits.length){const root=hits[0].object.parent;const id=root.userData.noteId;selectedId=id;pushUndo();dragNote={id};updateSelection();}
}
function updateDrag(c){
 if(!dragNote)return;const ray=controllerRay(c);const plane=new THREE.Plane(new THREE.Vector3(0,0,1),0.08);const p=new THREE.Vector3();if(!ray.intersectPlane(plane,p))return;
 const x=Math.max(0,Math.min(3,Math.round(p.x/CELL+1.5))),y=Math.max(0,Math.min(2,Math.round(p.y/CELL+1)));
 const n=currentNotes().find(n=>n.id===dragNote.id);if(!n)return;n.x=x;n.y=y;const g=noteMeshes.get(n.id);g.position.set((x-1.5)*CELL,(y-1)*CELL,-.08);
}
addController(0);addController(1);
renderer.domElement.addEventListener("pointerdown",e=>{
 if(renderer.xr.isPresenting)return;pointer.x=e.clientX/innerWidth*2-1;pointer.y=-(e.clientY/innerHeight)*2+1;raycaster.setFromCamera(pointer,camera);
 const hits=raycaster.intersectObjects(interactive,true);if(hits.length&&hits[0].object.userData.action)hits[0].object.userData.action();
 else if(hits.length&&hits[0].object.userData.kind==="cell")addNote(hits[0].object.userData.x,hits[0].object.userData.y);
});
renderer.xr.addEventListener("sessionstart",()=>setStatus("VR active. Trigger selects, grip grabs notes."));
renderer.xr.addEventListener("sessionend",()=>setStatus("Desktop preview mode."));
window.addEventListener("resize",()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
function animate(){
 const now=performance.now();const dt=Math.min(.05,(now-lastFrame)/1000);lastFrame=now;
 if(!audio.paused&&audio.currentTime>=audioDuration){audio.pause();isPlaying=false;}
 if(renderer.xr.isPresenting&&dragNote){const c=controllers.find(x=>x.inputSource?.handedness==="right")||controllers[0];if(c)updateDrag(c);}
 renderer.render(scene,camera);
}
renderer.setAnimationLoop(animate);
showEditor();
$("loading").style.display="none";
setStatus("Ready. Enter VR, import an OGG song, set BPM, and place notes.");
