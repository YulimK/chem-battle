/* ============================================================
   Chem World v4 — LPC pixel avatars
   Artwork: Liberated Pixel Cup (OpenGameArt.org).
   Credits are shown in-app under 내 정보 → CREDITS.
   ============================================================ */

const APP_BUILD = 'v17-night-bg';
console.log('%cChem Battle app.js ' + APP_BUILD, 'background:#e0b74e;color:#241a02;padding:2px 8px;font-weight:700');

const app = document.getElementById('app');
const KEY = 'chemWorldV8';
const LV_STEP = 1000;

let AV = null;        // avatar manifest
let CREDITS = [];     // credits list
let FRAME = {};       // base frame lookup: id -> frame index
let WEAR = {};        // slot -> [items]

const weekSlots = () => Array.from({ length: 15 }, (_, i) => ({
  week: i + 1, title: `Week ${i + 1}`,
  status: i === 0 ? 'open' : 'locked',
  completionReward: 20, correctReward: 5, questions: []
}));

let db = JSON.parse(localStorage.getItem(KEY) || 'null') || {
  users: {},
  liveQueue: [
    { id: 1, title: 'Live Quiz 1', question: '다음 중 화학식량이 가장 큰 것은?', options: ['H₂O', 'CO₂', 'NH₃'], correct: 1, participationReward: 10, correctReward: 10, status: 'ready', responses: {} },
    { id: 2, title: 'Live Quiz 2', question: '다음 중 이온결합 물질은?', options: ['NaCl', 'H₂O', 'CH₄'], correct: 0, participationReward: 10, correctReward: 10, status: 'ready', responses: {} }
  ],
  activeLiveId: null,
  weekly: weekSlots(),
  weeklyResults: {},
  messages: [{ name: 'Professor', admin: true, text: 'Welcome to Chem Battle!', ts: Date.now() }],
  semesterComplete: false
};

let session = null, page = 'home', currentWeekly = null,
    weeklyAnswers = {}, weeklyIndex = 0, shopTab = 'hair', tryOn = {}, draft = null;

const STARTER = ['hair_plain.dark_brown', 'torso_clothes_longsleeve.white', 'legs_pants.navy', 'feet_shoes_basic.black'];

// Slots that must always hold something. These can be swapped for another
// item but never emptied, so a character can't end up undressed.
const REQUIRED_SLOTS = { torso: 'torso_clothes_longsleeve.white',
                         legs:  'legs_pants.navy' };

