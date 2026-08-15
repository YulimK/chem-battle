-- ============================================================
-- Chem Battle — 보안 강화 스키마 (v2)
--
-- 설계 원칙: 클라이언트는 테이블에 직접 쓰지 못합니다.
-- 모든 쓰기는 아래 함수(RPC)를 거치고, 함수가 신원과 값을
-- 검증합니다. 포션·경험치는 서버가 계산하므로 조작할 수 없고,
-- 정답은 퀴즈가 끝나기 전까지 클라이언트로 나가지 않습니다.
--
-- SQL Editor 에 이 파일 전체를 붙여넣고 Run 하세요.
-- 그다음 supabase-prices.sql 도 실행해야 상점이 동작합니다.
-- ============================================================

-- Supabase 는 확장을 extensions 스키마에 둡니다. 아래 함수들의
-- search_path 에 extensions 를 포함시켜야 crypt/gen_salt 를 찾습니다.
create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------
-- 테이블
-- ------------------------------------------------------------

create table if not exists users (
  nick        text primary key,
  pin_hash    text not null,              -- 평문 PIN 은 저장하지 않습니다
  is_admin    boolean not null default false,
  potions     int not null default 200,
  xp          int not null default 0,
  last_login  date,
  profile     jsonb not null default '{}'::jsonb,   -- 외형·보유목록 (꾸미기 전용)
  created_at  timestamptz not null default now()
);

create table if not exists sessions (
  token       uuid primary key default gen_random_uuid(),
  nick        text not null references users(nick) on delete cascade,
  expires_at  timestamptz not null default now() + interval '14 hours'
);
create index if not exists sessions_nick_idx on sessions (nick);

-- 라이브 퀴즈. correct 컬럼은 클라이언트에 직접 노출되지 않습니다.
create table if not exists live_quiz (
  id            int primary key,
  ord           int not null default 0,
  title         text not null default '',
  question      text not null default '',
  options       jsonb not null default '[]'::jsonb,
  correct       int  not null default 0,
  part_reward   int  not null default 10,
  correct_reward int not null default 10,
  status        text not null default 'ready'      -- ready | active | ended
);

create table if not exists responses (
  quiz_id     int not null references live_quiz(id) on delete cascade,
  nick        text not null references users(nick) on delete cascade,
  choice      int not null,
  rewarded    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (quiz_id, nick)
);

-- 주차별 퀴즈. 정답과 해설은 채점 후에만 전달됩니다.
create table if not exists weekly (
  week            int primary key,
  title           text not null default '',
  status          text not null default 'locked',  -- locked | open | closed
  completion_reward int not null default 20,
  correct_reward  int not null default 5,
  questions       jsonb not null default '[]'::jsonb  -- [{q, o[], a, explanation}]
);

create table if not exists weekly_results (
  nick     text not null references users(nick) on delete cascade,
  week     int  not null references weekly(week) on delete cascade,
  correct  int  not null,
  reward   int  not null,
  answers  jsonb not null default '{}'::jsonb,
  review   jsonb not null default '[]'::jsonb,      -- 채점 후 공개되는 정답·해설
  primary key (nick, week)
);

create table if not exists messages (
  id     bigserial primary key,
  name   text not null,
  admin  boolean not null default false,
  text   text not null,
  ts     bigint not null
);
create index if not exists messages_id_idx on messages (id desc);

