-- NexaTrade admin dashboard integration
-- Run this in the Supabase SQL editor with a privileged role.
-- Safe to re-run where possible (CREATE OR REPLACE / IF NOT EXISTS).

create or replace function public.nexatrade_is_admin()
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_jwt jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_role text := lower(coalesce(v_jwt ->> 'role', v_jwt -> 'app_metadata' ->> 'role', v_jwt -> 'user_metadata' ->> 'role', ''));
  v_app_meta jsonb := coalesce(v_jwt -> 'app_metadata', '{}'::jsonb);
  v_user_meta jsonb := coalesce(v_jwt -> 'user_metadata', '{}'::jsonb);
  v_is_admin boolean := false;
  v_has_table boolean := false;
begin
  if v_uid is null then
    return false;
  end if;

  if v_role in ('service_role', 'supabase_admin') then
    return true;
  end if;

  if v_app_meta ->> 'is_admin' = 'true'
     or v_user_meta ->> 'is_admin' = 'true'
     or coalesce((v_app_meta ->> 'is_admin')::boolean, false)
     or coalesce((v_user_meta ->> 'is_admin')::boolean, false)
     or lower(coalesce(v_app_meta ->> 'admin', '')) = 'true'
     or lower(coalesce(v_user_meta ->> 'admin', '')) = 'true' then
    return true;
  end if;

  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'admin_users'
  ) into v_has_table;
  if v_has_table then
    begin
      execute 'select exists(select 1 from public.admin_users au where au.user_id = $1)' into v_is_admin using v_uid;
      if v_is_admin then return true; end if;
    exception when undefined_column then
      begin
        execute 'select exists(select 1 from public.admin_users au where au.id = $1)' into v_is_admin using v_uid;
        if v_is_admin then return true; end if;
      exception when others then null;
      end;
    when others then null;
    end;
  end if;

  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'admins'
  ) into v_has_table;
  if v_has_table then
    begin
      execute 'select exists(select 1 from public.admins a where a.user_id = $1)' into v_is_admin using v_uid;
      if v_is_admin then return true; end if;
    exception when undefined_column then
      begin
        execute 'select exists(select 1 from public.admins a where a.id = $1)' into v_is_admin using v_uid;
        if v_is_admin then return true; end if;
      exception when others then null;
      end;
    when others then null;
    end;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name in ('role', 'is_admin', 'account_role')
  ) into v_has_table;
  if v_has_table then
    begin
      execute $q$
        select exists(
          select 1 from public.profiles p
          where p.id = $1
            and (
              coalesce(lower(p.role::text), '') = 'admin'
              or coalesce(lower(p.account_role::text), '') = 'admin'
              or coalesce(p.is_admin::text, '') = 'true'
            )
        )
      $q$ into v_is_admin using v_uid;
      if v_is_admin then return true; end if;
    exception when others then
      begin
        execute $q$
          select exists(
            select 1 from public.profiles p
            where p.id = $1 and coalesce(lower(p.role::text), '') = 'admin'
          )
        $q$ into v_is_admin using v_uid;
        if v_is_admin then return true; end if;
      exception when others then null;
      end;
    end;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profiles'
      and column_name in ('role', 'is_admin', 'account_role', 'user_id')
  ) into v_has_table;
  if v_has_table then
    begin
      execute $q$
        select exists(
          select 1 from public.user_profiles p
          where p.user_id = $1
            and (
              coalesce(lower(p.role::text), '') = 'admin'
              or coalesce(lower(p.account_role::text), '') = 'admin'
              or coalesce(p.is_admin::text, '') = 'true'
            )
        )
      $q$ into v_is_admin using v_uid;
      if v_is_admin then return true; end if;
    exception when others then null;
    end;
  end if;

  return false;
end;
$$;

