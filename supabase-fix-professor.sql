-- ============================================================
-- 교수 계정 확인 및 복구
-- SQL Editor 에서 필요한 부분만 골라 실행하세요.
-- ============================================================

-- 1) 지금 등록된 계정과 관리자 여부 보기
select nick, is_admin, potions, xp, created_at
from users
order by created_at;

-- 2) 관리자가 한 명도 없다면, Professor 계정에 권한을 부여합니다.
--    (앱에서 이미 계정을 만든 뒤 실행하세요)
update users set is_admin = true where nick = 'Professor';

-- 3) 처음부터 다시 만들고 싶다면 계정을 지웁니다.
--    세션·응답·주차결과가 함께 지워집니다. 채팅 기록은 남습니다.
-- delete from users where nick = 'Professor';

-- 4) 확인
select nick, is_admin from users where is_admin;
