/* ==========================================================================
   ACG IBA - shared application logic
   --------------------------------------------------------------------------
   SECTIONS
     1. CONFIG        - weights, decay factor, passcodes   <-- EDIT HERE
     2. DATA LAYER    - load seed JSON, overlay local edits, export
     3. SCORING       - recency-weighted ratings engine
     4. GATE          - client-side access control (NOT real security)
     5. UI HELPERS    - nav, formatting, drawer
   ========================================================================== */

/* ======================= 1. CONFIG ======================= */

/* --- Rating model -------------------------------------------------------
   Pillar weights must be the share of OVERALL. Yours: 40 / 40 / 20 = 100. OK.
   Sub-weights are relative WITHIN a pillar and are normalised automatically,
   so they do not have to add to 100 -- but ideally they should.

   Technical sub-weights total exactly 100, so no normalisation is in play.  --------- */
const MODEL = {
  technical: {
    label: "Technical",
    weight: 40,
    subs: {
      accounting:   { label:"Accounting",          weight:30 },
      corpfin:      { label:"Corporate Finance",   weight:10 },
      bonds:        { label:"Bonds / Fixed Income",weight:5  },
      lbo:          { label:"LBO",                 weight:10 },
      mna:          { label:"M&A",                 weight:15 },
      dcf:          { label:"DCF",                 weight:10 },
      ev:           { label:"Enterprise Value",    weight:10 },
      valuation:    { label:"Valuation",           weight:10 }
    }
  },
  behavioral: {
    label: "Behavioral",
    weight: 40,
    subs: {
      speaking:     { label:"Speaking / Delivery", weight:45 },
      stories:      { label:"Prep & Stories",      weight:45 },
      puzzles:      { label:"Puzzles / Brainteasers", weight:10 }
    }
  },
  market: {
    label: "Markets",
    weight: 20,
    subs: {
      market:       { label:"Market Awareness",    weight:100 }
    }
  }
};

/* --- Answer scale -------------------------------------------------------
   Five scores exist. Nothing in between: removing 6-vs-7 arguments is what
   makes two coaches agree.                                                 */
const BANDS = [
  { value: 0,   label: "Didn't know it" },
  { value: 2.5, label: "Knew the term, couldn't explain it" },
  { value: 5,   label: "Correct but incomplete, or needed prompting" },
  { value: 7.5, label: "Complete and correct" },
  { value: 10,  label: "Complete, correct, explained why - unprompted" }
];

/* --- Difficulty weights -------------------------------------------------
   How much a question pulls on its competency average. Asymmetric on
   purpose: getting an easy question right barely counts, missing one counts
   heavily. Hard questions are the 1x baseline both ways.                   */
const DIFFICULTY = {
  E: { label:"Easy",   up:0.25, down:2.5 },
  M: { label:"Medium", up:0.75, down:1.5 },
  H: { label:"Hard",   up:1.0,  down:1.0 }
};

function answerWeight(score, difficulty){
  const d = DIFFICULTY[difficulty] || DIFFICULTY.M;
  if(score > 5) return d.up;
  if(score < 5) return d.down;
  return 1.0;                     // exactly 5 is neutral
}

/* --- Recency decay ------------------------------------------------------
   Each newer mock counts DECAY x as much as the one before it.
   1 = all mocks weigh the same. Higher = more recency-biased.            */
const DECAY = 1.5;

/* --- Access passcodes (SHA-256) -----------------------------------------
   These are OBFUSCATION, NOT SECURITY. A static site cannot keep secrets.
   The codes themselves are deliberately NOT written down in this repository.
   Ask Andrew or Ben for them.
   To change one: run  echo -n "yournewcode" | shasum -a 256  and paste the
   resulting hash below. Never commit the plain-text code.                 */
const GATE_HASHES = {
  coach:  "c4ee3b815382f97703534f75def72e2876ff5f426ef44d099cd737b858ed577e",
  member: "2d61f14eef6f31844f4346ce11940e20208dd529ff993ef3af5054890dec7bc7"
};

/* Question bank, loaded once from data/questions.json. */
const BANK = { questions: [], loaded:false,
  async load(){
    try{
      const r = await fetch("data/questions.json",{cache:"no-store"});
      if(r.ok){ this.questions = (await r.json()).questions || []; }
    }catch(e){ console.warn("[acgiba] questions.json unreachable:", e.message); }
    this.loaded = true;
    return this;
  },
  byCompetency(){
    const out={};
    this.questions.forEach(q=>{ (out[q.competency] = out[q.competency]||[]).push(q); });
    return out;
  },
  get(id){ return this.questions.find(q=>q.id===id); }
};

