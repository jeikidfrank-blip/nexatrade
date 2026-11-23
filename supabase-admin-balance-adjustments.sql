-- NexaTrade admin balance management helpers
-- Run in Supabase SQL Editor as a privileged role.
-- Provides admin-only RPCs to inspect and adjust demo and real test balances.

create or replace function public.nexatrade_is_admin()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_jwt jsonb := coalesce(auth.jwt(), '{}'::jsonb);
begin
  if v_uid is null then
    return false;
  end if;

  if coalesce(v_jwt ->> 'role', '') = 'service_role' then
    return true;
  end if;

  if coalesce(v_jwt -> 'app_metadata' ->> 'role', '') = 'admin'
     or coalesce(v_jwt -> 'app_metadata' ->> 'is_admin', '') = 'true'
     or coalesce(v_jwt -> 'user_metadata' ->> 'is_admin', '') = 'true'
  then
    return true;
  end if;

  if to_regclass('public.admin_users') is not null then
    if exists (select 1 from public.admin_users au where au.user_id = v_uid) then
      return true;
    end if;
  end if;

  if to_regclass('public.admins') is not null then
    if exists (select 1 from public.admins a where a.user_id = v_uid) then
      return true;
    end if;
  end if;

  return false;
end;
$$;

revoke all on function public.nexatrade_is_admin() from public, anon;
grant execute on function public.nexatrade_is_admin() to authenticated;

create or replace function public.admin_get_user_balances(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_demo numeric(14,2);
  v_real numeric(14,2);
begin
  if not public.nexatrade_is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_user_id is null then
    raise exception 'User id is required.';
  end if;

  select balance into v_demo from public.demo_accounts where user_id = p_user_id;
  select balance into v_real from public.real_test_accounts where user_id = p_user_id;

  return jsonb_build_object(
    'user_id', p_user_id,
    'demo_balance', coalesce(v_demo, 0),
    'demo_account_exists', v_demo is not null,
    'real_test_balance', coalesce(v_real, 0),
    'real_test_account_exists', v_real is not null
  );
end;
$$;

revoke all on function public.admin_get_user_balances(uuid) from public, anon;
grant execute on function public.admin_get_user_balances(uuid) to authenticated;

create or replace function public.admin_adjust_demo_balance(
  p_user_id uuid,
  p_mode text,
  p_amount numeric,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text := lower(coalesce(p_mode, ''));
  v_amount numeric(14,2);
  v_current numeric(14,2);
  v_new numeric(14,2);
  v_delta numeric(14,2);
begin
  if not public.nexatrade_is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_user_id is null then
    raise exception 'User id is required.';
  end if;
  if v_mode not in ('add', 'subtract', 'set') then
    raise exception 'Mode must be add, subtract, or set.';
  end if;
  if p_amount is null or p_amount <> p_amount or p_amount in ('Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Enter a valid amount.';
  end if;
  v_amount := round(p_amount, 2);
  if v_amount < 0 then
    raise exception 'Amount must be zero or greater.';
  end if;

  insert into public.demo_accounts (user_id, balance)
  values (p_user_id, 10000.00)
  on conflict (user_id) do nothing;

  select balance into v_current
  from public.demo_accounts
  where user_id = p_user_id
  for update;

  if v_current is null then
    raise exception 'Demo account not found.';
  end if;

  if v_mode = 'add' then
    v_new := round(v_current + v_amount, 2);
  elsif v_mode = 'subtract' then
    v_new := round(v_current - v_amount, 2);
  else
    v_new := v_amount;
  end if;

  if v_new < 0 then
    raise exception 'Demo balance cannot be negative.';
  end if;

  update public.demo_accounts
  set balance = v_new
  where user_id = p_user_id;

  v_delta := round(v_new - v_current, 2);

  insert into public.demo_transactions (user_id, transaction_type, amount, balance_after, position_id)
  values (p_user_id, 'deposit', v_delta, v_new, null);

  return jsonb_build_object(
    'account', 'demo',
    'user_id', p_user_id,
    'previous_balance', v_current,
    'balance', v_new,
    'delta', v_delta,
    'mode', v_mode,
    'note', nullif(trim(coalesce(p_note, '')), '')
  );
end;
$$;

revoke all on function public.admin_adjust_demo_balance(uuid, text, numeric, text) from public, anon;
grant execute on function public.admin_adjust_demo_balance(uuid, text, numeric, text) to authenticated;

create or replace function public.admin_adjust_real_test_balance(
  p_user_id uuid,
  p_mode text,
  p_amount numeric,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text := lower(coalesce(p_mode, ''));
  v_amount numeric(14,2);
  v_current numeric(14,2);
  v_new numeric(14,2);
  v_delta numeric(14,2);
  v_tx_type text;
  v_tx_amount numeric(14,2);
begin
  if not public.nexatrade_is_admin() then
    raise exception 'Admin access required.';
  end if;
  if p_user_id is null then
    raise exception 'User id is required.';
  end if;
  if v_mode not in ('add', 'subtract', 'set') then
    raise exception 'Mode must be add, subtract, or set.';
  end if;
  if p_amount is null or p_amount <> p_amount or p_amount in ('Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Enter a valid amount.';
  end if;
  v_amount := round(p_amount, 2);
  if v_amount < 0 then
    raise exception 'Amount must be zero or greater.';
  end if;

  insert into public.real_test_accounts (user_id, balance)
  values (p_user_id, 0.00)
  on conflict (user_id) do nothing;

  select balance into v_current
  from public.real_test_accounts
  where user_id = p_user_id
  for update;

  if v_current is null then
    raise exception 'Real test account not found.';
  end if;

  if v_mode = 'add' then
    v_new := round(v_current + v_amount, 2);
  elsif v_mode = 'subtract' then
    v_new := round(v_current - v_amount, 2);
  else
    v_new := v_amount;
  end if;

  if v_new < 0 then
    raise exception 'Real test balance cannot be negative.';
  end if;

  update public.real_test_accounts
  set balance = v_new
  where user_id = p_user_id;

  v_delta := round(v_new - v_current, 2);

  if v_delta > 0 then
    v_tx_type := 'deposit';
    v_tx_amount := v_delta;
  elsif v_delta < 0 then
    v_tx_type := 'withdrawal';
    v_tx_amount := abs(v_delta);
  else
    v_tx_type := null;
    v_tx_amount := null;
  end if;

  if v_tx_type is not null then
    insert into public.real_test_transactions (user_id, transaction_type, amount, balance_after)
    values (p_user_id, v_tx_type, v_tx_amount, v_new);
  end if;

  return jsonb_build_object(
    'account', 'real_test',
    'user_id', p_user_id,
    'previous_balance', v_current,
    'balance', v_new,
    'delta', v_delta,
    'mode', v_mode,
    'note', nullif(trim(coalesce(p_note, '')), '')
  );
end;
$$;

revoke all on function public.admin_adjust_real_test_balance(uuid, text, numeric, text) from public, anon;
grant execute on function public.admin_adjust_real_test_balance(uuid, text, numeric, text) to authenticated;