// Repairs any character missing a required slot: prefers something they
// already own, otherwise grants the starter piece.
function ensureDressed(u) {
  let changed = false;
  Object.entries(REQUIRED_SLOTS).forEach(([slot, fallback]) => {
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
const PROF_FIT = ['feet_shoes_revised.black', 'legs_formal.gray',
                  'torso_clothes_longsleeve2_buttoned.white',
                  'torso_aprons_apron_full.white', 'hair_wavy.platinum',
                  'facial_glasses_halfmoon', 'weapon_magic_simple.simple'];
const DEFAULT_BODY = { skin: 'light', eye: 'blue', face: 'heads_human_female' };
const PAGE_SIZE = 60;
let shopPage = 0;

const save = () => localStorage.setItem(KEY, JSON.stringify(db));
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
  const pieces = [FRAME[`body.${b.skin}`], FRAME[`face.${b.face}.${b.skin}.${b.eye}`]];
  Object.values(eq).forEach(id => { const it = id && itemById(id); if (it) pieces.push(it); });
  return pieces.filter(Boolean)
    .flatMap(p => p.layers)
    .sort((a, b2) => a.z - b2.z)
    .map(l => l.f);
}

// Stacked atlas slices; `s` is the pixel scale factor.
function sprite(u, s = 3, temp = null) {
  if (!AV || !u?.body) return '<div class="av"></div>';
  const C = AV.cell, COLS = AV.cols;
  const cells = layerFrames(u, temp).map(f => {
    const x = -(f % COLS) * C * s, y = -Math.floor(f / COLS) * C * s;
    return `<i style="background-position:${x}px ${y}px"></i>`;
  }).join('');
  const px = C * s;
  return `<div class="av" style="width:${px}px;height:${px}px;--bw:${COLS * C * s}px">${cells}</div>`;
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
const THUMB_BASE = { torso: 'torso_clothes_longsleeve.white',
                     legs: 'legs_pants.navy',
                     feet: 'feet_shoes_basic.black' };

// Shop thumbnail: the player's character, decently dressed, wearing the item.
function thumb(item) {
  const eq = {};
  Object.entries(THUMB_BASE).forEach(([slot, id]) => {
    if (slot !== item.slot && itemById(id)) eq[slot] = id;
  });
  eq[item.slot] = item.id;
  return sprite({ body: session.body, equipped: eq }, 1.4);
}

/* ============================================================
   Data model
   ============================================================ */

function mkUser(nick, pin, body, isAdmin = false) {
  return {
    nick, pin, isAdmin,
    body: body || { ...(isAdmin ? PROF_BODY : DEFAULT_BODY) },
    potions: isAdmin ? 999 : 200,
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

const levelOf = u => Math.floor((u.xp || 0) / LV_STEP) + 1;
const xpInLevel = u => (u.xp || 0) % LV_STEP;

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
      <div class="field"><span class="fico g user"></span><input id="nick" class="input" value="${esc(r)}" placeholder="닉네임 (한글/영어)"></div>
      <div class="field"><span class="fico g lock"></span><input id="pin" class="input" type="password" inputmode="numeric" maxlength="4" placeholder="4자리 숫자 PIN"></div>
      <label class="check"><input id="remember" type="checkbox" ${r ? 'checked' : ''}> 닉네임 기억하기</label>
      <div id="err" class="errline"></div>
      <button class="btn green" onclick="doLogin()">LOGIN</button>
      <p class="sub">처음이신가요?</p>
      <button class="linkbtn" onclick="startCreate()">캐릭터 만들기 ></button>
    </div>
  </div>`;
}

window.startCreate = () => {
  const n = nick.value.trim(), p = pin.value.trim();
  if (!validNick(n)) return err.textContent = '닉네임은 한글/영문/숫자만 쓸 수 있어요.';
  if (!/^\d{4}$/.test(p)) return err.textContent = 'PIN은 숫자 4자리로 입력해 주세요.';
  if (db.users[n]) return err.textContent = '이미 사용 중인 닉네임이에요.';
  draft = { nick: n, pin: p, body: { ...DEFAULT_BODY } };
  render();
};

window.setDraft = (k, v) => { draft.body[k] = v; render(); };

window.finishCreate = () => {
  db.users[draft.nick] = mkUser(draft.nick, draft.pin, draft.body);
  session = db.users[draft.nick];
  STARTER.forEach(id => {
    const it = itemById(id);
    if (it) { session.inventory.push(id); session.equipped[it.slot] = id; }
  });
  ensureDressed(session);
  draft = null; page = 'home';
  checkIn(); save(); render();
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

window.doLogin = () => {
  const n = nick.value.trim(), p = pin.value.trim();
  if (n === 'Professor' && !db.users[n]) db.users[n] = mkUser(n, '0000', null, true);
  const u = db.users[n];
  if (!u || u.pin !== p) return err.textContent = '닉네임 또는 PIN이 맞지 않아요.';
  if (remember.checked) localStorage.setItem('cwRemember', n); else localStorage.removeItem('cwRemember');
  session = u;
  if (u.isAdmin) dressProfessor(u);
  page = u.isAdmin ? 'admin' : 'home';
  checkIn(); save(); render();
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

function checkIn() {
  if (session.isAdmin) return;
  if (session.lastLogin !== today()) { session.lastLogin = today(); award(10); }
}

window.logout = () => { session = null; page = 'home'; login(); };

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
  app.innerHTML = `<div class="phone${opts.theme ? ' ' + opts.theme : ''}"><div class="top">${left}${title}${right}</div>${html}${nav}</div>`;
}

window.go = p => { page = p; render(); };

/* ============================================================
   Home
   ============================================================ */

function missions() {
  const liveCount = Object.values(session.liveAnswered).filter(Boolean).length;
  const weeklyCount = Object.keys(db.weeklyResults[session.nick] || {}).length;
  return [
    { key: 'attend', label: '출석하기', now: session.lastLogin === today() ? 1 : 0, goal: 1, reward: 10, auto: true },
    { key: 'live3', label: 'Live Quiz 참여 3회', now: Math.min(liveCount, 3), goal: 3, reward: 30 },
    { key: 'weekly1', label: 'Weekly Quiz 완료', now: Math.min(weeklyCount, 1), goal: 1, reward: 40 }
  ];
}

function settleMissions(list) {
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
      <p class="lv">Lv.${levelOf(session)}</p>
      <div class="stagebox">${stage(session, 4)}</div>
      <div class="xp">
        <div class="xpbar"><div class="xpfill" style="width:${xpInLevel(session) / LV_STEP * 100}%"></div></div>
        <span class="xptext">${xpInLevel(session)} / ${LV_STEP}</span>
      </div>
    </div>
    <div class="panel">
      <h3>이번 주 미션</h3>
      ${ms.map(m => {
        const done = m.now >= m.goal;
        return `<div class="mission">
          <span class="mtask ${done ? 'done' : ''}"><i class="box">${done ? '☑' : '☐'}</i>${m.label}</span>
          <span class="mmeta">${m.goal > 1 ? `<i class="prog">${m.now} / ${m.goal}</i>` : ''}<b>+${m.reward} <i class="g pot"></i></b></span>
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

window.submitLive = () => {
  const q = getActive(), s = document.querySelector('.quiz-option.selected');
  if (!s) return alert('답을 먼저 선택해 주세요.');
  q.responses[session.nick] = Number(s.dataset.live);
  session.liveAnswered[q.id] = true;
  db.users[session.nick] = session;
  save(); render();
};

function live() {
  const q = getActive();
  if (!q) return shell(`<div class="page"><div class="panel center empty"><p>지금 열려 있는 Live Quiz가 없어요.</p><p class="sub">교수님이 퀴즈를 시작하면 여기에 나타납니다.</p></div></div>`, { back: 'quiz', title: 'LIVE QUIZ' });
  const mine = q.responses[session.nick];

  if (session.liveAnswered[q.id] && q.status === 'active') {
    return shell(`<div class="page">
      <div class="notice-band">교수님이 퀴즈를 종료하면 결과를 확인할 수 있어요!</div>
      <div class="panel"><h3>${esc(q.question)}</h3>
        ${q.options.map((o, i) => `<div class="quiz-option ${mine === i ? 'selected' : ''}">${i + 1}) ${esc(o)}</div>`).join('')}
      </div>
      <div class="wait">⌛ 답을 제출했어요!<br><b>교수님이 퀴즈를 종료할 때까지 기다려 주세요.</b></div>
    </div>`, { back: 'quiz', title: 'LIVE QUIZ' });
  }

  if (q.status === 'ended') {
    const counts = q.options.map(() => 0);
    Object.values(q.responses).forEach(i => { if (counts[i] != null) counts[i]++; });
    const total = Object.keys(q.responses).length;
    const reward = mine == null ? 0 : q.participationReward + (mine === q.correct ? q.correctReward : 0);
    if (mine != null && !session.liveRewarded[q.id]) {
      session.liveRewarded[q.id] = true; award(reward); save();
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
        <h3>전체 응답 분포 <span class="sub">(참여 ${total}명)</span></h3>
        ${counts.map((n, i) => {
          const pct = total ? Math.round(n / total * 100) : 0;
          return `<div class="barrow"><b>${i + 1})</b><div class="barbg"><div class="bar" style="width:${pct}%"></div></div><span>${n}명 (${pct}%)</span></div>`;
        }).join('')}
        <p class="small">내 답: ${mine == null ? '미참여' : `${mine + 1}) ${esc(q.options[mine])}`}</p>
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
        <div><b>Week ${w.week}. ${esc(w.title)}</b>
        <p class="wstate">${r ? '✔ 완료' : w.status === 'open' ? '진행 가능' : w.status === 'closed' ? '마감됨' : '잠김'}</p></div>
        <span class="wmeta">${label}${state === 'locked' ? ' <i class="g lock"></i>' : state === 'open' ? ' ›' : ''}</span>
      </div>`;
    }).join('')}
    <p class="sub center foot">각 주차 퀴즈는 여러 번 볼 수 있어요.<br>포션은 첫 완료 시에만 지급됩니다.</p>
  </div>`, { back: 'quiz', title: 'WEEKLY QUIZ' });
}

window.openWeekly = w => { currentWeekly = w; weeklyAnswers = {}; weeklyIndex = 0; page = 'weeklyrun'; render(); };
window.pickWeekly = (q, i) => { weeklyAnswers[q] = i; render(); };
window.gotoQ = i => { weeklyIndex = i; render(); };

window.finishWeekly = () => {
  const w = db.weekly.find(x => x.week === currentWeekly);
  if (Object.keys(weeklyAnswers).length < w.questions.length) return alert('아직 풀지 않은 문제가 있어요.');
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

window.sendMsg = () => {
  const t = msg.value.trim();
  if (!t) return;
  db.messages.push({ name: session.nick, admin: session.isAdmin, text: t, ts: Date.now() });
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

window.buyAllTryOn = () => {
  const cost = tryCost();
  if (session.potions < cost) return alert('포션이 부족해요.');
  Object.values(tryOn).forEach(id => {
    const it = itemById(id);
    if (!session.inventory.includes(id)) { session.inventory.push(id); session.potions -= it.cost; }
    session.equipped[it.slot] = id;
  });
  db.users[session.nick] = session;
  save(); tryOn = {}; render();
};

function shop() {
  const all = WEAR[shopTab] || [];
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const pg = Math.min(shopPage, pages - 1);
  const list = all.slice(pg * PAGE_SIZE, (pg + 1) * PAGE_SIZE);
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
    <div class="shopgrid">${list.map(it => {
      const owned = session.inventory.includes(it.id);
      return `<button class="item ${tryOn[it.slot] === it.id ? 'sel' : ''}" onclick="tryOnItem('${it.id}')">
        <div class="item-icon">${thumb(it)}</div>
        <b>${esc(it.name)}</b>
        <span class="price">${owned ? '보유 ✓' : `${it.cost} <i class="g pot"></i>`}</span>
      </button>`;
    }).join('')}</div>
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
    ${owned.length ? `<div class="closet-list">${owned.map(it => {
      const on = session.equipped[it.slot] === it.id;
      return `<button class="item ${on ? 'sel' : ''}" onclick="equipOwned('${it.id}')">
        <div class="item-icon">${thumb(it)}</div><b>${esc(it.name)}</b>
        <span class="price">${on ? '착용 중' : '착용하기'}</span></button>`;
    }).join('')}</div>` : `<div class="panel center empty">아직 보유한 아이템이 없어요.</div>`}
  </div>`, { title: 'MY CLOSET' });
}

function my() {
  const weeklyDone = Object.keys(db.weeklyResults[session.nick] || {}).length;
  const liveDone = Object.values(session.liveAnswered).filter(Boolean).length;
  shell(`<div class="page">
    <div class="panel center">
      <h2>${esc(session.nick)}</h2><p class="lv">Lv.${levelOf(session)}</p>
      <div class="stagebox">${stage(session, 3.4)}</div>
      <div class="xp"><div class="xpbar"><div class="xpfill" style="width:${xpInLevel(session) / LV_STEP * 100}%"></div></div><span class="xptext">${xpInLevel(session)} / ${LV_STEP}</span></div>
    </div>
    <div class="panel">
      <div class="mission"><span class="mtask">보유 포션</span><b>${session.potions} <i class="g pot"></i></b></div>
      <div class="mission"><span class="mtask">누적 경험치</span><b>${session.xp}</b></div>
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
      <p class="small">배경 잔디는 LPC Asset Collection의 terrain 타일이며 CC-BY-SA 4.0 / GPL 3.0로 배포됩니다. 이 이미지(bg-grass.png)를 수정해 재배포할 경우 동일 조건을 유지해야 합니다.</p>
    </div>
    <div class="panel">
      <h3>참여 작가 (${authors.length}명)</h3>
      <p class="small">${authors.map(esc).join(', ')}</p>
    </div>
    <div class="panel">
      <h3>에셋별 상세</h3>
      ${CREDITS.map(c => `<div class="mission"><span class="mtask">${esc(c.name)}</span><span class="small">${esc(c.license || '')}</span></div>`).join('')}
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
      <p class="sub">Lv.${levelOf(session)} · ${session.potions} <i class="g pot"></i></p>
    </div>
  </div>`, { back: 'home', title: 'ENDING', theme: 'night-bg' });
}

/* ============================================================
   Professor dashboard
   ============================================================ */

const nextId = () => db.liveQueue.reduce((m, q) => Math.max(m, q.id), 0) + 1;

window.addLive = () => {
  db.liveQueue.push({ id: nextId(), title: `Live Quiz ${db.liveQueue.length + 1}`, question: '', options: ['', '', ''], correct: 0, participationReward: 10, correctReward: 10, status: 'ready', responses: {} });
  save(); render();
};

window.saveLive = id => {
  const q = db.liveQueue.find(x => x.id === id);
  q.title = document.querySelector(`#lt${id}`).value;
  q.question = document.querySelector(`#lq${id}`).value;
  q.options = [0, 1, 2].map(i => document.querySelector(`#lo${id}_${i}`).value);
  q.correct = Number(document.querySelector(`#lc${id}`).value);
  save(); alert('저장했습니다.');
};

window.startLive = id => {
  db.liveQueue.forEach(q => { if (q.status === 'active') q.status = 'ready'; });
  const q = db.liveQueue.find(x => x.id === id);
  q.status = 'active'; q.responses = {};
  db.activeLiveId = id;
  Object.values(db.users).forEach(u => { u.liveAnswered[id] = false; u.liveRewarded[id] = false; });
  save(); render();
};

window.endLive = id => {
  const q = db.liveQueue.find(x => x.id === id);
  q.status = 'ended'; db.activeLiveId = id; save(); render();
};

window.startNext = () => {
  const i = db.liveQueue.findIndex(q => q.id === db.activeLiveId);
  const n = db.liveQueue.slice(i + 1).find(q => q.status === 'ready');
  if (!n) return alert('다음 순서의 READY 퀴즈가 없습니다.');
  startLive(n.id);
};

window.editWeek = w => { currentWeekly = w; page = 'weekedit'; render(); };
window.addQuestion = () => { db.weekly.find(x => x.week === currentWeekly).questions.push({ q: '', o: ['', '', ''], a: 0, explanation: '' }); save(); render(); };

window.saveWeek = () => {
  const w = db.weekly.find(x => x.week === currentWeekly);
  w.title = wtitle.value;
  w.questions = w.questions.map((q, qi) => ({
    q: document.querySelector(`#wq${qi}`).value,
    o: [0, 1, 2].map(i => document.querySelector(`#wo${qi}_${i}`).value),
    a: Number(document.querySelector(`#wa${qi}`).value),
    explanation: document.querySelector(`#we${qi}`).value
  }));
  save(); alert('저장했습니다.');
};

window.setWeek = (w, s) => { db.weekly.find(x => x.week === w).status = s; save(); render(); };
window.completeSemester = () => { if (confirm('Semester Complete를 열까요?')) { db.semesterComplete = true; save(); render(); } };

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
    <div class="panel">
      <div class="row"><h3>Today's Live Quiz Queue</h3><button class="btn inline yellow" onclick="addLive()">+ ADD</button></div>
      ${db.liveQueue.map(q => `<div class="panel soft">
        <b>${esc(q.title)}</b> <span class="badge ${q.status === 'active' ? 'live' : ''}">${q.status.toUpperCase()}</span>
        <input id="lt${q.id}" class="input" value="${esc(q.title)}">
        <textarea id="lq${q.id}" class="input" placeholder="문제">${esc(q.question)}</textarea>
        ${q.options.map((o, i) => `<input id="lo${q.id}_${i}" class="input" value="${esc(o)}" placeholder="선택지 ${i + 1}">`).join('')}
        <select id="lc${q.id}" class="input">${[0, 1, 2].map(i => `<option value="${i}" ${q.correct === i ? 'selected' : ''}>정답 ${i + 1}</option>`).join('')}</select>
        <div class="row"><button class="btn ghost" onclick="saveLive(${q.id})">SAVE</button><button class="btn green" onclick="startLive(${q.id})">START</button><button class="btn red" onclick="endLive(${q.id})">END</button></div>
      </div>`).join('')}
      ${active?.status === 'ended' ? `<button class="btn green" onclick="startNext()">START NEXT QUIZ ▶</button>` : ''}
    </div>
    <div class="panel">
      <h3>Weekly Quiz Manager — 15 Weeks</h3>
      ${db.weekly.map(w => `<div class="mission">
        <div><b>Week ${w.week}</b> · ${esc(w.title)}<br><span class="small">${w.status.toUpperCase()} · 문제 ${w.questions.length}개</span></div>
        <div class="adminbtns"><button class="btn inline ghost" onclick="editWeek(${w.week})">EDIT</button><button class="btn inline green" onclick="setWeek(${w.week},'open')">OPEN</button><button class="btn inline red" onclick="setWeek(${w.week},'closed')">CLOSE</button></div>
      </div>`).join('')}
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
  ({ home, quiz: quizHub, live, weekly, weeklyrun, chat, shop, closet, my, credits, ending, weekedit, admin }[page] || home)();
}

loadAvatars().then(() => {
  const prof = Object.values(db.users).find(u => u.isAdmin);
  if (prof) dressProfessor(prof);
  let fixed = !!prof;
  Object.values(db.users).forEach(u => { if (!u.isAdmin && ensureDressed(u)) fixed = true; });
  if (fixed) save();
  render();
}).catch(e => {
  app.innerHTML = `<div class="phone"><div class="page center">
    <h2>아바타 데이터를 불러오지 못했습니다</h2>
    <p class="small">avatar-atlas.png / avatar-manifest.json 이 index.html과 같은 폴더에 있는지 확인해 주세요.<br>
    파일을 더블클릭해서 열지 말고 <b>python3 -m http.server 8000</b> 으로 실행해야 합니다.</p>
    <p class="small">${esc(e.message)}</p></div></div>`;
});
