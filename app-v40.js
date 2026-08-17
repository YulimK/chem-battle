/* ============================================================
   Chem World v4 — LPC pixel avatars
   Artwork: Liberated Pixel Cup (OpenGameArt.org).
   Credits are shown in-app under 내 정보 → CREDITS.
   ============================================================ */

const APP_BUILD = 'v40-weekly-fix';
console.log('%cChem Battle app.js ' + APP_BUILD, 'background:#e0b74e;color:#241a02;padding:2px 8px;font-weight:700');

const app = document.getElementById('app');
const KEY = 'chemWorldV8';
const TOTAL_WEEKS = 15;

let AV = null;        // avatar manifest
let CREDITS = [];     // credits list
let FRAME = {};       // base frame lookup: id -> frame index
let WEAR = {};        // slot -> [items]

const weekSlots = () => Array.from({ length: 15 }, (_, i) => ({
  week: i + 1, title: `Week ${i + 1}`,
  status: i === 0 ? 'open' : 'locked',
  completionReward: 50, correctReward: 10, questions: []
}));

let db = JSON.parse(localStorage.getItem(KEY) || 'null') || {
  users: {},
  liveQueue: [
    { id: 1, title: 'Live Quiz 1', question: '다음 중 화학식량이 가장 큰 것은?', options: ['H₂O', 'CO₂', 'NH₃'], correct: 1, participationReward: 20, correctReward: 30, status: 'ready', responses: {} },
    { id: 2, title: 'Live Quiz 2', question: '다음 중 이온결합 물질은?', options: ['NaCl', 'H₂O', 'CH₄'], correct: 0, participationReward: 20, correctReward: 30, status: 'ready', responses: {} }
  ],
  activeLiveId: null,
  weekly: weekSlots(),
  weeklyResults: {},
  messages: [{ name: 'Professor', admin: true, text: 'Welcome to Chem Battle!', ts: Date.now() }],
  currentWeek: 1,
  semesterComplete: false
};

let session = null, page = 'home', currentWeekly = null,
    weeklyAnswers = {}, weeklyIndex = 0, shopTab = 'hair', tryOn = {}, draft = null;

const STARTER = ['hair_plain.dark_brown', 'torso_clothes_longsleeve.white', 'legs_pants.blue', 'feet_shoes_basic.black'];

// Slots that must always hold something. These can be swapped for another
// item but never emptied, so a character can't end up undressed.
const REQUIRED_SLOTS = { torso: 'torso_clothes_longsleeve.white',
                         legs:  'legs_pants.blue' };

// Repairs any character missing a required slot: prefers something they
// already own, otherwise grants the starter piece.
function ensureDressed(u) {
  let changed = false;
  // A slot may have been retired since this account last saved.
  Object.keys(u.equipped || {}).forEach(slot => {
    if (!itemById(u.equipped[slot])) { delete u.equipped[slot]; changed = true; }
  });
  if (Array.isArray(u.inventory)) {
    const keep = u.inventory.filter(id => itemById(id));
    if (keep.length !== u.inventory.length) { u.inventory = keep; changed = true; }
  }
  const inDress = u.equipped.dress && itemById(u.equipped.dress);
  Object.entries(REQUIRED_SLOTS).forEach(([slot, fallback]) => {
    if (inDress) return;                       // a dress already covers both
    if (u.equipped[slot] && itemById(u.equipped[slot])) return;
    const owned = (u.inventory || []).find(id => itemById(id)?.slot === slot);
    const pick = owned || fallback;
    if (!itemById(pick)) return;
    if (!u.inventory.includes(pick)) u.inventory.push(pick);
    u.equipped[slot] = pick;
    changed = true;
  });
  return changed;
}

// The professor gets a fixed lab-coat look so students recognise them at a glance.
const PROF_BODY = { skin: 'light', eye: 'purple', face: 'heads_human_female' };
const PROF_FIT = ['feet_shoes_revised.black', 'legs_formal.black',
                  'torso_clothes_longsleeve2_buttoned.white',
                  'torso_aprons_apron_full.white', 'hair_wavy.platinum',
                  'facial_glasses_halfmoon', 'weapon_magic_simple.simple'];
const DEFAULT_BODY = { skin: 'light', eye: 'blue', face: 'heads_human_female' };
const PAGE_SIZE = 24;   // designs per page, not colour variants
let shopPage = 0;

/* ============================================================
   Sync layer

   Shared state (quiz queue, weekly slots) lives in one `room` row that
   only the professor writes, so a student saving their own progress can
   never clobber the class state. Answers and chat are append-only tables,
   which keeps 40 students writing at once from racing each other.
   Without credentials everything falls back to localStorage.
   ============================================================ */

const CFG = window.CHEM_CONFIG || {};
const ONLINE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
let SB = null, TOKEN = null, syncErr = '';

/* ============================================================
   Sync layer

   The client never writes to a table. Every change goes through a database
   function that re-derives *who you are* from a session token and computes
   the result itself, so nothing the browser sends can be trusted into the
   data: potions and XP are awarded server-side, prices are looked up
   server-side, and quiz answers are withheld until a round has ended.

   With no credentials in config.js the whole thing falls back to the
   original localStorage behaviour, which is handy for design work.
   ============================================================ */

const TOKEN_KEY = 'cwToken';

async function rpc(fn, args = {}) {
  const { data, error } = await SB.rpc(fn, args);
  if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
  return data;
}

// Server truth -> the in-memory shapes the UI already understands.
function adoptUser(row) {
  const p = row.profile || {};
  const u = {
    nick: row.nick, isAdmin: row.is_admin,
    potions: row.potions, xp: row.xp, lastLogin: row.last_login,
    body: p.body || { ...DEFAULT_BODY },
    equipped: p.equipped || {},
    inventory: p.inventory || [],
    liveAnswered: {}, liveRewarded: {}, missionClaimed: {}
  };
  (row.answers || []).forEach(a => {
    u.liveAnswered[a.quiz_id] = true;
    u.liveRewarded[a.quiz_id] = a.rewarded;
  });
  db.weeklyResults[u.nick] = {};
  (row.weekly || []).forEach(w => {
    db.weeklyResults[u.nick][w.week] = {
      correct: w.correct, reward: w.reward, answers: w.answers, review: w.review
    };
  });
  db.users[u.nick] = u;
  return u;
}

function adoptQuizzes(rows) {
  const keep = {};
  db.liveQueue.forEach(q => { keep[q.id] = q.responses || {}; });
  db.liveQueue = (rows || []).sort((a, b) => a.ord - b.ord).map(r => ({
    id: r.id, ord: r.ord, week: r.week, title: r.title, question: r.question,
    options: r.options || [], correct: r.correct,
    participationReward: r.part_reward, correctReward: r.correct_reward,
    status: r.status, responses: keep[r.id] || {}
  }));
  // A running quiz always wins. Only when nothing is running do we fall back
  // to the most recently ended one, so its results stay on screen. Picking
  // the *first* ended quiz would pin students to question 1 all semester.
  const act = db.liveQueue.find(q => q.status === 'active')
           || [...db.liveQueue].reverse().find(q => q.status === 'ended');
  db.activeLiveId = act ? act.id : null;
}

function adoptWeekly(rows) {
  db.weekly = (rows || []).sort((a, b) => a.week - b.week).map(r => ({
    week: r.week, title: r.title, status: r.status,
    completionReward: r.completion_reward, correctReward: r.correct_reward,
    questions: new Array(r.question_count || 0).fill(null)   // bodies fetched on open
  }));
}

/* The public view hides `correct` so students can't read answers early, but
   the professor's editor needs it — without it the answer <select> falls back
   to the first option every time the dashboard re-renders. Admins therefore
   read through a token-checked function instead of the view.

   This must be used by the realtime handler too, which also runs in student
   browsers; calling the admin function there would fail and blank the quiz. */
async function fetchQuizzes() {
  if (session?.isAdmin && TOKEN) {
    const { data, error } = await SB.rpc('admin_list_quiz', { p_token: TOKEN });
    if (!error) return data;
    // Fall through to the public view if the function isn't installed yet.
    console.warn('admin_list_quiz unavailable, using public view:', error.message);
  }
  const { data } = await SB.from('live_quiz_public').select('*');
  return data;
}

async function pullShared() {
  const [q, w, m, r] = await Promise.all([
    fetchQuizzes(),
    SB.from('weekly_public').select('*'),
    SB.from('messages').select('*').order('id', { ascending: true }).limit(300),
    SB.from('room').select('data').eq('id', 1).maybeSingle()
  ]);
  if (q) adoptQuizzes(q);
  if (w.data) adoptWeekly(w.data);
  if (m.data) db.messages = m.data.map(x => ({ name: x.name, admin: x.admin, text: x.text, ts: Number(x.ts) }));
  db.semesterComplete = !!(r.data?.data?.semesterComplete);
  db.currentWeek = Number(r.data?.data?.currentWeek) || 1;
}

async function refreshMe() {
  if (!SB || !TOKEN) return;
  session = adoptUser(await rpc('me', { p_token: TOKEN }));
}

/* Only the professor streams answers, and each row is applied on its own.
   Subscribing every student would cost (students x answers) realtime
   messages per question, which is what exhausts a monthly quota. */
let respChannel = null;

