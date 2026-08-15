-- ============================================================
-- 수정: gen_salt / crypt 를 찾지 못하는 문제
--
-- Supabase 는 pgcrypto 를 public 이 아니라 extensions 스키마에
-- 미리 설치해 둡니다. 함수의 search_path 에 extensions 를 추가하면
-- 해결됩니다. SQL Editor 에 붙여넣고 Run 하세요.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create or replace function register(p_nick text, p_pin text, p_profile jsonb)
returns uuid language plpgsql security definer
set search_path = public, extensions as $$
declare v_token uuid; v_admin boolean;
begin
  if p_nick !~ '^[A-Za-z0-9가-힣]{1,16}$' then raise exception '닉네임 형식이 올바르지 않습니다.'; end if;
  if p_pin  !~ '^[0-9]{4}$'               then raise exception 'PIN 은 숫자 4자리여야 합니다.'; end if;
  if exists (select 1 from users where nick = p_nick) then raise exception '이미 사용 중인 닉네임입니다.'; end if;

  -- 교수 계정은 아직 관리자가 한 명도 없을 때만 만들어집니다.
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

grant execute on function register, login to anon, authenticated;

-- 확인용: 아래를 실행하면 해시가 만들어지는지 바로 볼 수 있습니다.
-- select length(crypt('1234', gen_salt('bf'))) as hash_length;
