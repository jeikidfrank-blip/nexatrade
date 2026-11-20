-- NexaTrade Demo Account Setup
create table if not exists public.demo_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance numeric(14, 2) not null default 10000.00 check (balance >= 0),
  created_at timestamptz not null default now()
);
create table if not exists public.demo_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  transaction_type text not null check (transaction_type in ('deposit', 'position_open', 'position_close')),
  amount numeric(14, 2) not null,
  balance_after numeric(14, 2) not null check (balance_after >= 0),
  position_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.demo_market_prices (
  user_id uuid not null references auth.users (id) on delete cascade,
  market text not null check (market in ('XAU', 'EUR', 'GBP')),
  price numeric(18, 8) not null check (price > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, market)
);

insert into public.demo_market_prices (user_id, market, price)
select users.id, initial.market, initial.price
from auth.users as users
cross join (values
  ('XAU', 4055.30000000::numeric),
  ('EUR', 1.16420000::numeric),
  ('GBP', 1.33700000::numeric)
) as initial(market, price)
on conflict (user_id, market) do nothing;

create table if not exists public.demo_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  market text not null check (market in ('XAU', 'EUR', 'GBP')),
  side text not null check (side in ('buy', 'sell')),
  amount numeric(14, 2) not null check (amount >= 10),
  quantity numeric(24, 10) not null check (quantity > 0),
  entry_price numeric(18, 8) not null check (entry_price > 0),
  stop_loss numeric(18, 8) not null check (stop_loss > 0),
  take_profit numeric(18, 8) not null check (take_profit > 0),
  entry_fee numeric(14, 2) not null check (entry_fee >= 0),
  exit_price numeric(18, 8),
  pnl numeric(14, 2),pnl_multiplier numeric(4, 2) not null default 1.00,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists demo_transactions_user_deposit_created_idx
  on public.demo_transactions (user_id, created_at desc)
  where transaction_type = 'deposit';
create index if not exists demo_positions_user_opened_idx
  on public.demo_positions (user_id, opened_at desc);
create index if not exists demo_positions_user_market_status_idx
  on public.demo_positions (user_id, market, status);

alter table public.demo_accounts enable row level security;
alter table public.demo_transactions enable row level security;
alter table public.demo_positions enable row level security;
alter table public.demo_market_prices enable row level security;

drop policy if exists "Users can read their demo account" on public.demo_accounts;
create policy "Users can read their demo account"
  on public.demo_accounts for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their demo account" on public.demo_accounts;
drop policy if exists "Users can update their demo account" on public.demo_accounts;

drop policy if exists "Users can read their demo transactions" on public.demo_transactions;
create policy "Users can read their demo transactions"
  on public.demo_transactions for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their demo positions" on public.demo_positions;
create policy "Users can read their demo positions"
  on public.demo_positions for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.demo_accounts, public.demo_transactions, public.demo_positions, public.demo_market_prices from public, anon, authenticated;
grant select on public.demo_accounts, public.demo_transactions, public.demo_positions to authenticated;

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
    (new.id, 'XAU', 4055.30000000),
    (new.id, 'EUR', 1.16420000),
    (new.id, 'GBP', 1.33700000)
  on conflict (user_id, market) do nothing;
  return new;
end;
$$;

revoke all on function public.create_demo_account_for_new_user() from public, anon, authenticated;

drop trigger if exists create_demo_account_after_signup on auth.users;
create trigger create_demo_account_after_signup
  after insert on auth.users
  for each row execute function public.create_demo_account_for_new_user();

insert into public.demo_accounts (user_id, balance)
select id, 10000.00 from auth.users
on conflict (user_id) do nothing;

insert into public.demo_market_prices (user_id, market, price)
select users.id, initial.market, initial.price
from auth.users as users
cross join (values
  ('XAU', 4055.30000000::numeric),
  ('EUR', 1.16420000::numeric),
  ('GBP', 1.33700000::numeric)
) as initial(market, price)
on conflict (user_id, market) do nothing;

create or replace function public.advance_demo_quote(p_user_id uuid, p_market text)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price numeric(18, 8);
begin
  update public.demo_market_prices
  set price = greatest(round(price * (1 + (random() - 0.5) * 0.0008)::numeric, 8), 0.00000001),
      updated_at = now()
  where user_id = p_user_id and market = p_market
  returning price into v_price;
  if v_price is null then
    raise exception 'Unsupported demo market.';
  end if;
  return v_price;