function watchResponses() {
  if (!SB || respChannel) return;
  respChannel = SB.channel('resp')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'responses' }, p => {
      const r = p.new || p.old; if (!r) return;
      const q = db.liveQueue.find(x => x.id === r.quiz_id);
      if (!q) return;
      q.responses = q.responses || {};
      if (p.eventType === 'DELETE') delete q.responses[r.nick];
      else q.responses[r.nick] = r.choice;
      if (page === 'admin' || page === 'live') render();
    })
    .subscribe();
}

const tallyLoaded = new Set();

async function loadTally(quizId) {
  if (!SB || tallyLoaded.has(quizId)) return;
  tallyLoaded.add(quizId);
  const { data } = await SB.from('responses').select('nick,choice').eq('quiz_id', quizId);
  if (!data) return;
  const q = db.liveQueue.find(x => x.id === quizId);
  if (!q) return;
  q.responses = {};
  data.forEach(r => { q.responses[r.nick] = r.choice; });
  render();
}

async function connect() {
  if (!ONLINE) return;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  SB = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY,
                    { realtime: { params: { eventsPerSecond: 5 } } });
  await pullShared();

  SB.channel('chem')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_quiz' },
        async () => {
          const before = db.activeLiveId;
          const data = await fetchQuizzes();
          if (!data) return;
          adoptQuizzes(data);
          tallyLoaded.clear();
          // A new round pulls students off the previous results screen.
          const now = getActive();
          if (now && now.id !== before && now.status === 'active'
              && session && !session.isAdmin) page = 'live';
          render();
        })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly' },
        async () => {
          const { data } = await SB.from('weekly_public').select('*');
          if (data) { adoptWeekly(data); render(); }
        })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room' },
        p => {
          db.semesterComplete = !!(p.new?.data?.semesterComplete);
          db.currentWeek = Number(p.new?.data?.currentWeek) || 1;
          render();
        })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
        p => {
          const m = p.new;
          if (!db.messages.some(x => x.ts === Number(m.ts) && x.name === m.name)) {
            db.messages.push({ id: m.id, name: m.name, admin: m.admin, text: m.text, ts: Number(m.ts) });
            if (page === 'chat') render();
          }
        })
    .subscribe();

  // Resume a session left open on this device.
  const t = sessionStorage.getItem(TOKEN_KEY);
  if (t) {
    TOKEN = t;
    try {
      await refreshMe();
      if (session.isAdmin) watchResponses();
      page = session.isAdmin ? 'admin' : 'home';
    } catch { TOKEN = null; sessionStorage.removeItem(TOKEN_KEY); }
  }
}

// Cosmetics are the only thing the client is allowed to state directly.
let saveTimer = null;
function save() {
  if (!ONLINE || !SB) { localStorage.setItem(KEY, JSON.stringify(db)); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!TOKEN || !session) return;
    rpc('save_look', { p_token: TOKEN, p_profile: { body: session.body, equipped: session.equipped } })
      .then(() => { syncErr = ''; })
      .catch(e => { syncErr = e.message; console.error(e); });
  }, 300);
}

async function guard(fn) {
  try { await fn(); syncErr = ''; }
  catch (e) { syncErr = e.message; alert(e.message); }
  render();
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
const validNick = s => /^[A-Za-z0-9가-힣]+$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);
const hhmm = ts => ts ? new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

/* ============================================================
   Avatar
   ============================================================ */

async function loadAvatars() {
  const [m, c] = await Promise.all([
    fetch('avatar-manifest.json').then(r => r.json()),
    fetch('avatar-credits.json').then(r => r.json()).catch(() => [])
  ]);
  AV = m; CREDITS = c;
  m.items.forEach(i => {
    if (i.slot.startsWith('_')) FRAME[i.id] = i;
    else (WEAR[i.slot] = WEAR[i.slot] || []).push(i);
  });
}

const itemById = id => AV.items.find(i => i.id === id && !i.slot.startsWith('_')) || null;

// Every layer carries its own LPC z value, so hair that falls behind the
// shoulders sorts under the body instead of being painted over it.
function layerFrames(u, temp) {
  const b = { ...DEFAULT_BODY, ...u.body }, eq = { ...u.equipped, ...(temp || {}) };
  // A dress covers torso and legs, so it replaces them rather than layering.
  if (eq.dress) { delete eq.torso; delete eq.legs; delete eq.sleeves; }
  const pieces = [FRAME[`body.${b.skin}`], FRAME[`face.${b.face}.${b.skin}.${b.eye}`]];
  Object.values(eq).forEach(id => { const it = id && itemById(id); if (it) pieces.push(it); });
  return pieces.filter(Boolean)
    .flatMap(p => p.layers)
    .sort((a, b2) => a.z - b2.z)
    .map(l => l.f);
}

// Stacked atlas slices, `s` is the pixel scale factor.
//
// The layers are positioned at the atlas's natural size and the whole stack
// is then scaled with a transform. Scaling the background image instead
// would ask the browser for a 12288x14080 bitmap at s=4, which is far past
// what iOS Safari will decode — it silently clamps and the wrong cell shows.
function sprite(u, s = 3, temp = null) {
  if (!AV || !u?.body) return '<div class="av"></div>';
  const C = AV.cell, COLS = AV.cols;
  const cells = layerFrames(u, temp).map(f => {
    const x = -(f % COLS) * C, y = -Math.floor(f / COLS) * C;
    return `<i style="background-position:${x}px ${y}px"></i>`;
  }).join('');
  const px = C * s;
  return `<div class="av" style="width:${px}px;height:${px}px">` +
         `<div class="avf" style="width:${C}px;height:${C}px;transform:scale(${s})">${cells}</div></div>`;
}

// Avatar framed on the grass battlefield tile.
// Fireworks live inside the arena frame, positioned over the sky band above
// the castle. Staggered delays keep the bursts occasional rather than synced.
const FIREWORKS = [[18, 17, 0], [70, 14, 1.3], [45, 26, 2.7], [86, 20, 4.0], [32, 12, 5.2]]
  .map(([x, y, d]) => `<i style="left:${x}%;top:${y}%;animation-delay:${d}s"></i>`).join('');

function stage(u, s = 4, temp = null, fx = '') {
  return `<div class="battle-stage${fx ? ' ' + fx : ''}">
    <div class="sky"><i class="far"></i><i class="near"></i></div>
    ${fx === 'night' ? `<div class="fireworks">${FIREWORKS}</div>` : ''}
    ${sprite(u, s, temp)}
  </div>`;
}

// Base layers every thumbnail wears, so overlay-only pieces (sleeves, trims)
// are never previewed on a bare body.
const THUMB_BASE = { hair: 'hair_plain.dark_brown',
                     torso: 'torso_clothes_longsleeve.white',
                     legs: 'legs_pants.blue',
                     feet: 'feet_shoes_basic.black' };

// Shop thumbnail: the player's own character wearing the item. Their current
// hair is kept so a shirt isn't previewed on a bald head; only when the item
// *is* hair does the base hair step aside.
function thumb(item) {
  const eq = {};
  Object.entries(THUMB_BASE).forEach(([slot, id]) => {
    if (slot === item.slot) return;
    const mine = session?.equipped?.[slot];
    const use = (mine && itemById(mine)) ? mine : id;
    if (itemById(use)) eq[slot] = use;
  });
  eq[item.slot] = item.id;
  if (item.slot === 'dress') { delete eq.torso; delete eq.legs; }
  if (eq.dress) { delete eq.torso; delete eq.legs; }
  return sprite({ body: session?.body || DEFAULT_BODY, equipped: eq }, 1.4);
}

/* ============================================================
   Data model
   ============================================================ */

function mkUser(nick, pin, body, isAdmin = false) {
  return {
    nick, pin, isAdmin,
    body: body || { ...(isAdmin ? PROF_BODY : DEFAULT_BODY) },
    potions: isAdmin ? 999 : 300,
    xp: 0, lastLogin: '',
    inventory: [], equipped: {},
    liveAnswered: {}, liveRewarded: {}, missionClaimed: {}
  };
}

function migrate() {
  Object.values(db.users).forEach(u => {
    if (u.xp == null) u.xp = 0;
    if (u.lastLogin == null) u.lastLogin = '';
    if (!u.missionClaimed) u.missionClaimed = {};
    u.body = { ...DEFAULT_BODY, ...(u.body || {}) };
    delete u.body.type;
    if (!u.equipped || Array.isArray(u.equipped)) u.equipped = {};
    if (!Array.isArray(u.inventory)) u.inventory = [];
  });
  db.messages.forEach(m => { if (!m.ts) m.ts = null; });
}
migrate();

// The professor advances the semester week from the dashboard, so the bar
// reflects where the class is rather than each student's own pace.
const currentWeek = () => Math.min(TOTAL_WEEKS, Math.max(1, db.currentWeek || 1));
const weeksDone = u => Object.keys(db.weeklyResults[u.nick] || {}).length;

function progressBar() {
  const n = currentWeek();
  return `<div class="xp">
    <div class="xpbar"><div class="xpfill" style="width:${n / TOTAL_WEEKS * 100}%"></div></div>
    <span class="xptext">${n} / ${TOTAL_WEEKS}주</span>
  </div>`;
}

function award(n) {
  session.potions += n;
  session.xp = (session.xp || 0) + n;
  db.users[session.nick] = session;
}

/* ============================================================
   Auth & character creation
   ============================================================ */

const demoLook = body => ({
  body: body || { ...DEFAULT_BODY },
  equipped: { hair: STARTER[0], torso: STARTER[1], legs: STARTER[2], feet: STARTER[3] }
});