-- ----------------------------------------------------------------------------
-- Balance management
-- ----------------------------------------------------------------------------
create or replace function public.admin_get_user_balances(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_demo_balance numeric(14,2);
  v_real_test_balance numeric(14,2);
  v_demo_exists boolean := false;
  v_real_test_exists boolean := false;
begin
  if p_user_id is null then raise exception 'User id is required.'; end if;
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;

  if to_regclass('public.demo_accounts') is not null then
    select balance into v_demo_balance from public.demo_accounts where user_id = p_user_id;
    v_demo_exists := found;
  end if;
  if to_regclass('public.real_test_accounts') is not null then
    select balance into v_real_test_balance from public.real_test_accounts where user_id = p_user_id;
    v_real_test_exists := found;
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'demo_account_exists', v_demo_exists,
    'demo_balance', coalesce(v_demo_balance, 0),
    'real_test_account_exists', v_real_test_exists,
    'real_test_balance', coalesce(v_real_test_balance, 0)
  );
end;
$$;

create or replace function public.admin_adjust_demo_balance(
  p_user_id uuid,
  p_mode text,
  p_amount numeric,
  p_note text default 'Adjusted by admin'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text := lower(coalesce(p_mode, ''));
  v_current numeric(14,2);
  v_next numeric(14,2);
  v_delta numeric(14,2);
  v_amount numeric(14,2);
begin
  if p_user_id is null then raise exception 'User id is required.'; end if;
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if p_amount is null or p_amount <> p_amount or p_amount < 0 then raise exception 'Enter a valid non-negative amount.'; end if;
  if v_mode not in ('add', 'subtract', 'set') then raise exception 'Mode must be add, subtract, or set.'; end if;
  if to_regclass('public.demo_accounts') is null then raise exception 'Demo accounts table is not available.'; end if;

  v_amount := round(p_amount, 2);
  insert into public.demo_accounts (user_id, balance) values (p_user_id, 0.00) on conflict (user_id) do nothing;
  select balance into v_current from public.demo_accounts where user_id = p_user_id for update;
  if v_current is null then raise exception 'Demo account not found.'; end if;

  if v_mode = 'add' then v_next := v_current + v_amount;
  elsif v_mode = 'subtract' then v_next := v_current - v_amount;
  else v_next := v_amount; end if;

  if v_next < 0 then raise exception 'Demo balance cannot be negative.'; end if;
  v_delta := round(v_next - v_current, 2);

  update public.demo_accounts set balance = v_next where user_id = p_user_id;
  if v_delta <> 0 and to_regclass('public.demo_transactions') is not null then
    insert into public.demo_transactions (user_id, transaction_type, amount, balance_after)
    values (p_user_id, 'deposit', v_delta, v_next);
  end if;

  return jsonb_build_object('user_id', p_user_id, 'account_type', 'demo', 'mode', v_mode, 'previous_balance', v_current, 'balance', v_next, 'delta', v_delta, 'note', coalesce(p_note, 'Adjusted by admin'));
end;
$$;

create or replace function public.admin_adjust_real_test_balance(
  p_user_id uuid,
  p_mode text,
  p_amount numeric,
  p_note text default 'Adjusted by admin'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text := lower(coalesce(p_mode, ''));
  v_current numeric(14,2);
  v_next numeric(14,2);
  v_delta numeric(14,2);
  v_amount numeric(14,2);
begin
  if p_user_id is null then raise exception 'User id is required.'; end if;
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if p_amount is null or p_amount <> p_amount or p_amount < 0 then raise exception 'Enter a valid non-negative amount.'; end if;
  if v_mode not in ('add', 'subtract', 'set') then raise exception 'Mode must be add, subtract, or set.'; end if;
  if to_regclass('public.real_test_accounts') is null then raise exception 'Real test accounts table is not available.'; end if;

  v_amount := round(p_amount, 2);
  insert into public.real_test_accounts (user_id, balance) values (p_user_id, 0.00) on conflict (user_id) do nothing;
  select balance into v_current from public.real_test_accounts where user_id = p_user_id for update;
  if v_current is null then raise exception 'Real test account not found.'; end if;

  if v_mode = 'add' then v_next := v_current + v_amount;
  elsif v_mode = 'subtract' then v_next := v_current - v_amount;
  else v_next := v_amount; end if;

  if v_next < 0 then raise exception 'Real test balance cannot be negative.'; end if;
  v_delta := round(v_next - v_current, 2);

  update public.real_test_accounts set balance = v_next where user_id = p_user_id;
  if to_regclass('public.real_test_transactions') is not null then
    if v_delta > 0 then
      insert into public.real_test_transactions (user_id, transaction_type, amount, balance_after)
      values (p_user_id, 'deposit', v_delta, v_next);
    elsif v_delta < 0 then
      insert into public.real_test_transactions (user_id, transaction_type, amount, balance_after)
      values (p_user_id, 'withdrawal', abs(v_delta), v_next);
    end if;
  end if;

  return jsonb_build_object('user_id', p_user_id, 'account_type', 'real_test', 'mode', v_mode, 'previous_balance', v_current, 'balance', v_next, 'delta', v_delta, 'note', coalesce(p_note, 'Adjusted by admin'));
end;
$$;

-- ----------------------------------------------------------------------------
-- Dashboard overview and data visibility
-- ----------------------------------------------------------------------------
create or replace function public.admin_get_dashboard_overview()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_demo_open int := 0;
  v_real_open int := 0;
  v_demo_balance numeric := 0;
  v_real_balance numeric := 0;
  v_mp_total numeric := 0;
  v_mp_today numeric := 0;
  v_mp_pending int := 0;
  v_mp_pending_total numeric := 0;
  v_mp_completed int := 0;
begin
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;

  if to_regclass('public.demo_positions') is not null then
    execute 'select count(*) from public.demo_positions where status = ''open''' into v_demo_open;
  end if;
  if to_regclass('public.real_test_positions') is not null then
    execute 'select count(*) from public.real_test_positions where status = ''open''' into v_real_open;
  end if;
  if to_regclass('public.demo_accounts') is not null then
    execute 'select coalesce(sum(balance),0) from public.demo_accounts' into v_demo_balance;
  end if;
  if to_regclass('public.real_test_accounts') is not null then
    execute 'select coalesce(sum(balance),0) from public.real_test_accounts' into v_real_balance;
  end if;
  if to_regclass('public.megapay_deposits') is not null then
    execute 'select coalesce(sum(amount),0) from public.megapay_deposits where status = ''completed''' into v_mp_total;
    execute 'select coalesce(sum(amount),0) from public.megapay_deposits where status = ''completed'' and credited_at >= date_trunc(''day'', now())' into v_mp_today;
    execute 'select count(*) from public.megapay_deposits where status = ''pending''' into v_mp_pending;
    execute 'select coalesce(sum(amount),0) from public.megapay_deposits where status = ''pending''' into v_mp_pending_total;
    execute 'select count(*) from public.megapay_deposits where status = ''completed''' into v_mp_completed;
  end if;

  return jsonb_build_object(
    'demo_open_positions', v_demo_open,
    'real_test_open_positions', v_real_open,
    'demo_total_balance', v_demo_balance,
    'real_test_total_balance', v_real_balance,
    'megapay_total_confirmed', v_mp_total,
    'megapay_today_confirmed', v_mp_today,
    'megapay_pending_count', v_mp_pending,
    'megapay_pending_total', v_mp_pending_total,
    'megapay_completed_count', v_mp_completed
  );
end;
$$;

create or replace function public.admin_get_deposit_records()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_records jsonb := '[]'::jsonb;
  v_total_confirmed numeric := 0;
  v_today_confirmed numeric := 0;
  v_pending_count int := 0;
  v_pending_total numeric := 0;
begin
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if to_regclass('public.megapay_deposits') is null then
    return jsonb_build_object('records', '[]'::jsonb, 'total_confirmed', 0, 'today_confirmed', 0, 'pending_count', 0, 'pending_total', 0);
  end if;

  select coalesce(sum(amount),0) into v_total_confirmed from public.megapay_deposits where status = 'completed';
  select coalesce(sum(amount),0) into v_today_confirmed from public.megapay_deposits where status = 'completed' and credited_at >= date_trunc('day', now());
  select count(*), coalesce(sum(amount),0) into v_pending_count, v_pending_total from public.megapay_deposits where status = 'pending';

  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_time desc nulls last), '[]'::jsonb)
  into v_records
  from (
    select
      d.id,
      d.user_id,
      coalesce(u.email::text, d.email, '') as email,
      d.msisdn as phone,
      d.amount,
      d.reference,
      d.transaction_request_id,
      d.status,
      d.provider_status,
      d.credited_transaction_id,
      d.credited_at,
      d.created_at,
      d.updated_at,
      coalesce(d.credited_at, d.updated_at, d.created_at) as sort_time
    from public.megapay_deposits d
    left join auth.users u on u.id = d.user_id
  ) x;

  return jsonb_build_object(
    'records', v_records,
    'total_confirmed', v_total_confirmed,
    'today_confirmed', v_today_confirmed,
    'pending_count', v_pending_count,
    'pending_total', v_pending_total
  );