end;
$$;
revoke all on function public.advance_demo_quote(uuid, text) from public, anon, authenticated;

create or replace function public.settle_demo_position(p_position_id uuid, p_market_price numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_position public.demo_positions%rowtype;
  v_exit_price numeric(18, 8);
  v_gross_pnl numeric(14, 2);
  v_close_fee numeric(14, 2);
  v_pnl numeric(14, 2);
  v_balance numeric(14, 2);
begin
  select * into v_position
  from public.demo_positions
  where id = p_position_id and status = 'open'
  for update;
  if not found then
    return null;
  end if;

  v_exit_price := p_market_price;
  if v_position.side = 'buy' then
    if p_market_price <= v_position.stop_loss then
      v_exit_price := v_position.stop_loss;
    elsif p_market_price >= v_position.take_profit then
      v_exit_price := v_position.take_profit;
    end if;
    v_gross_pnl := round(v_position.quantity * (v_exit_price - v_position.entry_price), 2);
  else
    if p_market_price >= v_position.stop_loss then
      v_exit_price := v_position.stop_loss;
    elsif p_market_price <= v_position.take_profit then
      v_exit_price := v_position.take_profit;
    end if;
    v_gross_pnl := round(v_position.quantity * (v_position.entry_price - v_exit_price), 2);
  end if;
  v_close_fee := round(v_position.quantity * v_exit_price * 0.001, 2);
  v_pnl := v_gross_pnl - v_position.entry_fee - v_close_fee;

  update public.demo_accounts
  set balance = balance + v_position.amount + v_gross_pnl - v_close_fee
  where user_id = v_position.user_id
  returning balance into v_balance;
  if v_balance is null or v_balance < 0 then
    raise exception 'Position cannot be settled without a negative demo balance.';
  end if;

  update public.demo_positions
  set status = 'closed', exit_price = v_exit_price, pnl = v_pnl, closed_at = now()
  where id = v_position.id
  returning * into v_position;

  insert into public.demo_transactions (user_id, transaction_type, amount, balance_after, position_id)
  values (v_position.user_id, 'position_close', v_pnl, v_balance, v_position.id);

  return jsonb_build_object('position', to_jsonb(v_position), 'balance_after', v_balance);
end;
$$;
revoke all on function public.settle_demo_position(uuid, numeric) from public, anon, authenticated;

create or replace function public.get_demo_market_prices()
returns table(market text, price numeric)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote record;
  v_position_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;
  for v_quote in
    update public.demo_market_prices as quotes
    set price = greatest(round(quotes.price * (1 + (random() - 0.5) * 0.0008)::numeric, 8), 0.00000001),
        updated_at = now()
    where quotes.user_id = auth.uid()
    returning quotes.market, quotes.price
  loop
    for v_position_id in
      select id
      from public.demo_positions as positions
      where positions.user_id = auth.uid() and positions.market = v_quote.market and positions.status = 'open'
        and ((positions.side = 'buy' and (v_quote.price <= positions.stop_loss or v_quote.price >= positions.take_profit))
          or (positions.side = 'sell' and (v_quote.price >= positions.stop_loss or v_quote.price <= positions.take_profit)))
    loop
      perform public.settle_demo_position(v_position_id, v_quote.price);
    end loop;
  end loop;
  return query
  select quotes.market, quotes.price
  from public.demo_market_prices as quotes
  where quotes.user_id = auth.uid()
  order by quotes.market;
end;
$$;

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
  if p_amount is null or p_amount::text in ('NaN', 'Infinity', '-Infinity')
    or p_amount < 100 or p_amount <> round(p_amount, 2) then
    raise exception 'Demo deposits must be at least $100 with no more than two decimal places.';
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
    or p_amount < 10 or p_amount <> round(p_amount, 2) then
    raise exception 'Position amount must be at least $10 with no more than two decimal places.';
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
$$;alter table public.demo_positions
add column if not exists pnl_multiplier numeric(4, 2) not null default 1.00;

create or replace function public.demo_close_position
revoke all on function public.get_demo_market_prices() from public, anon, authenticated;
revoke all on function public.demo_deposit(numeric) from public, anon, authenticated;
revoke all on function public.demo_open_position(text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.demo_close_position(uuid) from public, anon, authenticated;
grant execute on function public.get_demo_market_prices() to authenticated;
grant execute on function public.demo_deposit(numeric) to authenticated;
grant execute on function public.demo_open_position(text, text, numeric, numeric, numeric) to authenticated;
grant execute on function public.demo_close_position(uuid) to authenticated;