function login() {
  const r = localStorage.getItem('cwRemember') || '';
  app.innerHTML = `
  <div class="phone">
    <div class="page center login">
      <div class="logo"><h1>CHEM<br>BATTLE</h1></div>
      <p class="tagline">Welcome to Chem Battle!</p>
      <div class="sparkle-stage">${stage(demoLook(), 4)}</div>
      <div class="field"><span class="fico g user"></span><input id="nick" class="input" value="${esc(r)}" placeholder="닉네임 (한글/영어)" oninput="pinMode()"></div>
      <div class="field"><span class="fico g lock"></span><input id="pin" class="input" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" placeholder="4자리 숫자 PIN" oninput="pinMode()"></div>
      <label class="check"><input id="remember" type="checkbox" ${r ? 'checked' : ''}> 닉네임 기억하기</label>
      <div id="err" class="errline"></div>
      <button class="btn green" onclick="doLogin()">LOGIN</button>
      <p class="sub">처음이신가요?</p>
      <button class="linkbtn" onclick="startCreate()">캐릭터 만들기 ></button>
    </div>
  </div>`;
  window.pinMode();   // a remembered professor nickname widens the field right away
}

// The professor needs a real password, students a 4-digit PIN. Swapping the
// field's rules on the nickname keeps the phone keypad for students.
window.pinMode = () => {
  const isProf = nick.value.trim() === (CFG.PROFESSOR_NICK || 'Professor');
  pin.maxLength = isProf ? 64 : 4;
  pin.inputMode = isProf ? 'text' : 'numeric';
  pin.placeholder = isProf ? '비밀번호 (8자 이상)' : '4자리 숫자 PIN';
};

window.startCreate = () => {
  const n = nick.value.trim(), p = pin.value.trim();
  if (!validNick(n)) return err.textContent = '닉네임은 한글/영문/숫자만 쓸 수 있어요.';
  // Students use a 4-digit PIN; the professor account may use a longer one.
  const isProf = n === (CFG.PROFESSOR_NICK || 'Professor');
  if (!isProf && !/^\d{4}$/.test(p)) return err.textContent = 'PIN은 숫자 4자리로 입력해 주세요.';
  if (isProf && p.length < 8) return err.textContent = '교수 비밀번호는 8자 이상으로 정해 주세요.';
  err.textContent = '';
  draft = { nick: n, pin: p, body: { ...DEFAULT_BODY } };
  render();   // 닉네임 중복은 서버가 최종 판정합니다
};

window.setDraft = (k, v) => { draft.body[k] = v; render(); };

window.finishCreate = async () => {
  const equipped = {};
  STARTER.forEach(id => { const it = itemById(id); if (it) equipped[it.slot] = id; });
  const profile = { body: draft.body, equipped, inventory: STARTER };

  if (!SB) {
    db.users[draft.nick] = mkUser(draft.nick, draft.pin, draft.body);
    session = db.users[draft.nick];
    session.inventory = [...STARTER]; session.equipped = equipped;
    ensureDressed(session);
    draft = null; page = 'home';
    return (checkIn(), save(), render());
  }
  try {
    TOKEN = await rpc('register', { p_nick: draft.nick, p_pin: draft.pin, p_profile: profile });
    sessionStorage.setItem(TOKEN_KEY, TOKEN);
    await refreshMe();
    // The server decides who is admin, so route on what it sent back.
    if (session.isAdmin) { dressProfessor(session); watchResponses(); }
    else ensureDressed(session);
    draft = null;
    page = session.isAdmin ? 'admin' : 'home';
    save(); render();
  } catch (e) { alert(e.message); }
};

function createPage() {
  const b = draft.body;
  const chip = (k, v, label) =>
    `<button class="chip ${b[k] === v ? 'on' : ''}" onclick="setDraft('${k}','${v}')">${label}</button>`;
  app.innerHTML = `<div class="phone">
    <div class="top"><button class="iconbtn" onclick="draft=null;login()">←</button><b>캐릭터 만들기</b><span></span></div>
    <div class="page center">
      <div class="stagebox">${stage(demoLook(b), 4)}</div>
      <div class="panel">
        <h3>얼굴형</h3>
        <div class="chips">${AV.faces.map(f => chip('face', f.key, f.name)).join('')}</div>
        <h3>피부톤</h3>
        <div class="chips">${AV.skins.map(s => chip('skin', s.key, s.name)).join('')}</div>
        <h3>눈 색</h3>
        <div class="chips">${AV.eyes.map(e => chip('eye', e.key, e.name)).join('')}</div>
      </div>
      <button class="btn green" onclick="finishCreate()">이 캐릭터로 시작하기</button>
    </div>
  </div>`;
}

window.doLogin = async () => {
  const n = nick.value.trim(), p = pin.value.trim();
  if (remember.checked) localStorage.setItem('cwRemember', n); else localStorage.removeItem('cwRemember');

  if (!SB) {                                   // 연습 모드
    const u = db.users[n];
    if (!u || u.pin !== p) return err.textContent = '닉네임 또는 PIN이 맞지 않아요.';
    session = u;
    if (u.isAdmin) dressProfessor(u); else ensureDressed(u);
    page = u.isAdmin ? 'admin' : 'home';
    checkIn(); save(); return render();
  }

  err.textContent = '접속 중...';
  try {
    TOKEN = await rpc('login', { p_nick: n, p_pin: p });
    sessionStorage.setItem(TOKEN_KEY, TOKEN);
    await refreshMe();
    if (session.isAdmin) {
      dressProfessor(session);
      watchResponses();
      const q = await fetchQuizzes();      // now readable with answers
      if (q) adoptQuizzes(q);
    } else ensureDressed(session);
    page = session.isAdmin ? 'admin' : 'home';
    err.textContent = ''; save(); render();
  } catch (e) {
    TOKEN = null; err.textContent = e.message;
  }
};

// The professor's fixed appearance, independent of any saved account data.
function profLook() {
  const equipped = {};
  PROF_FIT.forEach(id => {
    const it = itemById(id);
    if (it) equipped[it.slot] = id;
  });
  return { body: { ...PROF_BODY }, equipped };
}

// Re-applied on every login so the look survives older saves.
function dressProfessor(u) {
  const look = profLook();
  u.body = look.body;
  u.equipped = look.equipped;
  u.inventory = [...new Set([...(u.inventory || []), ...PROF_FIT])];
}

// Offline only: online, the login function awards attendance server-side.
function checkIn() {
  if (SB || session.isAdmin) return;
  if (session.lastLogin !== today()) { session.lastLogin = today(); award(10); }
}

window.logout = () => {
  session = null; TOKEN = null; page = 'home';
  sessionStorage.removeItem(TOKEN_KEY);
  login();
};

/* ============================================================
   Shell
   ============================================================ */

// Icon index into ui-icons.png (a 6-frame 16px strip), not an emoji.
const NAV = [
  ['home', 0, '홈'], ['quiz', 1, '전투'], ['chat', 2, '채팅'],
  ['shop', 3, '상점'], ['closet', 4, '옷장'], ['my', 5, '내 정보']
];

function shell(html, opts = {}) {
  const nav = session.isAdmin ? '' : `<nav class="nav">${NAV.map(x =>
    `<button class="${page === x[0] ? 'active' : ''}" onclick="go('${x[0]}')"><i class="ico" style="--i:${x[1]}"></i>${x[2]}</button>`).join('')}</nav>`;
  const left = opts.back ? `<button class="iconbtn" onclick="go('${opts.back}')">←</button>` : `<span class="potion"><i class="g pot"></i> ${session.potions}</span>`;
  const title = opts.title ? `<b>${esc(opts.title)}</b>` : (opts.back ? '' : '<b>CHEM BATTLE</b>');
  const right = opts.back ? `<span class="potion"><i class="g pot"></i> ${session.potions}</span>` : `<button class="iconbtn" onclick="logout()">↪</button>`;
  const link = !ONLINE ? '<span class="netdot off" title="연습 모드 · 이 브라우저에만 저장됩니다"></span>'
             : syncErr  ? '<span class="netdot bad" title="서버 연결 문제"></span>'
             : SB       ? '<span class="netdot ok" title="수업 서버 연결됨"></span>'
                        : '<span class="netdot bad" title="연결 중"></span>';
  app.innerHTML = `<div class="phone${opts.theme ? ' ' + opts.theme : ''}"><div class="top">${left}${title}${link}${right}</div>${html}${nav}</div>`;
}

window.go = p => { page = p; render(); };

/* ============================================================
   Home
   ============================================================ */

// Missions describe *this week* only. When the professor advances the
// semester week the list resets, so students get a fresh set of goals
// instead of three permanently-ticked boxes.
function missions() {
  const wk = currentWeek();
  // Quizzes opened since the week changed. The professor's week counter is
  // the boundary, so anything from earlier weeks no longer counts.
  const opened = db.liveQueue.filter(q => q.status !== 'ready' && (q.week ?? wk) === wk);
  const answered = opened.filter(q => session.liveAnswered[q.id]).length;
  const thisWeekDone = db.weeklyResults[session.nick]?.[wk] ? 1 : 0;

  const list = [
    { key: 'attend', label: '출석하기',
      now: session.lastLogin === today() ? 1 : 0, goal: 1, reward: 5, auto: true }
  ];
  if (opened.length) {
    list.push({ key: 'live', label: 'Live Quiz 참여',
                now: answered, goal: opened.length, reward: 0, auto: true });
  }
  list.push({ key: 'weekly', label: `${wk}주차 퀴즈 완료`,
              now: thisWeekDone, goal: 1, reward: 0, auto: true });
  return list;
}

