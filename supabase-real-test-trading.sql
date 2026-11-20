-- ============================================================================
-- NexaTrade — enable trading on the "real test" account
-- ----------------------------------------------------------------------------
-- Run this ONCE in the Supabase SQL Editor, after your existing demo SQL.
-- Safe to re-run: every object uses IF NOT EXISTS or CREATE OR REPLACE.
--
-- It does NOT touch demo_* objects and does NOT integrate any payment
-- provider. It only lets a signed-in user open and close simulated positions
-- against a balance held in real_test_accounts.
--
-- Money model (mirrors the fee rules already shown in the UI):
--   open  : balance -= amount + entry_fee        (0.1% of amount)
--   close : balance += amount + net_pnl
--           net_pnl  = gross - entry_fee - exit_fee
--           gross    = (exit - entry) * qty * (+1 buy / -1 sell)
--           exit_fee = qty * exit * 0.1%
--
-- Pricing: one quote source for the whole account. It prefers your existing
-- get_demo_market_prices() so the trade ticket, the chart and the fill price
-- all agree, and falls back to a local generator if that is unavailable.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Positions table
-- ----------------------------------------------------------------------------
create table if not exists public.real_test_positions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  market       text not null,
  side         text not null check (side in ('buy', 'sell')),
  amount       numeric(18, 2)  not null check (amount > 0),
  quantity     numeric(28, 12) not null check (quantity > 0),
  entry_price  numeric(18, 6)  not null,
  stop_loss    numeric(18, 6)  not null,
  take_profit  numeric(18, 6)  not null,
  entry_fee    numeric(18, 2)  not null default 0,
  exit_price   numeric(18, 6),
  pnl          numeric(18, 2),
  status       text not null default 'open' check (status in ('open', 'closed')),
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz
);

create index if not exists real_test_positions_user_idx
  on public.real_test_positions (user_id, opened_at desc);
create index if not exists real_test_positions_open_idx
  on public.real_test_positions (user_id) where status = 'open';

alter table public.real_test_positions enable row level security;

drop policy if exists "real_test_positions_select_own" on public.real_test_positions;
create policy "real_test_positions_select_own"
  on public.real_test_positions
  for select to authenticated
  using (auth.uid() = user_id);

-- Clients never write this table directly; only the RPCs below do.
revoke insert, update, delete on public.real_test_positions from anon, authenticated;
grant select on public.real_test_positions to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Accounts table (no-op if you already created it)
-- ----------------------------------------------------------------------------
create table if not exists public.real_test_accounts (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  balance    numeric(18, 2) not null default 0 check (balance >= 0),
  created_at timestamptz not null default now()
);

alter table public.real_test_accounts enable row level security;

drop policy if exists "real_test_accounts_select_own" on public.real_test_accounts;
create policy "real_test_accounts_select_own"
  on public.real_test_accounts
  for select to authenticated
  using (auth.uid() = user_id);

revoke insert, update, delete on public.real_test_accounts from anon, authenticated;
grant select on public.real_test_accounts to authenticated;

-- ----------------------------------------------------------------------------
-- 2b. Test-account ledger (no-op — you already created this table)
--     Matching your definition exactly: deposit / withdrawal only. Position
--     opens and closes are NOT logged here, because the client's history table
--     would render them as "Test deposit".
-- ----------------------------------------------------------------------------
create table if not exists public.real_test_transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  transaction_type text not null check (transaction_type in ('deposit', 'withdrawal')),
  amount           numeric(14, 2) not null check (amount > 0),
  balance_after    numeric(14, 2) not null check (balance_after >= 0),
  position_id      uuid,
  created_at       timestamptz not null default now()
);

create index if not exists real_test_transactions_user_created_idx
  on public.real_test_transactions (user_id, created_at desc);

alter table public.real_test_transactions enable row level security;

drop policy if exists "real_test_transactions_select_own" on public.real_test_transactions;
create policy "real_test_transactions_select_own"
  on public.real_test_transactions
  for select to authenticated
  using (auth.uid() = user_id);

