-- NexaTrade: VIP SMS/messages simulator support for real test withdrawals
-- Run in Supabase SQL editor with a privileged role.
-- Safe to re-run where possible (CREATE OR REPLACE / IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- 1) Withdrawal messages table (simulated SMS inbox, e.g. MPESA confirmations)
create table if not exists public.nexatrade_withdrawal_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  phone text,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'USD',
  status text not null default 'successful',
  reference text,
  transaction_id uuid,
  sender text not null default 'MPESA',
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.nexatrade_withdrawal_messages
  add column if not exists phone text,
  add column if not exists amount numeric(14,2),
  add column if not exists currency text default 'USD',
  add column if not exists status text default 'successful',
  add column if not exists reference text,
  add column if not exists transaction_id uuid,
  add column if not exists sender text default 'MPESA',
  add column if not exists body text,
  add column if not exists created_at timestamptz default now();

create index if not exists nexatrade_withdrawal_messages_user_created_idx
  on public.nexatrade_withdrawal_messages (user_id, created_at desc);

alter table public.nexatrade_withdrawal_messages enable row level security;

drop policy if exists "Users read own withdrawal messages"
  on public.nexatrade_withdrawal_messages;
create policy "Users read own withdrawal messages"
  on public.nexatrade_withdrawal_messages
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.nexatrade_withdrawal_messages from public, anon, authenticated;
grant select on public.nexatrade_withdrawal_messages to authenticated;

-- 2) Resolve current user's account/profile info (account type, vip flag, phone)
create or replace function public.nexatrade_get_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := '';
  v_phone text := '';
  v_account_type text := 'standard';
  v_is_vip boolean := false;
  v_status text := 'active';
  v_meta jsonb := '{}'::jsonb;
  v_app jsonb := '{}'::jsonb;
  v_row jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('authenticated', false, 'account_type', 'standard', 'is_vip', false);
  end if;

  begin
    select coalesce(email, ''), coalesce(phone, ''), coalesce(raw_user_meta_data, '{}'::jsonb), coalesce(raw_app_meta_data, '{}'::jsonb)
      into v_email, v_phone, v_meta, v_app
      from auth.users where id = v_uid;
  exception when others then
    v_email := ''; v_phone := ''; v_meta := '{}'::jsonb; v_app := '{}'::jsonb;
  end;

  if coalesce(v_phone, '') = '' then
    v_phone := coalesce(v_meta ->> 'phone', v_meta ->> 'phone_number', v_app ->> 'phone', '');
  end if;

  v_account_type := lower(coalesce(v_meta ->> 'account_type', v_app ->> 'account_type', v_meta ->> 'accountType', v_app ->> 'accountType', 'standard'));
  v_status := lower(coalesce(v_meta ->> 'status', v_app ->> 'status', 'active'));
  if coalesce(v_meta ->> 'is_vip', v_app ->> 'is_vip', v_meta ->> 'vip', v_app ->> 'vip', '') in ('true','1','t','yes') then
    v_is_vip := true;
  end if;

  if to_regclass('public.profiles') is not null then
    begin
      execute 'select to_jsonb(p) from public.profiles p where p.id = $1 limit 1' into v_row using v_uid;
      if v_row is null then
        begin execute 'select to_jsonb(p) from public.profiles p where p.user_id = $1 limit 1' into v_row using v_uid; exception when others then v_row := null; end;
      end if;
      if v_row is not null then
        v_account_type := lower(coalesce(v_row ->> 'account_type', v_row ->> 'accountType', v_account_type, 'standard'));
        v_status := lower(coalesce(v_row ->> 'status', v_status, 'active'));
        if coalesce(v_phone, '') = '' then v_phone := coalesce(v_row ->> 'phone', v_row ->> 'phone_number', ''); end if;
      end if;
    exception when others then null; end;
  end if;

  if to_regclass('public.user_profiles') is not null then
    begin
      execute 'select to_jsonb(p) from public.user_profiles p where p.id = $1 or p.user_id = $1 limit 1' into v_row using v_uid;
      if v_row is not null then
        v_account_type := lower(coalesce(v_row ->> 'account_type', v_row ->> 'accountType', v_account_type, 'standard'));
        v_status := lower(coalesce(v_row ->> 'status', v_status, 'active'));
        if coalesce(v_phone, '') = '' then v_phone := coalesce(v_row ->> 'phone', v_row ->> 'phone_number', ''); end if;
      end if;
    exception when others then null; end;
  end if;

  if to_regclass('public.admin_users') is not null then
    begin
      execute 'select to_jsonb(p) from public.admin_users p where p.user_id = $1 or p.id = $1 limit 1' into v_row using v_uid;
      if v_row is not null then
        v_account_type := lower(coalesce(v_row ->> 'account_type', v_row ->> 'accountType', v_account_type, 'standard'));
        v_status := lower(coalesce(v_row ->> 'status', v_status, 'active'));
        if coalesce(v_phone, '') = '' then v_phone := coalesce(v_row ->> 'phone', v_row ->> 'phone_number', ''); end if;
      end if;
    exception when others then null; end;
  end if;

  if v_account_type = 'vip' then v_is_vip := true; end if;

  return jsonb_build_object(
    'authenticated', true,
    'user_id', v_uid,
    'email', v_email,
    'phone', v_phone,
    'account_type', coalesce(nullif(v_account_type, ''), 'standard'),
    'status', coalesce(nullif(v_status, ''), 'active'),
    'is_vip', v_is_vip
  );