// Offline only. Online, potions come from quiz rewards the server grants,
// so the mission list is just a progress display.
function settleMissions(list) {
  if (SB) return;
  let paid = false;
  list.forEach(m => {
    if (m.auto) return;
    if (m.now >= m.goal && !session.missionClaimed[m.key]) {
      session.missionClaimed[m.key] = true; award(m.reward); paid = true;
    }
  });
  if (paid) save();
}

function home() {
  if (db.semesterComplete) confetti();
  const q = getActive(), ms = missions();
  settleMissions(ms);
  shell(`<div class="page">
    <div class="center">
      <h2 class="hello">안녕, ${esc(session.nick)}!</h2>
      <div class="stagebox">${stage(session, 4)}</div>
      ${progressBar()}
      <p class="sub">학기 진행도</p>
    </div>
    <div class="panel">
      <h3>이번 주 미션</h3>
      ${ms.map(m => {
        const done = m.now >= m.goal;
        return `<div class="mission">
          <span class="mtask ${done ? 'done' : ''}"><i class="box">${done ? '☑' : '☐'}</i>${m.label}</span>
          <span class="mmeta">${m.goal > 1 ? `<i class="prog">${m.now} / ${m.goal}</i>` : ''}${m.reward ? `<b>+${m.reward} <i class="g pot"></i></b>` : ''}</span>
        </div>`;
      }).join('')}
    </div>
    ${q && q.status === 'active' ? `<button class="btn green" onclick="go('live')"><i class="g bolt"></i> 진행 중인 LIVE QUIZ 참여</button>` : ''}
    ${db.semesterComplete ? `<div class="panel center celebrate"><h2>🎉 한 학기 완주!</h2><button class="btn green" onclick="go('ending')">수료증 보기</button></div>` : ''}
  </div>`);
}

function quizHub() {
  shell(`<div class="page">
    <div class="panel"><h2><i class="g bolt"></i> Live Quiz</h2><p class="sub">수업 중 교수님이 여는 실시간 퀴즈예요.</p><button class="btn green" onclick="go('live')">들어가기</button></div>
    <div class="panel"><h2><i class="g book"></i> Weekly Quiz</h2><p class="sub">주차별 복습 문제. 열린 주차부터 풀 수 있어요.</p><button class="btn yellow" onclick="go('weekly')">들어가기</button></div>
  </div>`, { title: '전투' });
}

/* ============================================================
   Live quiz
   ============================================================ */

const getActive = () => db.liveQueue.find(q => q.id === db.activeLiveId) || null;

window.pickLive = i => {
  document.querySelectorAll('.quiz-option').forEach(x => x.classList.remove('selected'));
  document.querySelector(`[data-live="${i}"]`)?.classList.add('selected');
};

window.submitLive = async () => {
  const q = getActive(), s = document.querySelector('.quiz-option.selected');
  if (!s) return alert('답을 먼저 선택해 주세요.');
  const choice = Number(s.dataset.live);
  if (SB) return guard(async () => {
    await rpc('submit_answer', { p_token: TOKEN, p_quiz: q.id, p_choice: choice });
    q.responses[session.nick] = choice;
    session.liveAnswered[q.id] = true;
  });
  q.responses[session.nick] = choice;
  session.liveAnswered[q.id] = true;
  save(); render();
};

function live() {
  const q = getActive();
  if (!q) return shell(`<div class="page"><div class="panel center empty"><p>지금 열려 있는 Live Quiz가 없어요.</p><p class="sub">교수님이 퀴즈를 시작하면 여기에 나타납니다.</p></div></div>`, { back: 'quiz', title: 'LIVE QUIZ' });
  const mine = q.responses[session.nick];

  const answeredHere = session.liveAnswered[q.id] || q.responses[session.nick] != null;
  if (answeredHere && q.status === 'active') {
    return shell(`<div class="page">
      <div class="notice-band">교수님이 퀴즈를 종료하면 결과를 확인할 수 있어요!</div>
      <div class="panel"><h3>${esc(q.question)}</h3>
        ${q.options.map((o, i) => `<div class="quiz-option ${mine === i ? 'selected' : ''}">${i + 1}) ${esc(o)}</div>`).join('')}
      </div>
      <div class="wait">⌛ 답을 제출했어요!<br><b>교수님이 퀴즈를 종료할 때까지 기다려 주세요.</b></div>
    </div>`, { back: 'quiz', title: 'LIVE QUIZ' });
  }

  if (q.status === 'ended') {
    if (!session.isAdmin) loadTally(q.id);
    const counts = q.options.map(() => 0);
    Object.values(q.responses).forEach(i => { if (counts[i] != null) counts[i]++; });
    const total = Object.keys(q.responses).length;
    const reward = mine == null ? 0 : q.participationReward + (mine === q.correct ? q.correctReward : 0);
    if (mine != null && !session.liveRewarded[q.id]) {
      session.liveRewarded[q.id] = true;
      if (SB) {
        // The server decides the amount; we only ask for it once.
        rpc('claim_live', { p_token: TOKEN, p_quiz: q.id })
          .then(r => { if (r && r.gain) { session.potions += r.gain; session.xp += r.gain; render(); } })
          .catch(e => { syncErr = e.message; });
      } else { award(reward); save(); }
    }
    return shell(`<div class="page">
      <div class="panel center">
        <h2 class="answerline">정답 : ${q.correct + 1}) ${esc(q.options[q.correct])}</h2>
        <div class="rewardbox">
          <span>참여 보상 +${q.participationReward} <i class="g pot"></i></span><span class="divider"></span><span>정답 보상 +${q.correctReward} <i class="g pot"></i></span>
          <p class="gain">획득 포션 : +${reward} <i class="g pot"></i></p>
        </div>
      </div>

      <div class="panel">
        <b class="qhead">${esc(q.question)}</b>
        ${q.options.map((o, i) => {
          const isAnswer = i === q.correct, isMine = mine === i;
          // Green marks the answer, red marks a wrong pick, and a small tag
          // shows which one the student themselves chose.
          const cls = isAnswer ? 'ok' : (isMine ? 'no' : '');
          const mark = isAnswer ? '✓' : (isMine ? '✕' : '');
          return `<div class="quiz-option ${cls}">
            <span>${i + 1}) ${esc(o)}${isMine ? ' <i class="mypick">내 답</i>' : ''}</span>
            <span class="mark">${mark}</span></div>`;
        }).join('')}
        ${mine == null ? '<p class="small">이 문제에는 참여하지 않았어요.</p>'
          : `<p class="small">${mine === q.correct ? '정답을 맞혔어요.' : '아쉽게 틀렸어요.'}</p>`}
      </div>

      <div class="panel">
        <h3>전체 응답 분포 <span class="sub">(참여 ${total}명)</span></h3>
        ${counts.map((n, i) => {
          const pct = total ? Math.round(n / total * 100) : 0;
          return `<div class="barrow"><b>${i + 1})</b><div class="barbg"><div class="bar" style="width:${pct}%"></div></div><span>${n}명 (${pct}%)</span></div>`;
        }).join('')}
      </div>
    </div>`, { back: 'quiz', title: 'LIVE QUIZ' });
  }

  shell(`<div class="page">
    <div class="panel">
      <h3>${esc(q.question)}</h3>
      ${q.options.map((o, i) => `<button class="quiz-option" data-live="${i}" onclick="pickLive(${i})">${i + 1}) ${esc(o)}</button>`).join('')}
      <button class="btn green" onclick="submitLive()">제출 완료!</button>
    </div>
  </div>`, { back: 'quiz', title: 'LIVE QUIZ' });
}

/* ============================================================
   Weekly quiz
   ============================================================ */

function weekly() {
  shell(`<div class="page">
    ${db.weekly.map(w => {
      const r = db.weeklyResults[session.nick]?.[w.week];
      const max = w.completionReward + w.questions.length * w.correctReward;
      let state = 'locked', label = '잠김', action = '';
      if (r) { state = 'done'; label = `+${r.reward} <i class="g pot"></i>`; action = `openWeekly(${w.week})`; }
      else if (w.status === 'open') { state = 'open'; label = `최대 +${max} <i class="g pot"></i>`; action = `openWeekly(${w.week})`; }
      else if (w.status === 'closed') { state = 'closed'; label = '마감'; }
      return `<div class="weekrow ${state}" ${action ? `onclick="${action}"` : ''}>
        <div><b>${esc(w.title && w.title !== `Week ${w.week}` ? `${w.week}주차 · ${w.title}` : `${w.week}주차`)}</b>
        <p class="wstate">${r ? '✔ 완료' : w.status === 'open' ? '진행 가능' : w.status === 'closed' ? '마감됨' : '잠김'}</p></div>
        <span class="wmeta">${label}${state === 'locked' ? ' <i class="g lock"></i>' : state === 'open' ? ' ›' : ''}</span>
      </div>`;
    }).join('')}
    <p class="sub center foot">각 주차 퀴즈는 여러 번 볼 수 있어요.<br>포션은 첫 완료 시에만 지급됩니다.</p>
  </div>`, { back: 'quiz', title: 'WEEKLY QUIZ' });
}