create table if not exists room (
  id   int primary key,
  data jsonb not null default '{}'::jsonb          -- semesterComplete 등 자잘한 설정
);
insert into room (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 읽기 전용 뷰
-- 정답 컬럼을 제외하고, 종료된 퀴즈에서만 정답을 채워 보냅니다.
-- ------------------------------------------------------------
create or replace view live_quiz_public as
select id, ord, title, question, options, part_reward, correct_reward, status,
       case when status = 'ended' then correct else null end as correct
from live_quiz;

-- 주차 목록에는 문제 수만 노출합니다. 문제 본문은 RPC 로 받습니다.
create or replace view weekly_public as
select week, title, status, completion_reward, correct_reward,
       jsonb_array_length(questions) as question_count
from weekly;

-- ------------------------------------------------------------
-- 접근 정책: 읽기만 허용, 쓰기는 전부 함수 경유
-- ------------------------------------------------------------
alter table users          enable row level security;
alter table sessions       enable row level security;
alter table live_quiz      enable row level security;
alter table responses      enable row level security;
alter table weekly         enable row level security;
alter table weekly_results enable row level security;
alter table messages       enable row level security;
alter table room           enable row level security;

do $$
declare t text;
begin
  foreach t in array array['users','sessions','live_quiz','responses','weekly',
                           'weekly_results','messages','room']
  loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('drop policy if exists %I_write on %I', t, t);
  end loop;
end $$;

-- 순위표에 필요한 최소 정보만 읽기 허용 (PIN 해시는 컬럼 권한으로 차단)
create policy users_read     on users     for select using (true);
revoke select on users from anon, authenticated;
grant  select (nick, is_admin, potions, xp, profile) on users to anon, authenticated;

create policy resp_read      on responses      for select using (true);
create policy wres_read      on weekly_results for select using (true);
create policy msg_read       on messages       for select using (true);
create policy room_read      on room           for select using (true);

-- 원본 퀴즈 테이블은 아예 못 읽습니다. 뷰만 열어 둡니다.
revoke all on live_quiz, weekly, sessions from anon, authenticated;
grant select on live_quiz_public, weekly_public to anon, authenticated;

-- ------------------------------------------------------------
-- 내부 헬퍼
-- ------------------------------------------------------------
create or replace function _who(p_token uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_nick text;
begin
  delete from sessions where expires_at < now();
  select nick into v_nick from sessions where token = p_token and expires_at > now();
  if v_nick is null then raise exception '로그인이 만료되었습니다. 다시 로그인해 주세요.'; end if;
  return v_nick;
end $$;

create or replace function _admin(p_token uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_nick text;
begin
  v_nick := _who(p_token);
  if not exists (select 1 from users where nick = v_nick and is_admin) then
    raise exception '권한이 없습니다.';
  end if;
  return v_nick;
end $$;

-- ------------------------------------------------------------
-- 계정
-- ------------------------------------------------------------
create or replace function register(p_nick text, p_pin text, p_profile jsonb)
returns uuid language plpgsql security definer
set search_path = public, extensions as $$
declare v_token uuid; v_admin boolean;
begin
  if p_nick !~ '^[A-Za-z0-9가-힣]{1,16}$' then raise exception '닉네임 형식이 올바르지 않습니다.'; end if;
  if p_pin  !~ '^[0-9]{4}$'               then raise exception 'PIN 은 숫자 4자리여야 합니다.'; end if;
  if exists (select 1 from users where nick = p_nick) then raise exception '이미 사용 중인 닉네임입니다.'; end if;

  -- 교수 계정은 최초 1회만, 아직 아무도 없을 때만 만들어집니다.
  v_admin := (p_nick = 'Professor') and not exists (select 1 from users where is_admin);

  insert into users (nick, pin_hash, is_admin, profile)
  values (p_nick, crypt(p_pin, gen_salt('bf')), v_admin, coalesce(p_profile, '{}'::jsonb));

  insert into sessions (nick) values (p_nick) returning token into v_token;
  return v_token;
end $$;

create or replace function login(p_nick text, p_pin text)
returns uuid language plpgsql security definer
set search_path = public, extensions as $$
declare v_token uuid; v_ok boolean;
begin
  select (pin_hash = crypt(p_pin, pin_hash)) into v_ok from users where nick = p_nick;
  if v_ok is not true then
    perform pg_sleep(0.4);                         -- 무차별 대입 지연
    raise exception '닉네임 또는 PIN이 맞지 않습니다.';
  end if;
  delete from sessions where nick = p_nick;        -- 기기당 한 세션
  insert into sessions (nick) values (p_nick) returning token into v_token;

  -- 출석 보상: 하루 한 번, 서버가 판단합니다.
  update users set potions = potions + 10, xp = xp + 10, last_login = current_date
   where nick = p_nick and (last_login is null or last_login < current_date);
  return v_token;
end $$;

create or replace function me(p_token uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_nick text;
begin
  v_nick := _who(p_token);
  return (select row_to_json(x) from (
    select u.nick, u.is_admin, u.potions, u.xp, u.last_login, u.profile,
           (select coalesce(json_agg(json_build_object(
                     'week', w.week, 'correct', w.correct,
                     'reward', w.reward, 'answers', w.answers, 'review', w.review)), '[]'::json)
              from weekly_results w where w.nick = u.nick) as weekly,
           (select coalesce(json_agg(json_build_object(
                     'quiz_id', r.quiz_id, 'choice', r.choice, 'rewarded', r.rewarded)), '[]'::json)
              from responses r where r.nick = u.nick) as answers
      from users u where u.nick = v_nick) x);
end $$;

-- 외형 저장. 보유 목록과 착용만 받고 포션·경험치는 무시합니다.
create or replace function save_look(p_token uuid, p_profile jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_nick text;
begin
  v_nick := _who(p_token);
  update users set profile = jsonb_build_object(
      'body',      coalesce(p_profile->'body', profile->'body'),
      'equipped',  coalesce(p_profile->'equipped', profile->'equipped'),
      'inventory', coalesce(profile->'inventory', '[]'::jsonb)   -- 구매로만 늘어납니다
    ) where nick = v_nick;
end $$;

-- ------------------------------------------------------------
-- 상점: 가격을 서버가 계산합니다
-- ------------------------------------------------------------
create or replace function buy_items(p_token uuid, p_items text[])
returns json language plpgsql security definer set search_path = public as $$
declare v_nick text; v_inv jsonb; v_cost int; v_pot int; v_new jsonb;
begin
  v_nick := _who(p_token);
  select coalesce(profile->'inventory', '[]'::jsonb), potions into v_inv, v_pot
    from users where nick = v_nick;

  -- 이미 가진 것은 0원, 목록에 없는 아이디는 거절
  select coalesce(sum(s.cost), 0) into v_cost
    from unnest(p_items) i
    join shop_prices s on s.item_id = i
   where not (v_inv ? i);

  if (select count(*) from unnest(p_items) i where not exists
        (select 1 from shop_prices s where s.item_id = i)) > 0 then
    raise exception '존재하지 않는 아이템입니다.';
  end if;
  if v_cost > v_pot then raise exception '포션이 부족합니다.'; end if;

  v_new := v_inv;
  select v_new || coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) into v_new
    from unnest(p_items) i where not (v_inv ? i);

  update users
     set potions = potions - v_cost,
         profile = jsonb_set(profile, '{inventory}', v_new)
   where nick = v_nick;

  return json_build_object('spent', v_cost, 'potions', v_pot - v_cost);
end $$;

-- ------------------------------------------------------------
-- 라이브 퀴즈
-- ------------------------------------------------------------
create or replace function submit_answer(p_token uuid, p_quiz int, p_choice int)
returns void language plpgsql security definer set search_path = public as $$
declare v_nick text; v_status text; v_n int;
begin
  v_nick := _who(p_token);
  select status, jsonb_array_length(options) into v_status, v_n from live_quiz where id = p_quiz;
  if v_status is null      then raise exception '없는 퀴즈입니다.'; end if;
  if v_status <> 'active'  then raise exception '지금은 답을 제출할 수 없습니다.'; end if;
  if p_choice < 0 or p_choice >= v_n then raise exception '선택지가 올바르지 않습니다.'; end if;

  insert into responses (quiz_id, nick, choice) values (p_quiz, v_nick, p_choice)
    on conflict (quiz_id, nick) do nothing;      -- 한 번만 제출 가능
end $$;

-- 보상은 서버가 계산하고 한 번만 지급합니다.
create or replace function claim_live(p_token uuid, p_quiz int)
returns json language plpgsql security definer set search_path = public as $$
declare v_nick text; v_q live_quiz%rowtype; v_choice int; v_done boolean; v_gain int;
begin
  v_nick := _who(p_token);
  select * into v_q from live_quiz where id = p_quiz;
  if v_q.status <> 'ended' then raise exception '아직 종료되지 않았습니다.'; end if;

  select choice, rewarded into v_choice, v_done from responses
   where quiz_id = p_quiz and nick = v_nick;
  if v_choice is null then return json_build_object('gain', 0, 'already', true); end if;
  if v_done then return json_build_object('gain', 0, 'already', true); end if;

  v_gain := v_q.part_reward + case when v_choice = v_q.correct then v_q.correct_reward else 0 end;
  update responses set rewarded = true where quiz_id = p_quiz and nick = v_nick;
  update users set potions = potions + v_gain, xp = xp + v_gain where nick = v_nick;
  return json_build_object('gain', v_gain, 'already', false);
end $$;

-- ------------------------------------------------------------
-- 주차별 퀴즈: 문제는 정답 없이, 채점은 서버가
-- ------------------------------------------------------------
create or replace function get_weekly(p_token uuid, p_week int)
returns json language plpgsql security definer set search_path = public as $$
declare v_nick text; v_w weekly%rowtype; v_res weekly_results%rowtype;
begin
  v_nick := _who(p_token);
  select * into v_w from weekly where week = p_week;
  if v_w.week is null then raise exception '없는 주차입니다.'; end if;

  select * into v_res from weekly_results where nick = v_nick and week = p_week;
  if v_res.week is not null then
    -- 이미 푼 주차는 정답과 해설을 함께 돌려줍니다.
    return json_build_object('week', v_w.week, 'title', v_w.title, 'done', true,
                             'correct', v_res.correct, 'reward', v_res.reward,
                             'answers', v_res.answers, 'review', v_res.review);
  end if;

  if v_w.status <> 'open' then raise exception '아직 열리지 않은 주차입니다.'; end if;
  return json_build_object('week', v_w.week, 'title', v_w.title, 'done', false,
    'questions', (select coalesce(jsonb_agg(jsonb_build_object('q', e->>'q', 'o', e->'o')), '[]'::jsonb)
                    from jsonb_array_elements(v_w.questions) e));
end $$;

create or replace function submit_weekly(p_token uuid, p_week int, p_answers jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare v_nick text; v_w weekly%rowtype; v_correct int := 0; v_reward int;
        v_review jsonb := '[]'::jsonb; e jsonb; i int := 0; v_pick int;
begin
  v_nick := _who(p_token);
  select * into v_w from weekly where week = p_week;
  if v_w.week is null or v_w.status <> 'open' then raise exception '지금은 제출할 수 없습니다.'; end if;
  if exists (select 1 from weekly_results where nick = v_nick and week = p_week) then
    raise exception '이미 제출한 주차입니다.';
  end if;

  for e in select * from jsonb_array_elements(v_w.questions) loop
    v_pick := nullif(p_answers ->> i::text, '')::int;
    if v_pick is not null and v_pick = (e->>'a')::int then v_correct := v_correct + 1; end if;
    v_review := v_review || jsonb_build_object(
      'a', (e->>'a')::int, 'explanation', coalesce(e->>'explanation',''));
    i := i + 1;
  end loop;

  v_reward := v_w.completion_reward + v_correct * v_w.correct_reward;
  insert into weekly_results (nick, week, correct, reward, answers, review)
  values (v_nick, p_week, v_correct, v_reward, p_answers, v_review);
  update users set potions = potions + v_reward, xp = xp + v_reward where nick = v_nick;

  return json_build_object('correct', v_correct, 'reward', v_reward, 'review', v_review);
end $$;

-- ------------------------------------------------------------
-- 채팅: 이름은 토큰에서 꺼내므로 사칭할 수 없습니다
-- ------------------------------------------------------------
create or replace function send_message(p_token uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare v_nick text; v_admin boolean; v_recent int;
begin
  v_nick := _who(p_token);
  if length(btrim(p_text)) = 0 then return; end if;
  if length(p_text) > 300 then raise exception '메시지가 너무 깁니다.'; end if;

  select count(*) into v_recent from messages
   where name = v_nick and ts > (extract(epoch from now()) * 1000 - 10000);
  if v_recent >= 5 then raise exception '잠시 후 다시 보내주세요.'; end if;

  select is_admin into v_admin from users where nick = v_nick;
  insert into messages (name, admin, text, ts)
  values (v_nick, v_admin, btrim(p_text), (extract(epoch from now()) * 1000)::bigint);
end $$;

-- ------------------------------------------------------------
-- 교수 전용
-- ------------------------------------------------------------
create or replace function admin_save_quiz(p_token uuid, p_quiz jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  insert into live_quiz (id, ord, title, question, options, correct, part_reward, correct_reward)
  values ((p_quiz->>'id')::int, coalesce((p_quiz->>'ord')::int, 0),
          coalesce(p_quiz->>'title',''), coalesce(p_quiz->>'question',''),
          coalesce(p_quiz->'options','[]'::jsonb), coalesce((p_quiz->>'correct')::int, 0),
          coalesce((p_quiz->>'part_reward')::int, 10),
          coalesce((p_quiz->>'correct_reward')::int, 10))
  on conflict (id) do update set
    title = excluded.title, question = excluded.question, options = excluded.options,
    correct = excluded.correct, part_reward = excluded.part_reward,
    correct_reward = excluded.correct_reward, ord = excluded.ord;
end $$;

create or replace function admin_set_status(p_token uuid, p_quiz int, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  if p_status not in ('ready','active','ended') then raise exception '상태값 오류'; end if;
  if p_status = 'active' then
    update live_quiz set status = 'ready' where status = 'active';
    delete from responses where quiz_id = p_quiz;      -- 새 라운드
  end if;
  update live_quiz set status = p_status where id = p_quiz;
end $$;

create or replace function admin_save_weekly(p_token uuid, p_week jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  insert into weekly (week, title, status, completion_reward, correct_reward, questions)
  values ((p_week->>'week')::int, coalesce(p_week->>'title',''),
          coalesce(p_week->>'status','locked'),
          coalesce((p_week->>'completion_reward')::int, 20),
          coalesce((p_week->>'correct_reward')::int, 5),
          coalesce(p_week->'questions','[]'::jsonb))
  on conflict (week) do update set
    title = excluded.title, status = excluded.status,
    completion_reward = excluded.completion_reward,
    correct_reward = excluded.correct_reward, questions = excluded.questions;
end $$;

create or replace function admin_set_room(p_token uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _admin(p_token);
  update room set data = p_data where id = 1;
end $$;

-- 함수 실행 권한만 부여합니다.
grant execute on function register, login, me, save_look, buy_items, submit_answer,
  claim_live, get_weekly, submit_weekly, send_message,
  admin_save_quiz, admin_set_status, admin_save_weekly, admin_set_room
  to anon, authenticated;
revoke execute on function _who(uuid), _admin(uuid) from anon, authenticated;

-- ------------------------------------------------------------
-- 실시간 전송
-- ------------------------------------------------------------
do $$
begin
  begin execute 'alter publication supabase_realtime add table live_quiz'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table responses'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table messages';  exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table weekly';    exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table room';      exception when duplicate_object then null; end;
end $$;

-- 15주 슬롯 초기화
insert into weekly (week, title, status)
select g, 'Week ' || g, case when g = 1 then 'open' else 'locked' end
from generate_series(1, 15) g
on conflict (week) do nothing;
