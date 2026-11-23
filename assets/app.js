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
      speaking:     { label:"Speaking / Delivery", weight:50 },
      stories:      { label:"Prep & Stories",      weight:50 }
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
   2 = your spec. 1 = all mocks equal. 3 = even more recency-biased.      */
const DECAY = 2;

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
const ROLE_KEY    = "acgiba_role";

/* ======================= 2. DATA LAYER ======================= */

const DB = {
  participants: [],
  mocks: [],
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

    // Local edits fully supersede the seed file once a coach has saved anything.
    if(local && local.participants){
      this.participants = local.participants;
      this.mocks = local.mocks || [];
    }else{
      this.participants = seed.participants || [];
      this.mocks = seed.mocks || [];
    }
    this.loaded = true;
    return this;
  },

  save(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        participants:this.participants, mocks:this.mocks,
        savedAt:new Date().toISOString()
      }));
      return true;
    }catch(e){
      console.error("[acgiba] save failed", e);
      return false;
    }
  },

  hasLocalEdits(){
    try{ return !!localStorage.getItem(STORAGE_KEY); }catch(e){ return false; }
  },

  resetLocal(){
    try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
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

  deleteMock(id){
    this.mocks = this.mocks.filter(m=>m.id!==id);
    this.save();
  },

  /* Removing a member also removes their mocks. Leaving orphaned mocks behind
     would keep inflating the logged-mock count and could resurrect a profile
     if the same id were ever reused. */
  deleteParticipant(id){
    const removed = this.mocks.filter(m=>m.participantId===id).length;
    this.participants = this.participants.filter(p=>p.id!==id);
    this.mocks        = this.mocks.filter(m=>m.participantId!==id);
    this.save();
    return removed;
  },

  /* Wipe everything and fall back to whatever is committed in roster.json. */
  clearAll(){
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