const STORAGE_KEY = "acgiba_data_v1";
const BACKUP_KEY  = "acgiba_backup_v1";
const ROLE_KEY    = "acgiba_role";

/* ======================= 2. DATA LAYER ======================= */

const DB = {
  participants: [],
  mocks: [],
  version: 0,
  loaded: false,

  async load(){
    let seed = { participants:[], mocks:[] };
    try{
      const res = await fetch("data/roster.json", {cache:"no-store"});
      if(res.ok) seed = await res.json();
    }catch(e){ console.warn("[acgiba] seed roster.json not reachable:", e.message); }

    let local = null;
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(raw) local = JSON.parse(raw);
    }catch(e){ console.warn("[acgiba] local store unreadable"); }

    /* Local edits supersede the committed file - but only if they actually
       contain something AND they are not older than what has been committed.
       data/roster.json carries a version; a local copy records the version it
       was based on. When the committed file moves ahead, it wins, so data
       pushed to the repo reaches browsers that already hold a local copy. */
    const seedVersion  = Number(seed.version||0);
    const localVersion = Number((local&&local.baseVersion)||0);
    const localHasContent = local &&
      ((local.participants||[]).length || (local.mocks||[]).length);

    /* Committed and local are merged rather than one replacing the other.
       Previously the newer of the two won outright, so a coach with
       unpublished mocks lost them to a backup the moment another coach
       published. Merging by id keeps both sides. */
    if(localHasContent){
      const merged = mergeRosters(seed, {
        version: localVersion,
        participants: local.participants || [],
        mocks: local.mocks || [],
        deleted: local.deleted || {mocks:[], participants:[]}
      });
      this.participants = merged.participants;
      this.mocks        = merged.mocks;
      this.deleted      = merged.deleted;
      this.version      = Math.max(seedVersion, localVersion);
      this.source       = (seedVersion > localVersion) ? "merged" : "local";

      const gained = merged.mocks.length - (local.mocks||[]).length;
      if(gained > 0)
        console.info(`[acgiba] merged in ${gained} mock(s) from the committed roster.`);
    }else{
      this.participants = seed.participants || [];
      this.mocks        = seed.mocks || [];
      this.deleted      = seed.deleted || {mocks:[], participants:[]};
      this.source  = "committed";
      this.version = seedVersion;
      if(local) this.resetLocal();     // an empty local copy must not mask the file
    }
    this.loaded = true;
    return this;
  },

  save(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        participants:this.participants, mocks:this.mocks,
        deleted:this.deleted||{mocks:[],participants:[]},
        baseVersion:this.version||0,
        savedAt:new Date().toISOString()
      }));
      return true;
    }catch(e){
      console.error("[acgiba] save failed", e);
      return false;
    }
  },

  /* ---------- publishing ----------
     Commits data/roster.json straight to the repo through the GitHub API, so
     logging a mock and the cohort seeing it are one action instead of export,
     download, commit. The token is a fine-grained PAT scoped to this one repo
     with Contents: read and write. It is held in this browser only: never in
     the repo, never sent anywhere but api.github.com. */
  publishPayload(){
    return {
      version: (Number(this.version)||0) + 1,
      updated: new Date().toISOString(),
      participants: this.participants,
      mocks: this.mocks,
      deleted: this.deleted || {mocks:[], participants:[]}
    };
  },

  /* Unpublished means the local copy has moved past what is committed. */
  unpublishedCount(){
    try{
      const raw=localStorage.getItem(STORAGE_KEY);
      if(!raw) return 0;
      const p=JSON.parse(raw);
      if(p.publishedAt && p.publishedVersion===this.version) return 0;
      return (p.mocks||[]).length ? (p.mocks||[]).length : 0;
    }catch(e){ return 0; }
  },

  markPublished(version){
    this.version = version;
    try{
      const raw=localStorage.getItem(STORAGE_KEY);
      const p = raw?JSON.parse(raw):{};
      p.baseVersion=version; p.publishedVersion=version;
      p.publishedAt=new Date().toISOString();
      localStorage.setItem(STORAGE_KEY,JSON.stringify(p));
    }catch(e){}
  },

  hasLocalEdits(){
    try{
      const raw=localStorage.getItem(STORAGE_KEY);
      if(!raw) return false;
      const p=JSON.parse(raw);
      return !!((p.participants||[]).length || (p.mocks||[]).length);
    }catch(e){ return false; }
  },

  /* Stash whatever is in local storage before throwing it away, so a
     mis-click on Reload or Clear can be undone. */
  backupLocal(){
    try{
      const raw=localStorage.getItem(STORAGE_KEY);
      if(!raw) return false;
      const p=JSON.parse(raw);
      if(!((p.participants||[]).length || (p.mocks||[]).length)) return false;
      localStorage.setItem(BACKUP_KEY, JSON.stringify({...p, discardedAt:new Date().toISOString()}));
      return true;
    }catch(e){ return false; }
  },

  backupInfo(){
    try{
      const raw=localStorage.getItem(BACKUP_KEY);
      if(!raw) return null;
      const p=JSON.parse(raw);
      return { participants:(p.participants||[]).length, mocks:(p.mocks||[]).length,
               discardedAt:p.discardedAt };
    }catch(e){ return null; }
  },

  restoreBackup(){
    try{
      const raw=localStorage.getItem(BACKUP_KEY);
      if(!raw) return false;
      const p=JSON.parse(raw);
      this.participants=p.participants||[]; this.mocks=p.mocks||[];
      this.save();
      localStorage.removeItem(BACKUP_KEY);
      this.source="local";
      return true;
    }catch(e){ return false; }
  },

  resetLocal(){
    try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
  },

  /* Throw away this browser's copy and reload whatever is committed. */
  async reloadFromFile(){
    this.backupLocal();
    this.resetLocal();
    this.participants = []; this.mocks = [];
    return this.load();
  },

  participant(id){ return this.participants.find(p=>p.id===id); },

  mocksFor(id){
    return this.mocks
      .filter(m=>m.participantId===id)
      .sort((a,b)=> new Date(a.date) - new Date(b.date));   // oldest -> newest
  },

  addParticipant(p){
    p.id = p.id || "p_" + Math.random().toString(36).slice(2,9);
    this.participants.push(p);
    this.save();
    return p;
  },

  addMock(m){
    m.id = m.id || "m_" + Math.random().toString(36).slice(2,9);
    m.loggedAt = new Date().toISOString();
    this.mocks.push(m);
    this.save();
    return m;
  },

  mock(id){ return this.mocks.find(m=>m.id===id) || null; },

  /* Edits a logged mock in place. Keeps the id so the recency order and the
     member's history stay the same, and records when it was last changed so a
     corrected score is distinguishable from the original entry. */
  updateMock(id, patch){
    const m = this.mocks.find(x=>x.id===id);
    if(!m) return null;
    Object.assign(m, patch, { id:m.id, loggedAt:m.loggedAt, editedAt:new Date().toISOString() });
    this.save();
    return m;
  },

  /* A merge is additive, so a record simply missing from one copy means
     "not seen yet", not "removed". Deletions are therefore recorded, not
     implied, or the other coach's copy would resurrect them on publish. */
  tombstone(kind, id){
    this.deleted = this.deleted || {mocks:[], participants:[]};
    const list = this.deleted[kind] = this.deleted[kind] || [];
    if(!list.some(t=>t.id===id)) list.push({id, at:new Date().toISOString()});
  },

  deleteMock(id){
    this.mocks = this.mocks.filter(m=>m.id!==id);
    this.tombstone("mocks", id);
    this.save();
  },

  /* Removing a member also removes their mocks. Leaving orphaned mocks behind
     would keep inflating the logged-mock count and could resurrect a profile
     if the same id were ever reused. */
  deleteParticipant(id){
    const doomed  = this.mocks.filter(m=>m.participantId===id);
    const removed = doomed.length;
    this.participants = this.participants.filter(p=>p.id!==id);
    this.mocks        = this.mocks.filter(m=>m.participantId!==id);
    this.tombstone("participants", id);
    doomed.forEach(m=>this.tombstone("mocks", m.id));
    this.save();
    return removed;
  },

  /* Wipe everything and fall back to whatever is committed in roster.json. */
  clearAll(){
    this.backupLocal();
    this.participants = [];
    this.mocks = [];
    this.save();
  },

  exportJSON(){
    const payload = {
      _comment:"ACG IBA roster + mock log. Commit this file to data/roster.json in the GitHub repo.",
      _exportedAt:new Date().toISOString(),
      participants:this.participants,
      mocks:this.mocks
    };
    const blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "roster.json";
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  }
};