window.openWeekly = async w => {
  currentWeekly = w; weeklyAnswers = {}; weeklyIndex = 0; page = 'weeklyrun';
  if (SB) return guard(async () => {
    // One call returns the questions; when the week is already graded it also
    // carries the answers and explanations for the review view.
    const r = await rpc('get_weekly', { p_token: TOKEN, p_week: w });
    const slot = db.weekly.find(x => x.week === w);
    const review = r.review || [];
    slot.questions = (r.questions || []).map((q, i) => ({
      q: q.q, o: q.o || [],
      a: r.done ? (review[i]?.a ?? 0) : -1,
      explanation: r.done ? (review[i]?.explanation || '') : ''
    }));
    if (r.done) {
      db.weeklyResults[session.nick] = db.weeklyResults[session.nick] || {};
      db.weeklyResults[session.nick][w] =
        { correct: r.correct, reward: r.reward, answers: r.answers, review };
    }
  });
  render();
};

window.pickWeekly = (q, i) => { weeklyAnswers[q] = i; render(); };
window.gotoQ = i => { weeklyIndex = i; render(); };

window.finishWeekly = async () => {
  const w = db.weekly.find(x => x.week === currentWeekly);
  if (Object.keys(weeklyAnswers).length < w.questions.length) return alert('아직 풀지 않은 문제가 있어요.');

  if (SB) return guard(async () => {
    const r = await rpc('submit_weekly', { p_token: TOKEN, p_week: w.week, p_answers: weeklyAnswers });
    db.weeklyResults[session.nick] = db.weeklyResults[session.nick] || {};
    db.weeklyResults[session.nick][w.week] =
      { correct: r.correct, reward: r.reward, answers: { ...weeklyAnswers }, review: r.review };
    w.questions = w.questions.map((q, i) =>
      ({ ...q, a: r.review[i]?.a ?? 0, explanation: r.review[i]?.explanation || '' }));
    session.potions += r.reward; session.xp += r.reward;
    weeklyIndex = 0;
  });

  let c = 0;
  w.questions.forEach((x, i) => { if (weeklyAnswers[i] === x.a) c++; });
  db.weeklyResults[session.nick] = db.weeklyResults[session.nick] || {};
  if (!db.weeklyResults[session.nick][w.week]) {
    const reward = w.completionReward + c * w.correctReward;
    award(reward);
    db.weeklyResults[session.nick][w.week] = { correct: c, reward, answers: { ...weeklyAnswers } };
    save();
  }
  weeklyIndex = 0; render();
};

function weeklyrun() {
  const w = db.weekly.find(x => x.week === currentWeekly);
  const result = db.weeklyResults[session.nick]?.[w.week];
  const review = !!result;
  if (!w.questions.length) {
    return shell(`<div class="page"><div class="panel center empty"><p>아직 문제가 등록되지 않았어요.</p></div></div>`, { back: 'weekly', title: `WEEK ${w.week}` });
  }
  const i = Math.min(weeklyIndex, w.questions.length - 1);
  const q = w.questions[i];
  const picked = review ? result.answers[i] : weeklyAnswers[i];

  const tabs = w.questions.map((qq, qi) => {
    let cls = '';
    if (review) cls = result.answers[qi] === qq.a ? 'ok' : 'no';
    else if (weeklyAnswers[qi] != null) cls = 'ok';
    if (qi === i) cls += ' now';
    return `<button class="qtab ${cls}" onclick="gotoQ(${qi})">${qi + 1}</button>`;
  }).join('');

  const options = q.o.map((o, oi) => {
    let cls = '', mark = '<span class="mark"></span>';
    if (review) {
      if (oi === q.a) { cls = 'ok'; mark = '<span class="mark">✓</span>'; }
      else if (picked === oi) { cls = 'no'; mark = '<span class="mark">✕</span>'; }
    } else if (picked === oi) cls = 'sel';
    const tag = review ? 'div' : 'button';
    const click = review ? '' : ` onclick="pickWeekly(${i},${oi})"`;
    return `<${tag} class="quiz-option ${cls}"${click}>${oi + 1}) ${esc(o)}${mark}</${tag}>`;
  }).join('');

  const last = i === w.questions.length - 1;
  shell(`<div class="page">
    ${review ? `<div class="reviewband">복습 · ${result.correct}/${w.questions.length} 정답 · 획득 +${result.reward} <i class="g pot"></i></div>` : ''}
    <div class="qtabs">${tabs}</div>
    <div class="panel">
      <b class="qhead">Q${i + 1}. ${esc(q.q)}</b>
      ${options}
      ${review ? `<p class="answerline sm">정답 : ${q.a + 1}) ${esc(q.o[q.a])}</p>
        ${q.explanation ? `<div class="explain"><b>해설</b><p>${esc(q.explanation)}</p></div>` : ''}` : ''}
    </div>
    ${review ? `<button class="btn ghost" onclick="go('weekly')">목록으로 돌아가기</button>`
      : `<div class="row">
          <button class="btn ghost" onclick="gotoQ(${Math.max(0, i - 1)})" ${i === 0 ? 'disabled' : ''}>이전</button>
          ${last ? `<button class="btn green" onclick="finishWeekly()">제출하기</button>`
                 : `<button class="btn green" onclick="gotoQ(${i + 1})">다음</button>`}
        </div>`}
  </div>`, { back: 'weekly', title: `WEEK ${w.week}` });
}

/* ============================================================
   Chat
   ============================================================ */

window.sendMsg = async () => {
  const t = msg.value.trim();
  if (!t) return;
  const m = { name: session.nick, admin: !!session.isAdmin, text: t, ts: Date.now() };
  msg.value = '';
  if (SB) {
    try { await rpc('send_message', { p_token: TOKEN, p_text: t }); }
    catch (e) { alert(e.message); }
    return;                       // the realtime insert echo adds it to the list
  }
  db.messages.push(m);
  save(); render();
};

function chat() {
  shell(`<div class="page chatpage">
    ${db.messages.map(m => {
      const u = m.admin ? profLook() : db.users[m.name];
      return `<div class="chat">
        <div class="chatav">${u ? sprite(u, 1) : ''}</div>
        <div class="bubble ${m.admin ? 'notice' : ''}">
          <div class="bhead"><b>${esc(m.name)}</b>${m.admin ? '<span class="badge admin">관리자</span>' : ''}<time>${hhmm(m.ts)}</time></div>
          <p class="btext">${esc(m.text)}</p>
        </div>
      </div>`;
    }).join('')}
    <div class="composer">
      <textarea id="msg" class="input" rows="1" placeholder="메시지를 입력하세요..."></textarea>
      <button class="sendbtn" onclick="sendMsg()">➤</button>
    </div>
  </div>`, { title: '채팅방' });
}

/* ============================================================
   Shop & closet
   ============================================================ */

const slotTabs = () => AV.slots;

window.setTab = t => { shopTab = t; shopPage = 0; render(); };
window.setPage = n => { shopPage = n; render(); };
window.tryOnItem = id => { const it = itemById(id); tryOn[it.slot] = id; render(); };
window.resetTryOn = () => { tryOn = {}; render(); };

const tryCost = () => Object.values(tryOn)
  .filter(id => !session.inventory.includes(id))
  .reduce((s, id) => s + (itemById(id)?.cost || 0), 0);

window.buyAllTryOn = async () => {
  const ids = Object.values(tryOn);
  if (!ids.length) return;
  if (session.potions < tryCost()) return alert('포션이 부족해요.');

  if (SB) return guard(async () => {
    // The server re-prices the basket and deducts; we just apply the result.
    const r = await rpc('buy_items', { p_token: TOKEN, p_items: ids });
    ids.forEach(id => {
      const it = itemById(id);
      if (!session.inventory.includes(id)) session.inventory.push(id);
      session.equipped[it.slot] = id;
    });
    session.potions = r.potions;
    tryOn = {};
    await rpc('save_look', { p_token: TOKEN, p_profile: { body: session.body, equipped: session.equipped } });
  });

  ids.forEach(id => {
    const it = itemById(id);
    if (!session.inventory.includes(id)) { session.inventory.push(id); session.potions -= it.cost; }
    session.equipped[it.slot] = id;
  });
  save(); tryOn = {}; render();
};

// Items are grouped by design. Listing every colour flat meant a page of
// sixty tiles showed only ten hairstyles, which made the catalogue look far
// smaller than it is.
function designsOf(slot) {
  const out = [], seen = new Map();
  (WEAR[slot] || []).forEach(it => {
    const dot = it.id.lastIndexOf('.');
    const base = dot > 0 ? it.id.slice(0, dot) : it.id;
    if (!seen.has(base)) {
      const g = { base, name: it.name.split(' · ')[0], cost: it.cost, colors: [] };
      seen.set(base, g); out.push(g);
    }
    seen.get(base).colors.push(it);
  });
  return out;
}