end;
$$;

create or replace function public.admin_list_megapay_deposits(p_status text default null, p_limit integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_status text := nullif(lower(trim(coalesce(p_status,''))), '');
  v_limit int := greatest(1, least(coalesce(p_limit, 300), 1000));
  v_rows jsonb := '[]'::jsonb;
begin
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if to_regclass('public.megapay_deposits') is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select d.*, coalesce(u.email::text, d.email) as user_email
    from public.megapay_deposits d
    left join auth.users u on u.id = d.user_id
    where v_status is null or lower(d.status) = v_status
    order by d.created_at desc
    limit v_limit
  ) x;
  return v_rows;
end;
$$;

create or replace function public.admin_list_demo_positions(p_user_id uuid default null, p_status text default null, p_limit integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_status text := nullif(lower(trim(coalesce(p_status,''))), '');
  v_limit int := greatest(1, least(coalesce(p_limit, 300), 1000));
  v_rows jsonb := '[]'::jsonb;
begin
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if to_regclass('public.demo_positions') is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select p.*, u.email::text as user_email
    from public.demo_positions p
    left join auth.users u on u.id = p.user_id
    where (p_user_id is null or p.user_id = p_user_id)
      and (v_status is null or lower(p.status) = v_status)
    order by p.created_at desc
    limit v_limit
  ) x;
  return v_rows;
