-- STEP 1 of 2 — create the positions table only.
-- About 30 lines. If this goes red, the error will be readable.
-- Run this FIRST, then step2-trading-functions.sql.

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

alter table public.real_test_positions enable row level security;

drop policy if exists "real_test_positions_select_own" on public.real_test_positions;

create policy "real_test_positions_select_own"
  on public.real_test_positions
  for select to authenticated
  using (auth.uid() = user_id);

revoke insert, update, delete on public.real_test_positions from anon, authenticated;
grant select on public.real_test_positions to authenticated;

notify pgrst, 'reload schema';