function shop() {
  const groups = designsOf(shopTab);
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const pg = Math.min(shopPage, pages - 1);
  const list = groups.slice(pg * PAGE_SIZE, (pg + 1) * PAGE_SIZE);
  const picked = tryOn[shopTab];
  const openGroup = list.find(g => g.colors.some(c => c.id === picked));

  shell(`<div class="page">
    <div class="shop-tabs">${slotTabs().map(x => `<button class="${shopTab === x[0] ? 'active' : ''}" onclick="setTab('${x[0]}')">${x[1]}</button>`).join('')}</div>
    <div class="panel trybox">
      <div class="stage-now">${stage(session, 2)}<p class="sub">현재</p></div>
      <div class="stage-try">${stage(session, 2, tryOn)}<p class="sub">${Object.keys(tryOn).length ? '미리보기' : '미리보기 (선택 없음)'}</p></div>
      <div class="trymeta">
        <p><b>합계 <i class="g pot"></i> ${tryCost()}</b></p>
        <button class="btn green" onclick="buyAllTryOn()">BUY &amp; EQUIP</button>
        <button class="btn ghost" onclick="resetTryOn()">원래대로</button>
      </div>
    </div>

    ${openGroup && openGroup.colors.length > 1 ? `<div class="panel colorbar">
      <h3>${esc(openGroup.name)} — 색상</h3>
      <div class="shopgrid">${openGroup.colors.map(c => {
        const owned = session.inventory.includes(c.id);
        return `<button class="item ${picked === c.id ? 'sel' : ''}" onclick="tryOnItem('${c.id}')">
          <div class="item-icon">${thumb(c)}</div>
          <b>${esc((c.name.split(' · ')[1] || '').trim() || '기본')}</b>
          <span class="price">${owned ? '보유 ✓' : `${c.cost} <i class="g pot"></i>`}</span>
        </button>`;
      }).join('')}</div>
    </div>` : ''}

    <p class="sub">${groups.length}가지 디자인 · 누르면 색상을 고를 수 있어요</p>
    <div class="shopgrid">${list.map(g => {
      const owned = g.colors.filter(c => session.inventory.includes(c.id)).length;
      const on = openGroup && openGroup.base === g.base;
      const shown = g.colors.find(c => c.id === picked) || g.colors[0];
      return `<button class="item ${on ? 'sel' : ''}" onclick="tryOnItem('${shown.id}')">
        <div class="item-icon">${thumb(shown)}</div>
        <b>${esc(g.name)}</b>
        <span class="price">${owned ? `보유 ${owned}/${g.colors.length}` : `${g.cost} <i class="g pot"></i>`}</span>
      </button>`;
    }).join('')}</div>

    ${pages > 1 ? `<div class="pager">
      <button class="btn inline ghost" onclick="setPage(${Math.max(0, pg - 1)})" ${pg === 0 ? 'disabled' : ''}>이전</button>
      <span class="small">${pg + 1} / ${pages}</span>
      <button class="btn inline ghost" onclick="setPage(${Math.min(pages - 1, pg + 1)})" ${pg === pages - 1 ? 'disabled' : ''}>다음</button>
    </div>` : ''}
  </div>`, { title: '상점' });
}

window.equipOwned = id => {
  const it = itemById(id);
  session.equipped[it.slot] = id;
  db.users[session.nick] = session;
  save(); render();
};

window.unequip = slot => {
  if (REQUIRED_SLOTS[slot]) return;   // guarded below in the UI too
  if (slot === 'dress') {             // taking off a dress must not undress
    delete session.equipped.dress;
    ensureDressed(session);
    db.users[session.nick] = session;
    save(); return render();
  }
  delete session.equipped[slot];
  db.users[session.nick] = session;
  save(); render();
};

function closet() {
  const owned = session.inventory.map(itemById).filter(Boolean);
  shell(`<div class="page">
    <div class="panel center">
      <div class="stagebox">${stage(session, 3.4)}</div>
      <div class="chips">${slotTabs()
        .filter(s => session.equipped[s[0]] && !REQUIRED_SLOTS[s[0]])
        .map(s => `<button class="chip" onclick="unequip('${s[0]}')">${s[1]} 벗기</button>`).join('')}</div>
      <p class="sub">상의와 하의는 다른 옷으로 바꿀 수만 있어요.</p>
    </div>
    ${owned.length ? slotTabs().map(([slot, label]) => {
      const mine = owned.filter(it => it.slot === slot);
      if (!mine.length) return '';
      return `<h3 class="closethead">${label} <span class="small">${mine.length}</span></h3>
      <div class="closet-list">${mine.map(it => {
        const on = session.equipped[it.slot] === it.id;
        return `<button class="item ${on ? 'sel' : ''}" onclick="equipOwned('${it.id}')">
          <div class="item-icon">${thumb(it)}</div><b>${esc(it.name)}</b>
          <span class="price">${on ? '착용 중' : '착용하기'}</span></button>`;
      }).join('')}</div>`;
    }).join('') : `<div class="panel center empty">아직 보유한 아이템이 없어요.</div>`}
  </div>`, { title: 'MY CLOSET' });
}

function my() {
  const weeklyDone = Object.keys(db.weeklyResults[session.nick] || {}).length;
  const liveDone = Object.values(session.liveAnswered).filter(Boolean).length;
  shell(`<div class="page">
    <div class="panel center">
      <h2>${esc(session.nick)}</h2>
      <div class="stagebox">${stage(session, 3.4)}</div>
      ${progressBar()}
      <p class="sub">학기 진행도</p>
    </div>
    <div class="panel">
      <div class="mission"><span class="mtask">보유 포션</span><b>${session.potions} <i class="g pot"></i></b></div>
      <div class="mission"><span class="mtask">푼 주차 퀴즈</span><b>${weeksDone(session)}주차</b></div>
      <div class="mission"><span class="mtask">Live Quiz 참여</span><b>${liveDone}회</b></div>
      <div class="mission"><span class="mtask">Weekly Quiz 완료</span><b>${weeklyDone}주차</b></div>
      <div class="mission"><span class="mtask">보유 아이템</span><b>${session.inventory.length}개</b></div>
    </div>
    <p class="sub center">app.js ${APP_BUILD}</p>
    <button class="btn ghost" onclick="go('credits')">아트워크 출처 (CREDITS)</button>
    <button class="btn ghost" onclick="logout()">로그아웃</button>
  </div>`, { title: '내 정보' });
}

/* ============================================================
   Credits — required by the LPC artwork licenses
   ============================================================ */

function credits() {
  const authors = [...new Set(CREDITS.flatMap(c => c.authors))].sort();
  const lics = [...new Set(CREDITS.map(c => c.license).filter(Boolean))].sort();
  shell(`<div class="page">
    <div class="panel">
      <h3>아바타 아트워크</h3>
      <p class="small">이 앱의 캐릭터 그래픽은 OpenGameArt.org의 Liberated Pixel Cup (LPC) 프로젝트 에셋을 사용합니다.</p>
      <p class="small">적용 라이선스: ${lics.map(esc).join(' / ')}</p>
      <p class="small">출처: opengameart.org/content/lpc-collection</p>
    </div>
    <div class="panel">
      <h3>배경 타일</h3>
      <p class="small">배경 잔디와 벽돌은 LPC Asset Collection의 terrain 타일이며 CC-BY-SA 4.0 / GPL 3.0로 배포됩니다.</p>
    </div>
    <div class="panel">
      <h3>동일조건 변경허락 안내</h3>
      <p class="small">CC-BY-SA 조건의 에셋이 포함되어 있습니다. 이 앱의 그래픽 파일을 수정해 다시 배포하실 경우, 해당 이미지는 같은 라이선스를 유지해야 합니다. 앱 코드에는 적용되지 않습니다.</p>
    </div>
    <div class="panel">
      <h3>참여 작가 (${authors.length}명)</h3>
      <p class="small">${authors.map(esc).join(', ')}</p>
    </div>
    <div class="panel">
      <p class="small">에셋별 라이선스 원본은 배포 파일의 avatar-credits.json 에 포함되어 있습니다.</p>
    </div>
  </div>`, { back: 'my', title: 'CREDITS' });
}

/* ============================================================
   Celebration
   ============================================================ */

function confetti() {
  if (window.cf) return;
  window.cf = 1;
  for (let i = 0; i < 40; i++) {
    const d = document.createElement('div');
    d.className = 'confetti-piece';
    d.textContent = ['🎉', '✨', '🎓', '🌸'][Math.floor(Math.random() * 4)];
    d.style.left = Math.random() * 100 + 'vw';
    d.style.animationDuration = (2 + Math.random() * 3) + 's';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 6000);
  }
}

function ending() {
  confetti();
  // Fireworks are placed at fixed spots with staggered delays so the sky
  // keeps popping instead of flashing all at once.
  shell(`<div class="page center ending">
    <h1 class="small-h1">CONGRATULATIONS!</h1>
    <div class="stagebox">${stage(session, 4, null, 'night')}</div>
    <div class="certificate">
      <p class="sub">CERTIFICATE OF COMPLETION</p>
      <h2>${esc(session.nick)}</h2>
      <p>General Chemistry Completed</p>
      <p class="sub">주차 퀴즈 ${weeksDone(session)}개 완료 · ${session.potions} <i class="g pot"></i></p>
    </div>
  </div>`, { back: 'home', title: 'ENDING', theme: 'night-bg' });
}

/* ============================================================
   Professor dashboard
   ============================================================ */

const nextId = () => db.liveQueue.reduce((m, q) => Math.max(m, q.id), 0) + 1;

// Only one quiz card is expanded at a time; the list stays scannable
// once a semester's worth of questions has accumulated.
let openQuiz = null;
window.toggleQuiz = id => { openQuiz = (openQuiz === id ? null : id); render(); };

window.addLive = () => {
  const id = nextId();
  const n = db.liveQueue.length + 1;
  db.liveQueue.push({ id, ord: id, title: `Quiz ${n}`, question: '', options: ['', '', ''],
                      correct: 0, participationReward: 20, correctReward: 30,
                      status: 'ready', responses: {} });
  openQuiz = id;
  save(); render();
};