end;
$$;

create or replace function public.admin_list_real_test_positions(p_user_id uuid default null, p_status text default null, p_limit integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_status text := nullif(lower(trim(coalesce(p_status,''))), '');
  v_limit int := greatest(1, least(coalesce(p_limit, 300), 1000));
  v_rows jsonb := '[]'::jsonb;
begin
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if to_regclass('public.real_test_positions') is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select p.*, u.email::text as user_email
    from public.real_test_positions p
    left join auth.users u on u.id = p.user_id
    where (p_user_id is null or p.user_id = p_user_id)
      and (v_status is null or lower(p.status) = v_status)
    order by p.created_at desc
    limit v_limit
  ) x;
  return v_rows;
end;
$$;

create or replace function public.admin_list_demo_transactions(p_user_id uuid default null, p_limit integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 300), 1000));
  v_rows jsonb := '[]'::jsonb;
begin
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if to_regclass('public.demo_transactions') is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select t.*, u.email::text as user_email
    from public.demo_transactions t
    left join auth.users u on u.id = t.user_id
    where (p_user_id is null or t.user_id = p_user_id)
    order by t.created_at desc
    limit v_limit
  ) x;
  return v_rows;
end;
$$;

create or replace function public.admin_list_real_test_transactions(p_user_id uuid default null, p_limit integer default 300)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 300), 1000));
  v_rows jsonb := '[]'::jsonb;
begin
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if to_regclass('public.real_test_transactions') is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select t.*, u.email::text as user_email
    from public.real_test_transactions t
    left join auth.users u on u.id = t.user_id
    where (p_user_id is null or t.user_id = p_user_id)
    order by t.created_at desc
    limit v_limit
  ) x;
  return v_rows;
end;
$$;