/* ======================= 3. SCORING ======================= */
/*
   How a score is produced
   -----------------------
   For ONE sub-metric (e.g. "dcf"):
     - take only the mocks that actually graded it (mocks need not cover all)
     - order oldest -> newest
     - weight the i-th of n mocks by DECAY^i, so the newest counts DECAY x
       the previous one, DECAY^2 x the one before that, and so on
     - weighted mean, rounded to 1dp

   For a PILLAR (e.g. "technical"):
     - weighted mean of its sub-metrics THAT HAVE DATA, using sub-weights
       renormalised over only those present

   For OVERALL:
     - weighted mean of the pillars that have data, pillar weights
       renormalised over only those present
*/

function decayedMean(values){
  if(!values.length) return null;
  let num=0, den=0;
  values.forEach((v,i)=>{
    const w = Math.pow(DECAY, i);      // i=0 oldest ... i=n-1 newest
    num += v*w; den += w;
  });
  return num/den;
}

/* A mock's score for one competency.
   New format: m.answers = [{questionId, competency, difficulty, score}].
   Each answer is weighted by answerWeight, then averaged.
   Old format (m.scores = {competency: number}) is still read, unweighted,
   so mocks logged before the question bank existed keep working. */
function mockCompetencyScore(mock, key){
  if(Array.isArray(mock.answers)){
    const rows = mock.answers.filter(a=>a.competency===key && a.score!=null && a.score!=="");
    if(!rows.length) return null;
    let num=0, den=0;
    rows.forEach(a=>{
      const w = answerWeight(Number(a.score), a.difficulty);
      num += Number(a.score)*w; den += w;
    });
    return den ? num/den : null;
  }
  if(mock.scores && mock.scores[key]!=null && mock.scores[key]!=="")
    return Number(mock.scores[key]);
  return null;
}