window.saveLive = async id => {
  const q = db.liveQueue.find(x => x.id === id);
  q.title = document.querySelector(`#lt${id}`).value;
  q.question = document.querySelector(`#lq${id}`).value;
  q.options = [0, 1, 2].map(i => document.querySelector(`#lo${id}_${i}`).value);
  q.correct = Number(document.querySelector(`#lc${id}`).value);
  if (SB) {
    try {
      await rpc('admin_save_quiz', { p_token: TOKEN, p_quiz: {
        id: q.id, ord: q.ord || q.id, title: q.title, question: q.question,
        options: q.options, correct: q.correct,
        part_reward: q.participationReward, correct_reward: q.correctReward } });
    } catch (e) { return alert(e.message); }
  } else save();
  alert('저장했습니다.');
};

window.startLive = async id => {
  const q0 = db.liveQueue.find(x => x.id === id);
  if (q0) q0.week = currentWeek();          // marks which week this round belongs to
  if (SB) return guard(async () => {
    await rpc('admin_set_status', { p_token: TOKEN, p_quiz: id, p_status: 'active' });
    tallyLoaded.delete(id);
    if (session) { session.liveAnswered[id] = false; session.liveRewarded[id] = false; }
  });
  db.liveQueue.forEach(q => { if (q.status === 'active') q.status = 'ready'; });
  const q = db.liveQueue.find(x => x.id === id);
  q.status = 'active'; q.responses = {}; db.activeLiveId = id;
  Object.values(db.users).forEach(u => { u.liveAnswered[id] = false; u.liveRewarded[id] = false; });
  save(); render();
};

window.endLive = async id => {
  if (SB) return guard(() => rpc('admin_set_status', { p_token: TOKEN, p_quiz: id, p_status: 'ended' }));
  const q = db.liveQueue.find(x => x.id === id);
  q.status = 'ended'; db.activeLiveId = id;
  save(); render();
};

window.startNext = () => {
  const i = db.liveQueue.findIndex(q => q.id === db.activeLiveId);
  const n = db.liveQueue.slice(i + 1).find(q => q.status === 'ready');
  if (!n) return alert('다음 순서의 READY 퀴즈가 없습니다.');
  startLive(n.id);
};

// The list only knows how many questions a week has, so the editor must pull
// the real bodies (with answers) before rendering, or saving would blank them.
window.editWeek = async w => {
  currentWeekly = w; page = 'weekedit';
  if (SB) return guard(async () => {
    const r = await rpc('admin_get_weekly', { p_token: TOKEN, p_week: w });
    const slot = db.weekly.find(x => x.week === w);
    slot.title = r.title || '';
    slot.status = r.status;
    slot.completionReward = r.completion_reward;
    slot.correctReward = r.correct_reward;
    slot.questions = (r.questions || []).map(q => ({
      q: q.q || '', o: q.o || ['', '', ''], a: q.a ?? 0, explanation: q.explanation || ''
    }));
  });
  render();
};
window.addQuestion = () => {
  const w = db.weekly.find(x => x.week === currentWeekly);
  if (w.questions.some(q => q === null)) return alert('문제를 불러오는 중입니다.');
  w.questions.push({ q: '', o: ['', '', ''], a: 0, explanation: '' });
  render();
};

window.saveWeek = async () => {
  const w = db.weekly.find(x => x.week === currentWeekly);
  // Never save placeholders: that is what wiped questions before.
  if (w.questions.some(q => q === null)) {
    return alert('문제를 불러오는 중입니다. 잠시 후 다시 저장해 주세요.');
  }
  w.title = wtitle.value;
  w.questions = w.questions.map((q, qi) => ({
    q: document.querySelector(`#wq${qi}`).value,
    o: [0, 1, 2].map(i => document.querySelector(`#wo${qi}_${i}`).value),
    a: Number(document.querySelector(`#wa${qi}`).value),
    explanation: document.querySelector(`#we${qi}`).value
  }));
  if (SB) {
    try {
      await rpc('admin_save_weekly', { p_token: TOKEN, p_week: {
        week: w.week, title: w.title, status: w.status,
        completion_reward: w.completionReward, correct_reward: w.correctReward,
        questions: w.questions } });
    } catch (e) { return alert(e.message); }
  } else save();
  alert('저장했습니다.');
};

// The week list only carries question *counts*, so saving the whole week from
// here would overwrite the real questions with an empty array. Status changes
// therefore go through a function that touches nothing else.
window.setWeek = async (w, st) => {
  const slot = db.weekly.find(x => x.week === w);
  slot.status = st;
  if (SB) return guard(() => rpc('admin_set_weekly_status',
                                 { p_token: TOKEN, p_week: w, p_status: st }));
  save(); render();
};
/* ============================================================
   참여 현황
   Loaded on demand so the dashboard stays light; the numbers come from
   the server, which is the only place that can see every student.
   ============================================================ */
let stats = null, statWeek = null, statDetail = null;

window.loadStats = async () => {
  if (!SB) return alert('연습 모드에서는 참여 현황을 볼 수 없습니다.');
  await guard(async () => {
    const [w, l] = await Promise.all([
      rpc('admin_weekly_stats', { p_token: TOKEN }),
      rpc('admin_live_stats', { p_token: TOKEN })
    ]);
    stats = { weekly: w, live: l };
    statWeek = null; statDetail = null;
    page = 'stats';
  });
};

window.openWeekDetail = async wk => {
  if (statWeek === wk) { statWeek = null; statDetail = null; return render(); }
  await guard(async () => {
    statDetail = await rpc('admin_week_detail', { p_token: TOKEN, p_week: wk });
    statWeek = wk;
  });
};

function statsPage() {
  const wk = stats?.weekly || [], lv = stats?.live || [];
  const total = wk[0]?.students ?? 0;
  shell(`<div class="page">
    <div class="panel soft center">
      <p class="small">등록 학생 <b>${total}명</b> · 숫자를 누르면 명단이 열립니다.</p>
    </div>

    <div class="panel">
      <h3>주차별 퀴즈</h3>
      ${wk.filter(w => w.questions > 0 || w.done > 0).length === 0
        ? '<p class="small">아직 문제가 등록된 주차가 없습니다.</p>'
        : wk.filter(w => w.questions > 0 || w.done > 0).map(w => {
        const pct = total ? Math.round(w.done / total * 100) : 0;
        return `<div class="mission" onclick="openWeekDetail(${w.week})" style="cursor:pointer">
          <span class="mtask"><b>${w.week}주차</b>
            <i class="prog">${w.status === 'open' ? '열림' : w.status === 'closed' ? '마감' : '잠김'}</i></span>
          <span class="mmeta">
            <i class="prog">평균 ${w.avg_correct ?? '-'}/${w.questions}</i>
            <b>${w.done} / ${total}</b><i class="prog">${pct}%</i></span>
        </div>
        ${statWeek === w.week ? `<div class="panel soft">
          <p class="small">완료 ${statDetail.filter(d => d.done).length}명 ·
             미완료 ${statDetail.filter(d => !d.done).length}명</p>
          <div class="namegrid">${statDetail.map(d =>
            `<span class="name ${d.done ? 'ok' : 'no'}">${esc(d.nick)}${d.done ? ` <i>${d.correct}</i>` : ''}</span>`
          ).join('')}</div>
        </div>` : ''}`;
      }).join('')}
    </div>

    <div class="panel">
      <h3>라이브 퀴즈</h3>
      ${lv.length === 0 ? '<p class="small">아직 문제가 없습니다.</p>' : lv.map(q => {
        const pct = q.answered ? Math.round(q.correct_n / q.answered * 100) : 0;
        return `<div class="mission">
          <span class="mtask">${esc(q.title || '(제목 없음)')}
            <i class="prog">${q.status.toUpperCase()}</i></span>
          <span class="mmeta"><i class="prog">정답률 ${pct}%</i><b>${q.answered} / ${total}</b></span>
        </div>`;
      }).join('')}
    </div>

    <button class="btn ghost" onclick="loadStats()">새로고침</button>
    <button class="btn ghost" onclick="page='admin';render()">← Dashboard</button>
  </div>`, { title: '참여 현황' });
}

window.setSemesterWeek = async n => {
  const w = Math.min(TOTAL_WEEKS, Math.max(1, n));
  db.currentWeek = w;
  if (SB) return guard(() => rpc('admin_set_week', { p_token: TOKEN, p_week: w }));
  save(); render();
};

window.delMessage = async (id, ts) => {
  if (!confirm('이 메시지를 지울까요?')) return;
  if (SB) return guard(async () => {
    await rpc('admin_delete_message', { p_token: TOKEN, p_id: id });
    db.messages = db.messages.filter(m => m.ts !== ts);
  });
  db.messages = db.messages.filter(m => m.ts !== ts);
  save(); render();
};

window.clearChat = async () => {
  if (!confirm('채팅 기록을 전부 지울까요? 되돌릴 수 없습니다.')) return;
  if (SB) return guard(async () => {
    await rpc('admin_clear_chat', { p_token: TOKEN });
    db.messages = [];
  });
  db.messages = []; save(); render();
};

window.delQuiz = async id => {
  if (!confirm('이 문제와 응답 기록을 지울까요? 되돌릴 수 없습니다.')) return;
  if (SB) return guard(async () => {
    await rpc('admin_delete_quiz', { p_token: TOKEN, p_quiz: id });
    db.liveQueue = db.liveQueue.filter(q => q.id !== id);
  });
  db.liveQueue = db.liveQueue.filter(q => q.id !== id);
  save(); render();
};