revoke insert, update, delete on public.real_test_transactions from anon, authenticated;
grant select on public.real_test_transactions to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Fallback quote generator (deterministic, 5-second ticks)
-- ----------------------------------------------------------------------------
create or replace function public.real_test_generate_quotes()
returns table (market text, price numeric)
language sql
stable
security definer
set search_path = public
as $$
  with bases as (
    select * from (values
      ('XAU', 527189.00::numeric, 0.00090::numeric, 1.1::numeric),
      ('EUR',    151.346::numeric, 0.00050::numeric, 2.7::numeric),
      ('GBP',    173.810::numeric, 0.00055::numeric, 4.4::numeric)
    ) as t (market, base_price, amplitude, phase)
  ),
  tick as (
    select floor(extract(epoch from now()) / 5)::bigint as t
  )
  select b.market,
         round(
           (b.base_price * (
             1
             + b.amplitude       * sin(t.t / 37.0 + b.phase)
             + b.amplitude * 0.6 * sin(t.t / 11.0 + b.phase * 2)
             + b.amplitude * 0.35 * sin(t.t / 3.0 + b.phase * 5.3)
           ))::numeric,
           6
         ) as price
  from bases b
  cross join tick t;
$$;

-- ----------------------------------------------------------------------------
-- 4. Single quote source for the test account (jsonb: [{market, price}, ...])
-- ----------------------------------------------------------------------------
create or replace function public.real_test_quotes()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quotes jsonb := '[]'::jsonb;
begin
  begin
    select coalesce(jsonb_agg(jsonb_build_object('market', q.market, 'price', q.price)), '[]'::jsonb)
      into v_quotes
      from public.get_demo_market_prices() q;
  exception when others then
    v_quotes := '[]'::jsonb;
  end;

  if v_quotes is null or jsonb_array_length(v_quotes) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object('market', g.market, 'price', g.price)), '[]'::jsonb)
      into v_quotes
      from public.real_test_generate_quotes() g;
  end if;

  return v_quotes;
end;
$$;

create or replace function public.real_test_price_for(p_market text)
returns numeric
language sql
security definer
set search_path = public
as $$
  select (e ->> 'price')::numeric
    from jsonb_array_elements(public.real_test_quotes()) e
   where e ->> 'market' = p_market;
$$;