-- ----------------------------------------------------------------------------
-- Admin actions: close positions
-- ----------------------------------------------------------------------------
create or replace function public.admin_close_demo_position(p_position_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position record;
  v_price numeric(18,8);
  v_result jsonb;
begin
  if p_position_id is null then raise exception 'Position id is required.'; end if;
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if to_regclass('public.demo_positions') is null then raise exception 'Demo positions table is not available.'; end if;

  select * into v_position from public.demo_positions where id = p_position_id for update;
  if not found then raise exception 'Demo position not found.'; end if;
  if v_position.status <> 'open' then raise exception 'Demo position is already closed.'; end if;

  v_price := public.advance_demo_quote(v_position.user_id, v_position.market);
  v_result := public.settle_demo_position(p_position_id, v_price);
  if v_result is null then raise exception 'Demo position could not be closed.'; end if;

  return jsonb_build_object('ok', true, 'position_id', p_position_id, 'account_type', 'demo', 'exit_price', v_price, 'result', v_result);
end;
$$;

create or replace function public.admin_close_real_test_position(p_position_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position record;
  v_price numeric;
  v_result jsonb;
begin
  if p_position_id is null then raise exception 'Position id is required.'; end if;
  if not public.nexatrade_is_admin() then raise exception 'Admin access required.'; end if;
  if to_regclass('public.real_test_positions') is null then raise exception 'Real test positions table is not available.'; end if;

  select * into v_position from public.real_test_positions where id = p_position_id for update;
  if not found then raise exception 'Real test position not found.'; end if;
  if v_position.status <> 'open' then raise exception 'Real test position is already closed.'; end if;

  v_price := public.real_test_price_for(v_position.market);
  v_result := public.real_test_apply_close(p_position_id, v_price);

  return jsonb_build_object('ok', true, 'position_id', p_position_id, 'account_type', 'real_test', 'exit_price', v_price, 'result', v_result);
end;
$$;

-- ----------------------------------------------------------------------------
-- Permissions
-- ----------------------------------------------------------------------------
revoke all on function public.nexatrade_is_admin() from public, anon;
grant execute on function public.nexatrade_is_admin() to authenticated;

revoke all on function public.admin_get_user_balances(uuid) from public, anon;
revoke all on function public.admin_adjust_demo_balance(uuid, text, numeric, text) from public, anon;
revoke all on function public.admin_adjust_real_test_balance(uuid, text, numeric, text) from public, anon;
revoke all on function public.admin_get_dashboard_overview() from public, anon;
revoke all on function public.admin_get_deposit_records() from public, anon;
revoke all on function public.admin_list_megapay_deposits(text, integer) from public, anon;
revoke all on function public.admin_list_demo_positions(uuid, text, integer) from public, anon;
revoke all on function public.admin_list_real_test_positions(uuid, text, integer) from public, anon;
revoke all on function public.admin_list_demo_transactions(uuid, integer) from public, anon;
revoke all on function public.admin_list_real_test_transactions(uuid, integer) from public, anon;
revoke all on function public.admin_close_demo_position(uuid) from public, anon;
revoke all on function public.admin_close_real_test_position(uuid) from public, anon;

grant execute on function public.admin_get_user_balances(uuid) to authenticated;
grant execute on function public.admin_adjust_demo_balance(uuid, text, numeric, text) to authenticated;
grant execute on function public.admin_adjust_real_test_balance(uuid, text, numeric, text) to authenticated;
grant execute on function public.admin_get_dashboard_overview() to authenticated;
grant execute on function public.admin_get_deposit_records() to authenticated;
grant execute on function public.admin_list_megapay_deposits(text, integer) to authenticated;
grant execute on function public.admin_list_demo_positions(uuid, text, integer) to authenticated;
grant execute on function public.admin_list_real_test_positions(uuid, text, integer) to authenticated;
grant execute on function public.admin_list_demo_transactions(uuid, integer) to authenticated;
grant execute on function public.admin_list_real_test_transactions(uuid, integer) to authenticated;
grant execute on function public.admin_close_demo_position(uuid) to authenticated;
grant execute on function public.admin_close_real_test_position(uuid) to authenticated;

notify pgrst, 'reload schema';