window.resetQuiz = async id => {
  if (!confirm('응답만 지우고 문제는 남길까요? 학생들이 다시 풀 수 있습니다.')) return;
  if (SB) return guard(async () => {
    await rpc('admin_reset_responses', { p_token: TOKEN, p_quiz: id });
    const q = db.liveQueue.find(x => x.id === id);
    if (q) { q.responses = {}; q.status = 'ready'; }
  });
  const q = db.liveQueue.find(x => x.id === id);
  if (q) { q.responses = {}; q.status = 'ready'; }
  save(); render();
};

window.postNotice = async () => {
  const t = notice.value.trim();
  if (!t) return;
  notice.value = '';
  if (SB) return guard(() => rpc('send_message', { p_token: TOKEN, p_text: t }));
  db.messages.push({ name: session.nick, admin: true, text: t, ts: Date.now() });
  save(); render();
};

window.completeSemester = async () => {
  if (!confirm('Semester Complete를 열까요?')) return;
  db.semesterComplete = true;
  if (SB) return guard(() => rpc('admin_set_room', { p_token: TOKEN, p_data: { semesterComplete: true } }));
  save(); render();
};

function weekedit() {
  const w = db.weekly.find(x => x.week === currentWeekly);
  shell(`<div class="page">
    <button class="btn ghost" onclick="page='admin';render()">← Dashboard</button>
    <div class="panel"><h2>Week ${w.week}</h2><input id="wtitle" class="input" value="${esc(w.title)}"></div>
    ${w.questions.map((q, qi) => `<div class="panel"><b>Question ${qi + 1}</b>
      <input id="wq${qi}" class="input" value="${esc(q.q)}" placeholder="문제">
      ${[0, 1, 2].map(i => `<input id="wo${qi}_${i}" class="input" value="${esc(q.o[i])}" placeholder="선택지 ${i + 1}">`).join('')}
      <select id="wa${qi}" class="input">${[0, 1, 2].map(i => `<option value="${i}" ${q.a === i ? 'selected' : ''}>정답 ${i + 1}</option>`).join('')}</select>
      <textarea id="we${qi}" class="input" placeholder="해설">${esc(q.explanation)}</textarea>
    </div>`).join('')}
    <button class="btn yellow" onclick="addQuestion()">+ 문제 추가</button>
    <button class="btn green" onclick="saveWeek()">저장</button>
  </div>`);
}

function admin() {
  const active = getActive();
  shell(`<div class="page">
    <div class="center">
      <div class="stagebox">${stage(session, 3.4)}</div>
      <h2>Professor Dashboard</h2>
    </div>
    <div class="panel soft center">
      <p class="small">${ONLINE ? (syncErr ? '⚠ 서버 오류: ' + esc(syncErr) : '수업 서버에 연결되어 있습니다. 학생 화면이 실시간으로 바뀝니다.')
                                : '⚠ 연습 모드입니다. config.js 를 채워야 학생과 공유됩니다.'}</p>
      ${active ? `<p class="small">현재 퀴즈 응답 <b>${Object.keys(active.responses || {}).length}명</b></p>` : ''}
    </div>
    <div class="panel">
      <div class="row"><h3>Live Quiz (${db.liveQueue.length}개)</h3><button class="btn inline yellow" onclick="addLive()">+ ADD</button></div>
      <p class="small">제목을 누르면 펼쳐집니다. 진행 중이거나 오늘 편집한 문제만 열려 있어요.</p>
      ${db.liveQueue.map(q => {
        const open = openQuiz === q.id || q.status === 'active';
        const n = Object.keys(q.responses || {}).length;
        return `<div class="panel soft quizcard ${open ? 'open' : ''}">
        <button class="quizhead" onclick="toggleQuiz(${q.id})">
          <span class="qname">${esc(q.title || '(제목 없음)')}</span>
          <span class="badge ${q.status === 'active' ? 'live' : ''}">${q.status.toUpperCase()}</span>
          ${n ? `<span class="small">${n}명</span>` : ''}
          <span class="caret">${open ? '▾' : '▸'}</span>
        </button>
        ${open ? `
        <input id="lt${q.id}" class="input" value="${esc(q.title)}" placeholder="제목 (예: 3주차 1번)">
        <textarea id="lq${q.id}" class="input" placeholder="문제">${esc(q.question)}</textarea>
        ${q.options.map((o, i) => `<input id="lo${q.id}_${i}" class="input" value="${esc(o)}" placeholder="선택지 ${i + 1}">`).join('')}
        <select id="lc${q.id}" class="input">${[0, 1, 2].map(i => `<option value="${i}" ${(q.correct ?? 0) === i ? 'selected' : ''}>정답 ${i + 1}</option>`).join('')}</select>
        <div class="row"><button class="btn ghost" onclick="saveLive(${q.id})">SAVE</button><button class="btn green" onclick="startLive(${q.id})">START</button><button class="btn red" onclick="endLive(${q.id})">END</button></div>
        <div class="row"><button class="btn inline ghost" onclick="resetQuiz(${q.id})">응답 초기화</button><button class="btn inline red" onclick="delQuiz(${q.id})">문제 삭제</button></div>
        ${q.status === 'ended' ? '<p class="small">종료된 문제입니다. 다시 START 하면 응답과 지급 기록이 지워집니다.</p>' : ''}` : ''}
      </div>`;
      }).join('')}
      ${active?.status === 'ended' ? `<button class="btn green" onclick="startNext()">START NEXT QUIZ ▶</button>` : ''}
    </div>
    <div class="panel">
      <h3>Weekly Quiz Manager — 15 Weeks</h3>
      ${db.weekly.map(w => `<div class="mission">
        <div><b>${w.week}주차</b>${w.title && w.title !== `Week ${w.week}` ? ' · ' + esc(w.title) : ''}<br><span class="small">${w.status.toUpperCase()} · 문제 ${w.questions.length}개</span></div>
        <div class="adminbtns"><button class="btn inline ghost" onclick="editWeek(${w.week})">EDIT</button><button class="btn inline green" onclick="setWeek(${w.week},'open')">OPEN</button><button class="btn inline red" onclick="setWeek(${w.week},'closed')">CLOSE</button></div>
      </div>`).join('')}
    </div>
    <button class="btn yellow" onclick="loadStats()"><i class="g book"></i> 학생 참여 현황 보기</button>
    <div class="panel">
      <h3>학기 진행</h3>
      <p class="small">학생 홈 화면의 진행바가 여기에 맞춰집니다. 매주 수업 후 한 칸씩 넘겨 주세요.</p>
      ${progressBar()}
      <div class="row">
        <button class="btn ghost" onclick="setSemesterWeek(${currentWeek() - 1})" ${currentWeek() <= 1 ? 'disabled' : ''}>◀ 이전 주</button>
        <button class="btn green" onclick="setSemesterWeek(${currentWeek() + 1})" ${currentWeek() >= TOTAL_WEEKS ? 'disabled' : ''}>다음 주 ▶</button>
      </div>
    </div>
    <div class="panel">
      <h3>공지 보내기</h3>
      <p class="small">학생 채팅방에 관리자 공지로 올라갑니다.</p>
      <textarea id="notice" class="input" rows="2" placeholder="예) 다음 Live Quiz는 수요일 2교시에 진행합니다."></textarea>
      <button class="btn green" onclick="postNotice()">공지 등록</button>
      ${db.messages.length ? `
        <div class="row" style="margin-top:16px"><h3>최근 대화 (${db.messages.length}건)</h3>
          <button class="btn inline red" onclick="clearChat()">전체 삭제</button></div>
        ${db.messages.slice(-12).reverse().map(m => `<div class="mission">
          <span class="mtask">${m.admin ? '<span class="badge admin">공지</span> ' : ''}<b>${esc(m.name)}</b> ${esc(m.text)}</span>
          <span class="mmeta"><i class="prog">${hhmm(m.ts)}</i>
            <button class="btn inline red" onclick="delMessage(${m.id ?? 'null'}, ${m.ts})">삭제</button></span>
        </div>`).join('')}` : '<p class="small">아직 대화가 없습니다.</p>'}
    </div>
    <div class="panel"><h3>🎓 Semester Complete</h3><button class="btn green" onclick="completeSemester()">COMPLETE SEMESTER</button></div>
    <button class="btn ghost" onclick="logout()">로그아웃</button>
  </div>`);
}

/* ============================================================
   Router
   ============================================================ */

function render() {
  if (draft) return createPage();
  if (!session) return login();
  if (session.isAdmin && page === 'admin') return admin();
  ({ home, quiz: quizHub, live, weekly, weeklyrun, chat, shop, closet, my, credits, ending, weekedit, admin, stats: statsPage }[page] || home)();
}

async function boot() {
  await loadAvatars();
  try {
    await connect();
  } catch (e) {
    syncErr = e.message || String(e);
    console.error('connect failed', e);
  }
  if (!ONLINE) {
    const prof = Object.values(db.users).find(u => u.isAdmin);
    if (prof) dressProfessor(prof);
    Object.values(db.users).forEach(u => { if (!u.isAdmin) ensureDressed(u); });
  } else if (session) {
    if (session.isAdmin) dressProfessor(session); else ensureDressed(session);
  }
  render();
}

boot().catch(e => {
  app.innerHTML = `<div class="phone"><div class="page center">
    <h2>아바타 데이터를 불러오지 못했습니다</h2>
    <p class="small">avatar-atlas.png / avatar-manifest.json 이 index.html과 같은 폴더에 있는지 확인해 주세요.<br>
    파일을 더블클릭해서 열지 말고 <b>python3 -m http.server 8000</b> 으로 실행해야 합니다.</p>
    <p class="small">${esc(e.message)}</p></div></div>`;
});