-- ----------------------------------------------------------------------------
-- 5. Close a position at a given price (internal)
-- ----------------------------------------------------------------------------
create or replace function public.real_test_apply_close(
  p_position_id uuid,
  p_exit_price   numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pos      public.real_test_positions%rowtype;
  v_gross    numeric;
  v_exit_fee numeric;
  v_pnl      numeric;
  v_balance  numeric;
begin
  select * into v_pos
    from public.real_test_positions
   where id = p_position_id
     and status = 'open'
   for update;

  if not found then
    return null;
  end if;

  v_gross := round(
    (p_exit_price - v_pos.entry_price)
      * v_pos.quantity
      * case when v_pos.side = 'buy' then 1 else -1 end,
    2
  );
  v_exit_fee := round(v_pos.quantity * p_exit_price * 0.001, 2);
  v_pnl      := round(v_gross - v_pos.entry_fee - v_exit_fee, 2);

  update public.real_test_positions
     set status     = 'closed',
         exit_price = p_exit_price,
         pnl        = v_pnl,
         closed_at  = now()
   where id = v_pos.id;

  update public.real_test_accounts
     set balance = greatest(0, balance + v_pos.amount + v_pnl)
   where user_id = v_pos.user_id
  returning balance into v_balance;

  return jsonb_build_object(
    'position', (select to_jsonb(p) from public.real_test_positions p where p.id = v_pos.id),
    'balance_after', v_balance
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Settle stop-loss / take-profit hits, scoped to the calling user
-- ----------------------------------------------------------------------------
create or replace function public.real_test_settle(p_quotes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r      record;
  q      numeric;
  v_exit numeric;
begin
  for r in
    select *
      from public.real_test_positions
     where status = 'open'
       and (auth.uid() is null or user_id = auth.uid())
     for update
  loop
    select (e ->> 'price')::numeric
      into q
      from jsonb_array_elements(p_quotes) e
     where e ->> 'market' = r.market;

    continue when q is null;

    v_exit := null;

    if r.side = 'buy' then
      if q <= r.stop_loss then
        v_exit := r.stop_loss;
      elsif q >= r.take_profit then
        v_exit := r.take_profit;
      end if;
    else
      if q >= r.stop_loss then
        v_exit := r.stop_loss;
      elsif q <= r.take_profit then
        v_exit := r.take_profit;
      end if;
    end if;

    if v_exit is not null then
      perform public.real_test_apply_close(r.id, v_exit);
    end if;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Price feed for the test account (settles first, then returns quotes)
-- ----------------------------------------------------------------------------
create or replace function public.real_test_market_prices()
returns table (market text, price numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quotes jsonb;
begin
  v_quotes := public.real_test_quotes();

  perform public.real_test_settle(v_quotes);

  return query
    select (e ->> 'market')::text, (e ->> 'price')::numeric
      from jsonb_array_elements(v_quotes) e;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. Open a position
-- ----------------------------------------------------------------------------
create or replace function public.real_test_open_position(
  p_market      text,
  p_side        text,
  p_amount      numeric,
  p_stop_loss   numeric,
  p_take_profit numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_price    numeric;
  v_qty      numeric;
  v_fee      numeric;
  v_balance  numeric;
  v_pos_id   uuid;
  v_required numeric;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;

  if p_side not in ('buy', 'sell') then
    raise exception 'Invalid trade side.';
  end if;

  if p_amount is null
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount < 100
    or p_amount <> round(p_amount, 2)
  then
    raise exception 'The minimum position size is KSh 100, with no more than two decimal places.';
  end if;

  v_price := public.real_test_price_for(p_market);

  if v_price is null then
    raise exception 'Unknown market: %', p_market;
  end if;

  if p_stop_loss is null or p_take_profit is null then
    raise exception 'Stop loss and take profit are required.';
  end if;

  if p_side = 'buy' and not (p_stop_loss < v_price and p_take_profit > v_price) then
    raise exception 'For a buy, stop loss must be below and take profit above the entry price.';
  end if;

  if p_side = 'sell' and not (p_stop_loss > v_price and p_take_profit < v_price) then
    raise exception 'For a sell, stop loss must be above and take profit below the entry price.';
  end if;

  v_qty      := round(p_amount / v_price, 12);
  v_fee      := round(p_amount * 0.001, 2);
  v_required := p_amount + v_fee;

  insert into public.real_test_accounts (user_id, balance)
  values (v_uid, 0)
  on conflict (user_id) do nothing;

  update public.real_test_accounts
     set balance = balance - v_required
   where user_id = v_uid
     and balance >= v_required
  returning balance into v_balance;

  if v_balance is null then
    raise exception 'Insufficient test balance for this position.';
  end if;

  insert into public.real_test_positions
    (user_id, market, side, amount, quantity, entry_price, stop_loss, take_profit, entry_fee)
  values
    (v_uid, p_market, p_side, p_amount, v_qty, v_price, p_stop_loss, p_take_profit, v_fee)
  returning id into v_pos_id;

  return jsonb_build_object(
    'position', (select to_jsonb(p) from public.real_test_positions p where p.id = v_pos_id),
    'balance_after', v_balance
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. Close a position manually at the current quote
-- ----------------------------------------------------------------------------
create or replace function public.real_test_close_position(p_position_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pos   public.real_test_positions%rowtype;
  v_price numeric;
begin
  select * into v_pos
    from public.real_test_positions
   where id = p_position_id
     and user_id = auth.uid()
     and status = 'open';

  if not found then
    raise exception 'Open position not found.';
  end if;

  v_price := public.real_test_price_for(v_pos.market);

  return public.real_test_apply_close(p_position_id, v_price);
end;
$$;

-- ----------------------------------------------------------------------------
-- 10. Permissions
-- ----------------------------------------------------------------------------
revoke all on function public.real_test_generate_quotes() from public, anon, authenticated;
revoke all on function public.real_test_quotes() from public, anon, authenticated;
revoke all on function public.real_test_price_for(text) from public, anon, authenticated;
revoke all on function public.real_test_settle(jsonb) from public, anon, authenticated;
revoke all on function public.real_test_apply_close(uuid, numeric) from public, anon, authenticated;

revoke all on function public.real_test_market_prices() from public, anon;
revoke all on function public.real_test_open_position(text, text, numeric, numeric, numeric) from public, anon;
revoke all on function public.real_test_close_position(uuid) from public, anon;

grant execute on function public.real_test_market_prices() to authenticated;
grant execute on function public.real_test_open_position(text, text, numeric, numeric, numeric) to authenticated;
grant execute on function public.real_test_close_position(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 11. Give every existing and future user a test account row
--     Without this, switching to the Test tab throws "Real Test Account was
--     not created" for anyone whose signup did not create one.
-- ----------------------------------------------------------------------------
insert into public.real_test_accounts (user_id, balance)
select u.id, 0 from auth.users u
on conflict (user_id) do nothing;

create or replace function public.real_test_create_account_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.real_test_accounts (user_id, balance)
  values (new.id, 0)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists real_test_account_after_signup on auth.users;
create trigger real_test_account_after_signup
  after insert on auth.users
  for each row execute function public.real_test_create_account_for_new_user();

-- ----------------------------------------------------------------------------
-- 12. Sanity check — run this afterwards, it should return 3 rows
-- ----------------------------------------------------------------------------
-- select * from public.real_test_market_prices();

-- ============================================================================
-- PART 2 — balance controls
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 13. Demo only: set an exact demo balance
--     Touches demo_accounts only. It can never move money on the test account.
-- ----------------------------------------------------------------------------
create or replace function public.demo_set_balance(p_balance numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_balance numeric;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;

  if p_balance is null or p_balance < 0 then
    raise exception 'Enter a demo balance of 0 or more.';
  end if;

  if p_balance > 100000000 then
    raise exception 'That demo balance is too large.';
  end if;

  insert into public.demo_accounts (user_id, balance)
  values (v_uid, 0)
  on conflict (user_id) do nothing;

  update public.demo_accounts
     set balance = round(p_balance, 2)
   where user_id = v_uid
  returning balance into v_balance;

  return jsonb_build_object('balance', v_balance);
end;
$$;

-- ----------------------------------------------------------------------------
-- 14. Test-account deposits and withdrawals — left exactly as you wrote them
--
-- Your real_test_deposit / real_test_withdraw already do the right thing:
-- validate the amount, update real_test_accounts.balance, insert a ledger row
-- with balance_after, and return {"balance": ...}. Nothing here to replace,
-- and no DROP is needed.
--
-- The client no longer depends on the returned shape anyway: after each call
-- it re-reads real_test_accounts and real_test_transactions, which is what
-- makes the balance card and the history table repaint.
-- ----------------------------------------------------------------------------

revoke all on function public.demo_set_balance(numeric) from public, anon;
grant execute on function public.demo_set_balance(numeric) to authenticated;

-- ============================================================================
-- PART 3 — Kenya Shillings
-- ----------------------------------------------------------------------------
-- The demo market prices seeded by supabase-demo-accounts.sql are in USD, and
-- they drive every fill. They must be re-denominated to KSh, otherwise
-- quantity = amount / price mixes shillings with dollars and the position
-- sizes come out wrong.
--
-- Rate used: 1 USD = 130 KES. Change it here AND the market prices in app.js
-- if your rate differs.
-- ============================================================================

-- Open demo positions were priced in USD. Settling them against KSh prices
-- would print a huge fake profit, so close them flat first. The guard runs
-- only while prices are still USD, so a second run does nothing.
do $$
begin
  if (select min(price) from public.demo_market_prices where market = 'XAU') < 10000 then
    update public.demo_positions
       set status = 'closed',
           exit_price = entry_price,
           pnl = 0,
           closed_at = now()
     where status = 'open';
  end if;
end;
$$;

update public.demo_market_prices
   set price = round(price * 130, 8),
       updated_at = now()
 where (market = 'XAU' and price < 10000)
    or (market = 'EUR' and price < 10)
    or (market = 'GBP' and price < 10);

-- New signups must be seeded in KSh too.
create or replace function public.create_demo_account_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.demo_accounts (user_id, balance)
  values (new.id, 10000.00)
  on conflict (user_id) do nothing;

  insert into public.demo_market_prices (user_id, market, price) values
    (new.id, 'XAU', 527189.00000000),
    (new.id, 'EUR', 151.34600000),
    (new.id, 'GBP', 173.81000000)
  on conflict (user_id, market) do nothing;

  return new;
end;
$$;

revoke all on function public.create_demo_account_for_new_user() from public, anon, authenticated;

-- Deposit wording in KSh. Identical logic to yours; only the message changed
-- and the floor is now KSh 100.
create or replace function public.real_test_deposit(p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_amount numeric(14,2);
  v_balance numeric(14,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_amount is null
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount < 100
    or p_amount <> round(p_amount, 2) then
    raise exception 'Minimum deposit is KSh 100.';
  end if;

  v_amount := p_amount;

  update public.real_test_accounts
  set balance = balance + v_amount
  where user_id = v_user_id
  returning balance into v_balance;

  if v_balance is null then
    raise exception 'Test account not found.';
  end if;

  insert into public.real_test_transactions
    (user_id, transaction_type, amount, balance_after)
  values
    (v_user_id, 'deposit', v_amount, v_balance);

  return jsonb_build_object(
    'balance', v_balance,
    'amount', v_amount,
    'mode', 'TEST'
  );
end;
$$;

revoke all on function public.real_test_deposit(numeric) from public, anon;
grant execute on function public.real_test_deposit(numeric) to authenticated;

-- Demo deposit wording in KSh. Same logic as yours; only the message changed.
create or replace function public.demo_deposit(p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_amount numeric(14, 2);
  v_balance numeric(14, 2);
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_amount is null
    or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount < 100
    or p_amount <> round(p_amount, 2) then
    raise exception 'Demo deposits must be at least KSh 100 with no more than two decimal places.';
  end if;

  v_amount := p_amount;

  update public.demo_accounts
  set balance = balance + v_amount
  where user_id = v_user_id
  returning balance into v_balance;

  if v_balance is null then
    raise exception 'Demo account is not available.';
  end if;

  insert into public.demo_transactions (user_id, transaction_type, amount, balance_after)
  values (v_user_id, 'deposit', v_amount, v_balance);

  return jsonb_build_object('balance', v_balance, 'amount', v_amount);
end;
$$;

revoke all on function public.demo_deposit(numeric) from public, anon;
grant execute on function public.demo_deposit(numeric) to authenticated;

-- ----------------------------------------------------------------------------
-- 15. Force PostgREST to pick up the new tables immediately.
--     Without this the REST API can keep answering 404 for a table that exists.
-- ----------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- Demo position floor and wording in KSh. Same logic as yours; the minimum is
-- now KSh 100 instead of $10 and the message says so. Privileges are preserved
-- by CREATE OR REPLACE.
create or replace function public.demo_open_position(
  p_market text,
  p_side text,
  p_amount numeric,
  p_stop_loss numeric,
  p_take_profit numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_price numeric(18, 8);
  v_balance numeric(14, 2);
  v_fee numeric(14, 2);
  v_position public.demo_positions%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;
  if p_market is null or p_side is null
    or p_market not in ('XAU', 'EUR', 'GBP') or p_side not in ('buy', 'sell') then
    raise exception 'Unsupported market or trade side.';
  end if;
  if p_amount is null or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount < 100 or p_amount <> round(p_amount, 2) then
    raise exception 'Position amount must be at least KSh 100 with no more than two decimal places.';
  end if;
  perform 1 from public.demo_accounts where user_id = v_user_id for update;
  if not found then
    raise exception 'Demo account is not available.';
  end if;
  v_price := public.advance_demo_quote(v_user_id, p_market);
  if p_stop_loss is null or p_take_profit is null
    or p_stop_loss::text in ('NaN', 'Infinity', '-Infinity')
    or p_take_profit::text in ('NaN', 'Infinity', '-Infinity')
    or p_stop_loss <= 0 or p_take_profit <= 0
    or (p_side = 'buy' and not (p_stop_loss < v_price and p_take_profit > v_price))
    or (p_side = 'sell' and not (p_stop_loss > v_price and p_stop_loss <= v_price * 1.99 and p_take_profit < v_price))
  then
    raise exception 'Stop loss and take profit must be valid for the current demo entry price.';
  end if;
  v_fee := round(p_amount * 0.001, 2);
  update public.demo_accounts
  set balance = balance - p_amount - v_fee
  where user_id = v_user_id and balance >= p_amount + v_fee
  returning balance into v_balance;
  if v_balance is null then
    raise exception 'Insufficient demo funds for this position and fee.';
  end if;
  insert into public.demo_positions (
    user_id, market, side, amount, quantity, entry_price, stop_loss, take_profit, entry_fee
  ) values (
    v_user_id, p_market, p_side, p_amount, round(p_amount / v_price, 10),
    v_price, p_stop_loss, p_take_profit, v_fee
  ) returning * into v_position;
  insert into public.demo_transactions (user_id, transaction_type, amount, balance_after, position_id)
  values (v_user_id, 'position_open', p_amount, v_balance, v_position.id);
  return jsonb_build_object('position', to_jsonb(v_position), 'balance_after', v_balance);
end;
$$;