function subScore(mocks, key){
  const vals = mocks.map(m=>mockCompetencyScore(m,key)).filter(v=>v!==null);
  const mean = decayedMean(vals);
  return { value: mean===null?null:round1(mean), n: vals.length };
}

/* Which difficulties a mock actually covered, for the coverage label. */
function mockMix(mock){
  const mix={E:0,M:0,H:0};
  (mock.answers||[]).forEach(a=>{ if(mix[a.difficulty]!=null) mix[a.difficulty]++; });
  return mix;
}
function mixLabel(mock){
  const m=mockMix(mock), t=m.E+m.M+m.H;
  if(!t) return "";
  const parts=[]; if(m.E)parts.push(m.E+" easy"); if(m.M)parts.push(m.M+" medium"); if(m.H)parts.push(m.H+" hard");
  return parts.join(", ");
}

function pillarScore(mocks, pillarKey){
  const pillar = MODEL[pillarKey];
  const subs = {};
  let num=0, den=0, graded=0;

  for(const [key,def] of Object.entries(pillar.subs)){
    const s = subScore(mocks, key);
    subs[key] = { ...s, label:def.label, weight:def.weight };
    if(s.value!==null){ num += s.value*def.weight; den += def.weight; graded++; }
  }
  return {
    key: pillarKey,
    label: pillar.label,
    weight: pillar.weight,
    value: den ? round1(num/den) : null,
    coverage: den,                       // sum of sub-weights that had data
    totalWeight: Object.values(pillar.subs).reduce((a,s)=>a+s.weight,0),
    gradedSubs: graded,
    subs
  };
}

function profileScores(participantId, opts={}){
  let mocks = DB.mocksFor(participantId);
  if(opts.excludeLatest && mocks.length) mocks = mocks.slice(0,-1);

  const pillars = {};
  let num=0, den=0;
  for(const key of Object.keys(MODEL)){
    const p = pillarScore(mocks, key);
    pillars[key] = p;
    if(p.value!==null){ num += p.value*p.weight; den += p.weight; }
  }
  return {
    overall: den ? round1(num/den) : null,
    pillars,
    mockCount: mocks.length,
    lastMock: mocks.length ? mocks[mocks.length-1] : null
  };
}

/* Change in overall caused by the most recent mock. */
function trendFor(participantId){
  const all = DB.mocksFor(participantId);
  if(all.length < 2) return null;
  const now  = profileScores(participantId).overall;
  const prev = profileScores(participantId,{excludeLatest:true}).overall;
  if(now===null || prev===null) return null;
  return round1(now - prev);
}