end;
$$;

revoke all on function public.nexatrade_get_my_account() from public, anon, authenticated;
grant execute on function public.nexatrade_get_my_account() to authenticated;

-- 3) Message listing RPC for the signed-in user (VIP-only enforcement temporarily disabled while building)
create or replace function public.nexatrade_list_my_withdrawal_messages(p_limit integer default 100)
returns setof public.nexatrade_withdrawal_messages
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Authentication required.';
  end if;

  -- TODO: Re-enable VIP-only access when the messages app is finished.
  -- v_profile := public.nexatrade_get_my_account();
  -- if not coalesce((v_profile ->> 'is_vip')::boolean, false) then
  --   raise exception 'Messages app is available for VIP accounts only.';
  -- end if;

  return query
    select *
    from public.nexatrade_withdrawal_messages m
    where m.user_id = v_uid
    order by m.created_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

revoke all on function public.nexatrade_list_my_withdrawal_messages(integer) from public, anon, authenticated;
grant execute on function public.nexatrade_list_my_withdrawal_messages(integer) to authenticated;

-- 4) Update real_test_withdraw to create a withdrawal message on success
create or replace function public.real_test_withdraw(p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_amount numeric(14,2);
  v_balance numeric(14,2);
  v_tx_id uuid;
  v_phone text := '';
  v_meta jsonb := '{}'::jsonb;
  v_reference text;
  v_body text;
  v_message_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_amount is null
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount <= 0
    or p_amount <> round(p_amount, 2) then
    raise exception 'Enter a valid withdrawal amount.';
  end if;

  v_amount := p_amount;

  update public.real_test_accounts
  set balance = balance - v_amount
  where user_id = v_user_id
    and balance >= v_amount
  returning balance into v_balance;

  if v_balance is null then
    raise exception 'Insufficient test balance.';
  end if;

  insert into public.real_test_transactions
    (user_id, transaction_type, amount, balance_after)
  values
    (v_user_id, 'withdrawal', v_amount, v_balance)
  returning id into v_tx_id;

  begin
    select coalesce(phone, ''), coalesce(raw_user_meta_data, '{}'::jsonb)
      into v_phone, v_meta
      from auth.users where id = v_user_id;
  exception when others then
    v_phone := ''; v_meta := '{}'::jsonb;
  end;
  if coalesce(v_phone, '') = '' then
    v_phone := coalesce(v_meta ->> 'phone', v_meta ->> 'phone_number', '');
  end if;

 v_reference := 'DEMO-WDL-' || upper(substr(replace(coalesce(v_tx_id::text, gen_random_uuid()::text), '-', ''), 1, 10));

v_body := 'DEMO NOTIFICATION: NexaTasks test withdrawal of ' ||
          trim(to_char(v_amount, 'FM999999999990.00')) ||
          ' USD processed successfully. This is simulated test money only. No real M-PESA transfer occurred. Ref: ' ||
          v_reference || '.';

if to_regclass('public.nexatrade_withdrawal_messages') is not null then
  insert into public.nexatrade_withdrawal_messages
    (user_id, phone, amount, currency, status, reference, transaction_id, sender, body)
  values
    (v_user_id, nullif(v_phone, ''), v_amount, 'USD', 'successful',
 v_reference, v_tx_id, 'MPESA', v_body)  
  returning id into v_message_id;
end if;
  return jsonb_build_object(
    'balance', v_balance,
    'amount', v_amount,
    'mode', 'TEST',
    'transaction_id', v_tx_id,
    'reference', v_reference,
    'phone', nullif(v_phone, ''),
    'message_id', v_message_id,
    'message_body', v_body
  );
end;
$$;

revoke all on function public.real_test_withdraw(numeric) from public, anon, authenticated;
grant execute on function public.real_test_withdraw(numeric) to authenticated;

-- Ensure realtime can deliver new withdrawal messages to the messages app (safe to re-run)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'nexatrade_withdrawal_messages'
     ) then
    alter publication supabase_realtime add table public.nexatrade_withdrawal_messages;
  end if;
exception
  when insufficient_privilege then
    raise notice 'Could not add nexatrade_withdrawal_messages to supabase_realtime publication; add it manually if realtime updates are needed.';
end $$;

notify pgrst, 'reload schema';
