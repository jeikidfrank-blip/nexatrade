-- ============================================================================
-- NexaTrade — MegaPay integration (pending deposits + idempotent crediting)
-- ----------------------------------------------------------------------------
-- Run in Supabase SQL Editor after the existing real-test setup
-- (supabase-real-test-account.sql / supabase-real-test-trading.sql).
-- Safe to re-run where possible (IF NOT EXISTS / CREATE OR REPLACE).
--
-- Does NOT create a separate wallet system: completed MegaPay deposits are
-- credited into the existing real_test_accounts balance and recorded in
-- real_test_transactions (type 'deposit'), same as simulated test deposits.
-- ============================================================================

-- 1. Track MegaPay deposit intents (pending -> completed/failed). This is a
--    payment-tracking table, not a wallet. The wallet remains real_test_accounts.
create table if not exists public.megapay_deposits (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  amount                  numeric(14,2) not null check (amount > 0),
  currency                text not null default 'KES',
  msisdn                  text,
  email                   text,
  reference               text not null,
  transaction_request_id  text,
  status                  text not null default 'pending'
                            check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  provider_status         text,
  provider_response       jsonb,
  status_response         jsonb,
  credited_transaction_id uuid references public.real_test_transactions(id),
  credited_at             timestamptz,
  last_status_check_at    timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint megapay_deposits_reference_key unique (reference)
);

-- One provider request/transaction id should map to one deposit intent.
create unique index if not exists megapay_deposits_transaction_request_id_uidx
  on public.megapay_deposits (transaction_request_id)
  where transaction_request_id is not null;

create index if not exists megapay_deposits_user_created_idx
  on public.megapay_deposits (user_id, created_at desc);

create index if not exists megapay_deposits_status_idx
  on public.megapay_deposits (status);

-- Keep updated_at current on updates.
create or replace function public.megapay_deposits_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists megapay_deposits_set_updated_at on public.megapay_deposits;
create trigger megapay_deposits_set_updated_at
before update on public.megapay_deposits
for each row execute function public.megapay_deposits_set_updated_at();

-- 2. Security: clients can read their own MegaPay deposit records; all writes
--    happen via service-role Edge Functions / SECURITY DEFINER functions.
alter table public.megapay_deposits enable row level security;

drop policy if exists "megapay_deposits_select_own" on public.megapay_deposits;
create policy "megapay_deposits_select_own"
  on public.megapay_deposits
  for select to authenticated
  using (auth.uid() = user_id);

revoke insert, update, delete on public.megapay_deposits from anon, authenticated;
grant select on public.megapay_deposits to authenticated;

-- 3. Idempotent crediting into the EXISTING wallet (real_test_accounts) and
--    ledger (real_test_transactions). Called from trusted server-side code
--    (Edge Function with service role) AFTER verifying payment via MegaPay's
--    transaction status API. Safe to call more than once for the same deposit.
create or replace function public.megapay_credit_real_test_deposit(
  p_reference text,
  p_transaction_request_id text default null,
  p_provider_status text default null,
  p_status_response jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deposit public.megapay_deposits%rowtype;
  v_balance numeric(14,2);
  v_tx_id uuid;
begin
  if p_reference is null or btrim(p_reference) = '' then
    raise exception 'reference is required.';
  end if;

  -- Lock the intent row so concurrent webhook/status checks cannot double-credit.
  select *
    into v_deposit
    from public.megapay_deposits
   where reference = p_reference
   for update;

  if not found then
    raise exception 'MegaPay deposit not found for reference %.', p_reference;
  end if;

  -- Idempotency: already credited -> return existing result.
  if v_deposit.status = 'completed' and v_deposit.credited_transaction_id is not null then
    return jsonb_build_object(
      'credited', false,
      'already_credited', true,
      'reference', v_deposit.reference,
      'transaction_request_id', v_deposit.transaction_request_id,
      'amount', v_deposit.amount,
      'user_id', v_deposit.user_id,
      'credited_transaction_id', v_deposit.credited_transaction_id
    );
  end if;

  if v_deposit.transaction_request_id is not null
     and p_transaction_request_id is not null
     and btrim(p_transaction_request_id) <> ''
     and v_deposit.transaction_request_id <> p_transaction_request_id then
    raise exception 'transaction_request_id does not match the deposit intent.';
  end if;

  -- Ensure the user's test wallet exists, then credit it (existing wallet system).
  insert into public.real_test_accounts (user_id, balance)
  values (v_deposit.user_id, 0.00)
  on conflict (user_id) do nothing;

  update public.real_test_accounts
     set balance = balance + v_deposit.amount
   where user_id = v_deposit.user_id
  returning balance into v_balance;

  if v_balance is null then
    raise exception 'Test account not found for user.';
  end if;

  -- Record in the existing ledger so history/UI remain consistent.
  insert into public.real_test_transactions
    (user_id, transaction_type, amount, balance_after)
  values
    (v_deposit.user_id, 'deposit', v_deposit.amount, v_balance)
  returning id into v_tx_id;

  update public.megapay_deposits
     set status = 'completed',
         provider_status = coalesce(nullif(btrim(p_provider_status), ''), provider_status),
         transaction_request_id = coalesce(nullif(btrim(p_transaction_request_id), ''), transaction_request_id),
         status_response = coalesce(p_status_response, status_response),
         credited_transaction_id = v_tx_id,
         credited_at = now(),
         last_status_check_at = now()
   where id = v_deposit.id;

  return jsonb_build_object(
    'credited', true,
    'already_credited', false,
    'reference', v_deposit.reference,
    'transaction_request_id', coalesce(nullif(btrim(p_transaction_request_id), ''), v_deposit.transaction_request_id),
    'amount', v_deposit.amount,
    'balance_after', v_balance,
    'user_id', v_deposit.user_id,
    'credited_transaction_id', v_tx_id
  );
end;
$$;

-- Restrict: only service_role (trusted server/Edge Functions) may credit.
revoke all on function public.megapay_credit_real_test_deposit(text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.megapay_credit_real_test_deposit(text, text, text, jsonb)
  to service_role;

-- 4. Helper: mark a deposit status/response without crediting (service_role only).
create or replace function public.megapay_set_deposit_status(
  p_reference text,
  p_status text,
  p_transaction_request_id text default null,
  p_provider_status text default null,
  p_status_response jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.megapay_deposits%rowtype;
begin
  if p_status not in ('pending', 'processing', 'completed', 'failed', 'cancelled') then
    raise exception 'Invalid status.';
  end if;

  update public.megapay_deposits
     set status = case when status = 'completed' then status else p_status end,
         provider_status = coalesce(nullif(btrim(p_provider_status), ''), provider_status),
         transaction_request_id = coalesce(nullif(btrim(p_transaction_request_id), ''), transaction_request_id),
         status_response = coalesce(p_status_response, status_response),
         last_status_check_at = now()
   where reference = p_reference
  returning * into v_row;

  if not found then
    raise exception 'MegaPay deposit not found for reference %.', p_reference;
  end if;

  return jsonb_build_object(
    'reference', v_row.reference,
    'status', v_row.status,
    'transaction_request_id', v_row.transaction_request_id
  );
end;
$$;

revoke all on function public.megapay_set_deposit_status(text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.megapay_set_deposit_status(text, text, text, text, jsonb)
  to service_role;

-- 5. Ask PostgREST to reload schema cache.
notify pgrst, 'reload schema';