function rankedBoard(){
  const rows = DB.participants.map(p=>{
    const s = profileScores(p.id);
    return { participant:p, ...s, trend:trendFor(p.id) };
  });
  rows.sort((a,b)=>{
    if(a.overall===null && b.overall===null) return a.participant.name.localeCompare(b.participant.name);
    if(a.overall===null) return 1;
    if(b.overall===null) return -1;
    return b.overall - a.overall;
  });
  rows.forEach((r,i)=> r.rank = r.overall===null ? null : i+1);
  return rows;
}

/* ======================= 4. GATE ======================= */

async function sha256(text){
  if(!(window.crypto && window.crypto.subtle))
    throw new Error("insecure-context");   // file:// or plain http
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
}

function currentRole(){
  try{ return sessionStorage.getItem(ROLE_KEY); }catch(e){ return null; }
}
function isCoach(){ return currentRole()==="coach"; }

function signOut(){
  try{ sessionStorage.removeItem(ROLE_KEY); }catch(e){}
  location.reload();
}

/* Renders a blocking overlay until a valid passcode is entered.
   onUnlock() fires once access is granted (immediately if already signed in). */
function requireAccess(onUnlock){
  const existing = currentRole();
  if(existing){ onUnlock(existing); return; }

  document.body.classList.add("locked");
  const gate = document.createElement("div");
  gate.className = "gate";
  gate.innerHTML = `
    <div class="box">
      <div class="lockmark">&#9679;</div>
      <p class="eyebrow on-dark">Members &amp; Coaches</p>
      <h2>Access code required</h2>
      <p>This section holds the roster, ratings, recruiting timeline and coursework. Enter the code shared with the cohort.</p>
      <form id="gateForm" style="margin-top:22px">
        <input type="password" id="gateInput" placeholder="Access code" autocomplete="current-password" autofocus>
        <button class="btn btn-primary" type="submit">Unlock</button>
        <div class="err" id="gateErr"></div>
      </form>
      <div class="hint">
        Coaches use the coach code to unlock mock logging.<br>
        Lost the code? Contact Andrew or Ben.
      </div>
    </div>`;
  document.body.appendChild(gate);

  gate.querySelector("#gateForm").addEventListener("submit", async ev=>{
    ev.preventDefault();
    const val = gate.querySelector("#gateInput").value.trim();
    const err = gate.querySelector("#gateErr");
    if(!val) return;
    let h;
    try{
      h = await sha256(val);
    }catch(e){
      err.innerHTML = "This page needs to be served over https. Open it at its "+
                      "GitHub Pages URL rather than from a local file.";
      return;
    }
    let role = null;
    if(h===GATE_HASHES.coach) role="coach";
    else if(h===GATE_HASHES.member) role="member";

    if(!role){
      err.textContent = "That code isn't recognised.";
      gate.querySelector("#gateInput").value="";
      return;
    }
    try{ sessionStorage.setItem(ROLE_KEY, role); }catch(e){}
    gate.remove();
    document.body.classList.remove("locked");
    onUnlock(role);
  });
}

/* ======================= 5. UI HELPERS ======================= */

/* Escape anything user-entered before it reaches innerHTML. Coach notes and
   member names are free text, so a stray < or & would otherwise corrupt the
   markup (and a script tag would run). */
