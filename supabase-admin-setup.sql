-- NexaTrade admin foundation. Run in Supabase SQL Editor as project owner.
-- Admin login uses Supabase Auth email/password. No password or service-role key is stored here.
begin;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  phone text,
  account_type text not null default 'standard' check (account_type in ('standard','vip')),
  status text not null default 'active' check (status in ('active','suspended','blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_settings (
  singleton boolean primary key default true check (singleton),
  standard_win_rate numeric(5,2) not null default 50 check (standard_win_rate between 0 and 100),
  vip_win_rate numeric(5,2) not null default 65 check (vip_win_rate between 0 and 100),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_user_id uuid not null references auth.users(id),
  action text not null,
  target_user_id uuid references auth.users(id) on delete set null,
  target_email text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into public.admin_settings(singleton) values(true) on conflict(singleton) do nothing;

create or replace function public.sync_nexatrade_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id,email,full_name,phone,created_at)
  values(
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'name',new.raw_user_meta_data->>'username'),
    coalesce(new.raw_user_meta_data->>'phone',new.raw_user_meta_data->>'phone_number'),
    new.created_at
  )
  on conflict(id) do update set
    email=excluded.email,
    full_name=coalesce(excluded.full_name,public.profiles.full_name),
    phone=coalesce(excluded.phone,public.profiles.phone);
  return new;
end;
$$;
revoke all on function public.sync_nexatrade_profile() from public, anon, authenticated;
drop trigger if exists sync_nexatrade_profile_after_signup on auth.users;
create trigger sync_nexatrade_profile_after_signup
after insert or update of email,raw_user_meta_data on auth.users
for each row execute function public.sync_nexatrade_profile();

insert into public.profiles(id,email,full_name,phone,created_at)
select u.id,u.email,
  coalesce(u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name',u.raw_user_meta_data->>'username'),
  coalesce(u.raw_user_meta_data->>'phone',u.raw_user_meta_data->>'phone_number'),
  u.created_at
from auth.users u
on conflict(id) do update set email=excluded.email,
  full_name=coalesce(excluded.full_name,public.profiles.full_name),
  phone=coalesce(excluded.phone,public.profiles.phone);

-- Make this email the initial administrator, only if that Auth account exists.
insert into public.admin_users(user_id)
select id from auth.users where lower(email)=lower('Leez234ke@gmail.com')
on conflict(user_id) do nothing;

do $$
begin
  if not exists(select 1 from public.admin_users a join auth.users u on u.id=a.user_id
                where lower(u.email)=lower('Leez234ke@gmail.com')) then
    raise exception 'Create the Supabase Auth account for Leez234ke@gmail.com first, then rerun this SQL.';
  end if;
end $$;

alter table public.profiles enable row level security;
alter table public.admin_users enable row level security;
alter table public.admin_settings enable row level security;
alter table public.admin_audit_log enable row level security;

-- No direct client reads/writes to sensitive admin tables. Admin data is exposed only via checked RPCs.
revoke all on public.profiles,public.admin_users,public.admin_settings,public.admin_audit_log from public,anon,authenticated;
grant usage on schema public to authenticated;

create or replace function public.nexatrade_is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.admin_users where user_id=auth.uid())
$$;
revoke all on function public.nexatrade_is_admin() from public,anon;
grant execute on function public.nexatrade_is_admin() to authenticated;

create or replace function public.admin_list_users()
returns table(id uuid,email text,full_name text,phone text,account_type text,status text,created_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.nexatrade_is_admin() then raise exception 'Administrator access required.'; end if;
  return query select p.id,p.email,p.full_name,p.phone,p.account_type,p.status,p.created_at
  from public.profiles p order by p.created_at desc;
end;
$$;

create or replace function public.admin_update_user(p_user_id uuid,p_account_type text default null,p_status text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_email text; v_action text;
begin
  if not public.nexatrade_is_admin() then raise exception 'Administrator access required.'; end if;
  if p_user_id is null or exists(select 1 from public.admin_users where user_id=p_user_id) then
    raise exception 'Invalid target user.';
  end if;
  if p_account_type is not null and p_account_type not in ('standard','vip') then raise exception 'Invalid account category.'; end if;
  if p_status is not null and p_status not in ('active','suspended','blocked') then raise exception 'Invalid account status.'; end if;
  update public.profiles set
    account_type=coalesce(p_account_type,account_type),
    status=coalesce(p_status,status),
    updated_at=now()
  where id=p_user_id returning email into v_email;
  if v_email is null then raise exception 'User not found.'; end if;
  v_action:=case when p_account_type is not null then 'account_type_changed' else 'account_status_changed' end;
  insert into public.admin_audit_log(admin_user_id,action,target_user_id,target_email,details)
  values(auth.uid(),v_action,p_user_id,v_email,jsonb_build_object('account_type',p_account_type,'status',p_status));
  return jsonb_build_object('success',true,'email',v_email);
end;
$$;

create or replace function public.admin_get_settings()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_result jsonb;
begin
  if not public.nexatrade_is_admin() then raise exception 'Administrator access required.'; end if;
  select jsonb_build_object('standard_win_rate',standard_win_rate,'vip_win_rate',vip_win_rate)
  into v_result from public.admin_settings where singleton=true;
  return v_result;
end;
$$;

create or replace function public.admin_save_settings(p_standard_win_rate numeric,p_vip_win_rate numeric)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if not public.nexatrade_is_admin() then raise exception 'Administrator access required.'; end if;
  if p_standard_win_rate is null or p_vip_win_rate is null
     or p_standard_win_rate<0 or p_standard_win_rate>100
     or p_vip_win_rate<0 or p_vip_win_rate>100 then
    raise exception 'Win rates must be between 0 and 100.';
  end if;
  update public.admin_settings set standard_win_rate=p_standard_win_rate,
    vip_win_rate=p_vip_win_rate,updated_at=now() where singleton=true;
  insert into public.admin_audit_log(admin_user_id,action,details)
  values(auth.uid(),'simulation_win_rates_updated',
    jsonb_build_object('standard_win_rate',p_standard_win_rate,'vip_win_rate',p_vip_win_rate));
  return jsonb_build_object('success',true);
end;
$$;

create or replace function public.admin_get_activity()
returns table(action text,target_user_id uuid,target_email text,created_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.nexatrade_is_admin() then raise exception 'Administrator access required.'; end if;
  return query select l.action,l.target_user_id,l.target_email,l.created_at
  from public.admin_audit_log l order by l.created_at desc limit 100;
end;
$$;

revoke all on function public.admin_list_users() from public,anon;
revoke all on function public.admin_update_user(uuid,text,text) from public,anon;
revoke all on function public.admin_get_settings() from public,anon;
revoke all on function public.admin_save_settings(numeric,numeric) from public,anon;
revoke all on function public.admin_get_activity() from public,anon;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_update_user(uuid,text,text) to authenticated;
grant execute on function public.admin_get_settings() to authenticated;
grant execute on function public.admin_save_settings(numeric,numeric) to authenticated;
grant execute on function public.admin_get_activity() to authenticated;

commit;

-- IMPORTANT: balances, deposits, withdrawals, and trades remain simulated/test-only.
-- Account suspension enforcement in the public trading app is a separate follow-up change.