function esc(v){
  if(v===null||v===undefined) return "";
  return String(v)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function round1(n){ return Math.round(n*10)/10; }

/* Keep every stored score inside the 1-10 scale the model assumes. */
function clampScore(n){
  const v = Number(n);
  if(isNaN(v)) return null;
  return Math.min(10, Math.max(1, v));
}

function scoreClass(v){
  if(v===null||v===undefined) return "s-na";
  if(v>=8) return "s-hi";
  if(v>=6) return "s-mid";
  return "s-lo";
}
function barClass(v){
  if(v>=8) return "hi";
  if(v>=6) return "mid";
  return "lo";
}
function fmtScore(v){ return v===null||v===undefined ? "n/a" : v.toFixed(1); }

function fmtDate(d){
  if(!d) return "";
  const dt = new Date(d+"T12:00:00");
  if(isNaN(dt.getTime())) return esc(d);   // pass through "Rolling", "TBD", typos
  return dt.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
}

function initials(name){
  if(!name) return "?";
  const out = String(name).split(/\s+/).filter(Boolean).slice(0,2)
                .map(w=>w[0].toUpperCase()).join("");
  return esc(out) || "?";
}

function pctOfPillar(subWeight, pillarKey){
  const total = Object.values(MODEL[pillarKey].subs).reduce((a,s)=>a+s.weight,0);
  return Math.round(subWeight/total*1000)/10;
}

/* mobile nav + active link */
function initNav(){
  const btn = document.querySelector(".navtoggle");
  const nav = document.querySelector("nav.main");
  if(btn && nav) btn.addEventListener("click",()=>{
    const open = nav.classList.toggle("open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  const here = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll("nav.main a").forEach(a=>{
    if(a.getAttribute("href")===here) a.setAttribute("aria-current","page");
  });
}

/* simple right-hand drawer */
function openDrawer(html){
  let d = document.querySelector(".drawer");
  if(!d){
    d = document.createElement("div");
    d.className="drawer";
    d.innerHTML = `<div class="scrim"></div><div class="panel"><button class="close" aria-label="Close">&times;</button><div class="panelbody"></div></div>`;
    document.body.appendChild(d);
    d.querySelector(".scrim").addEventListener("click",closeDrawer);
    d.querySelector(".close").addEventListener("click",closeDrawer);
    document.addEventListener("keydown",e=>{ if(e.key==="Escape") closeDrawer(); });
  }
  d.querySelector(".panelbody").innerHTML = html;
  d.classList.add("open");
  document.body.classList.add("locked");
  d.querySelector(".panel").scrollTop = 0;
}
function closeDrawer(){
  const d = document.querySelector(".drawer");
  if(d){ d.classList.remove("open"); document.body.classList.remove("locked"); }
}

document.addEventListener("DOMContentLoaded", initNav);


/* ---------------------------------------------------------------
   GitHub publishing
   The token lives in this browser's localStorage under its own key, kept
   apart from the roster so exporting or clearing the roster never carries it
   along. Scope it to this repo with Contents: read and write and nothing
   else, so the worst case if it leaks is an unwanted commit here.
   --------------------------------------------------------------- */
/* ---------------------------------------------------------------
   Merging two copies of the roster.

   Each coach's browser holds a whole roster, so publishing used to mean
   "replace the file with mine", and whoever published last erased the
   other's mocks. Mocks and members already carry unique ids, so the two
   copies combine by id instead: different ids both survive, and the same
   id is resolved by which copy was touched most recently.

   Deliberately additive. A record missing from one side is treated as
   not-yet-seen, never as deleted, because a coach whose browser never
   loaded a mock would otherwise delete it by publishing. Removing someone
   is therefore done once, in the committed file, not by omission.
   --------------------------------------------------------------- */
function recordTime(r){
  return Date.parse(r && (r.editedAt || r.loggedAt || r.updatedAt || r.createdAt)) || 0;
}

function mergeById(remote, local){
  const out = new Map();
  (remote||[]).forEach(r=>{ if(r && r.id) out.set(r.id, r); });
  (local||[]).forEach(l=>{
    if(!l || !l.id) return;
    const r = out.get(l.id);
    if(!r){ out.set(l.id, l); return; }
    /* Same record on both sides: the more recently touched copy wins. Ties
       go to the remote copy, so a republish of unchanged data is a no-op. */
    out.set(l.id, recordTime(l) > recordTime(r) ? l : r);
  });
  return [...out.values()];
}

/* Tombstones from both copies, newest entry per id. */
function mergeTombstones(a, b){
  const out=new Map();
  [...(a||[]), ...(b||[])].forEach(t=>{
    if(!t || !t.id) return;
    const prev=out.get(t.id);
    if(!prev || Date.parse(t.at||0) > Date.parse(prev.at||0)) out.set(t.id, t);
  });
  return [...out.values()];
}

/* A deletion wins over a copy that still holds the record, unless that copy
   was edited after the deletion was made - in which case the coach was
   working on it later and the edit is the more recent intent. */
function applyTombstones(records, tombs){
  if(!tombs || !tombs.length) return records;
  const byId=new Map(tombs.map(t=>[t.id,t]));
  return records.filter(r=>{
    const t=byId.get(r.id);
    if(!t) return true;
    return recordTime(r) > (Date.parse(t.at||0)||0);
  });
}

function mergeRosters(remote, local){
  if(!remote) return local;

  const deleted = {
    mocks:        mergeTombstones(remote.deleted&&remote.deleted.mocks,
                                  local.deleted&&local.deleted.mocks),
    participants: mergeTombstones(remote.deleted&&remote.deleted.participants,
                                  local.deleted&&local.deleted.participants)
  };

  let participants = applyTombstones(
    mergeById(remote.participants, local.participants), deleted.participants);

  let mocks = applyTombstones(
    mergeById(remote.mocks, local.mocks), deleted.mocks);

  /* A mock whose member is gone has nothing to attach to and would keep
     inflating counts, so it goes with them. */
  const live = new Set(participants.map(p=>p.id));
  mocks = mocks.filter(m=>live.has(m.participantId))
               .sort((a,b)=> new Date(a.date||0) - new Date(b.date||0));

  return {
    version: Math.max(Number(remote.version)||0, Number(local.version)||0) + 1,
    updated: new Date().toISOString(),
    participants,
    mocks,
    deleted
  };
}

const GH = {
  OWNER: "benlavie5-arch",
  REPO:  "acg-iba",
  PATH:  "data/roster.json",
  BRANCH:"main",
  TOKEN_KEY: "acgiba_gh_token",

  token(){ try{ return localStorage.getItem(this.TOKEN_KEY)||""; }catch(e){ return ""; } },

  /* Catches the common paste mistakes before spending a round trip on GitHub,
     which answers all of them with the same unhelpful 401. */
  checkFormat(raw){
    const t=(raw||"").trim();
    if(!t) return "Nothing pasted.";
    if(/^\d+$/.test(t))
      return "That looks like the token's ID number from the address bar, not the token itself.";
    if(/^https?:\/\//.test(t))
      return "That is a URL, not the token.";
    if(/^acg-iba/i.test(t))
      return "That is the token's name, not the token. The token is a long string starting with github_pat_.";
    if(/\s/.test(t))
      return "That contains a space or line break, so part of the copy went wrong. Copy it again in one go.";
    if(!/^(github_pat_|ghp_)/.test(t))
      return "A GitHub token starts with github_pat_ (fine-grained) or ghp_ (classic). This starts with \"" +
             t.slice(0,8).replace(/[<>&"]/g,"") + "...\".";
    if(/^github_pat_/.test(t) && t.length < 60)
      return "That is too short for a fine-grained token, so the copy was cut off. Copy the whole string.";
    return null;      // looks plausible; let GitHub be the judge
  },
  hasToken(){ return !!this.token(); },
  setToken(t){ try{ localStorage.setItem(this.TOKEN_KEY,(t||"").trim()); return true; }catch(e){ return false; } },
  forgetToken(){ try{ localStorage.removeItem(this.TOKEN_KEY); }catch(e){} },

  headers(){
    return {
      "Authorization":"Bearer "+this.token(),
      "Accept":"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28"
    };
  },

  apiUrl(){
    return `https://api.github.com/repos/${this.OWNER}/${this.REPO}/contents/${this.PATH}`;
  },

  /* base64 of UTF-8. btoa alone mangles any non-ASCII character, which would
     corrupt a member name or a note the moment one appeared. */
  b64(str){
    const bytes = new TextEncoder().encode(str);
    let bin=""; bytes.forEach(b=>bin+=String.fromCharCode(b));
    return btoa(bin);
  },

  async currentSha(){
    const r = await fetch(this.apiUrl()+"?ref="+this.BRANCH+"&t="+Date.now(),
                          {headers:this.headers(), cache:"no-store"});
    if(r.status===404) return null;          // first publish
    if(!r.ok) throw new Error(await this.explain(r));
    const j = await r.json();
    return j.sha;
  },

  /* Describes the saved token without revealing it, so a failure can be
     diagnosed without the value ever being read out or pasted anywhere. */
  tokenShape(){
    const t=this.token();
    if(!t) return "none saved";
    const kind = t.startsWith("github_pat_") ? "fine-grained"
               : t.startsWith("ghp_") ? "classic" : "unrecognised prefix";
    return `${kind}, ${t.length} characters, ends ...${t.slice(-4)}`;
  },

  async explain(r){
    let detail="";
    try{ const j=await r.json(); detail=j.message||""; }catch(e){}
    if(r.status===401) return "Token rejected by GitHub (401). "+
      (detail?`GitHub said: "${detail}". `:"")+
      `The saved token is ${this.tokenShape()}. `+
      "A fine-grained token is normally 90 or more characters. If yours is much shorter, "+
      "the copy was cut off. If the length looks right, the token may have been revoked, "+
      "or this browser may be stripping the authorization header.";
    if(r.status===403) return "Token lacks permission. It needs Contents: read and write on this repo.";
    if(r.status===404) return "Repo or file path not found, or the token cannot see this repo.";
    if(r.status===409) return "Someone else changed the file. Reload the page and publish again.";
    if(r.status===422) return "GitHub rejected the commit. "+detail;
    return "GitHub error "+r.status+(detail?": "+detail:"");
  },

  /* Returns the new version number on success. */
  /* Reads the committed file alongside its sha, so a publish can merge into
     what is actually there rather than replacing it. */
  async currentFile(){
    const r = await fetch(this.apiUrl()+"?ref="+this.BRANCH+"&t="+Date.now(),
                          {headers:this.headers(), cache:"no-store"});
    if(r.status===404) return {sha:null, data:null};
    if(!r.ok) throw new Error(await this.explain(r));
    const j = await r.json();
    let data=null;
    try{
      const bin=atob((j.content||"").replace(/\n/g,""));
      const bytes=Uint8Array.from(bin,c=>c.charCodeAt(0));
      data=JSON.parse(new TextDecoder().decode(bytes));
    }catch(e){ console.warn("[acgiba] committed roster unreadable, treating as empty"); }
    return {sha:j.sha, data};
  },

  async publish(payload, message){
    if(!this.hasToken()) throw new Error("No token saved.");

    /* Read, merge, write. If someone else publishes in the gap, GitHub
       rejects the write on a stale sha; re-read and merge again rather than
       making the coach retry by hand. */
    for(let attempt=0; attempt<3; attempt++){
      const {sha, data:remote} = await this.currentFile();
      const merged = mergeRosters(remote, payload);

      const body = {
        message: message || "Update roster from the coach portal",
        content: this.b64(JSON.stringify(merged,null,2)+"\n"),
        branch: this.BRANCH
      };
      if(sha) body.sha = sha;

      const r = await fetch(this.apiUrl(), {
        method:"PUT", headers:{...this.headers(),"Content-Type":"application/json"},
        body: JSON.stringify(body)
      });

      if(r.ok) return merged;
      if(r.status===409 && attempt<2) continue;   // someone beat us to it; merge again
      throw new Error(await this.explain(r));
    }
  },

  /* Walks the request from the outside in: does GitHub answer at all, does it
     recognise the token, does the token see the repo, can it write. Each step
     fails differently, which is what tells you where the problem is. */
  async diagnose(){
    const steps=[];
    const add=(n,ok,note)=>steps.push({step:n,ok,note:note||""});

    add("token saved", this.hasToken(), this.tokenShape());
    if(!this.hasToken()) return steps;

    try{
      const r=await fetch("https://api.github.com/rate_limit");
      add("github reachable", r.ok, "status "+r.status);
    }catch(e){ add("github reachable", false, e.message); return steps; }

    try{
      const r=await fetch("https://api.github.com/user",{headers:this.headers()});
      if(r.ok){ const j=await r.json(); add("token recognised", true, "acting as "+(j.login||"?")); }
      else{
        let d=""; try{ d=(await r.json()).message||""; }catch(e){}
        add("token recognised", false, "status "+r.status+(d?" - "+d:""));
      }
    }catch(e){ add("token recognised", false, e.message); }

    try{
      const r=await fetch(`https://api.github.com/repos/${this.OWNER}/${this.REPO}`,
                          {headers:this.headers()});
      if(r.ok){
        const j=await r.json();
        add("repo visible", true, j.full_name);
        add("write permission", !!(j.permissions&&j.permissions.push),
            j.permissions?("push="+j.permissions.push):"no permissions field");
      }else{
        let d=""; try{ d=(await r.json()).message||""; }catch(e){}
        add("repo visible", false, "status "+r.status+(d?" - "+d:""));
      }
    }catch(e){ add("repo visible", false, e.message); }

    return steps;
  },

  /* Cheap check that a pasted token actually works before it is relied on. */
  async verify(){
    const r = await fetch(`https://api.github.com/repos/${this.OWNER}/${this.REPO}`,
                          {headers:this.headers()});
    if(!r.ok) throw new Error(await this.explain(r));
    const j = await r.json();
    if(!j.permissions || !j.permissions.push)
      throw new Error("Token can read this repo but not write to it. Set Contents to read and write.");
    return true;
  }
};
