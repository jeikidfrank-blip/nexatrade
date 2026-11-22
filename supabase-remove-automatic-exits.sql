-- Remove automatic stop-loss/take-profit effects from demo and test positions.
-- Existing columns remain for compatibility and historical rows; new positions
-- store NULL in those columns. Running this migration more than once is safe.

alter table public.demo_positions alter column stop_loss drop not null;
alter table public.demo_positions alter column take_profit drop not null;
alter table public.real_test_positions alter column stop_loss drop not null;
alter table public.real_test_positions alter column take_profit drop not null;

create or replace function public.get_demo_market_prices()
returns table(market text, price numeric)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  update public.demo_market_prices as quotes
     set price = greatest(round(quotes.price * (1 + (random() - 0.5) * 0.0008)::numeric, 8), 0.00000001),
         updated_at = now()
   where quotes.user_id = auth.uid();

  return query
    select quotes.market, quotes.price
      from public.demo_market_prices as quotes
     where quotes.user_id = auth.uid()
     order by quotes.market;
end;
$$;

create or replace function public.demo_open_position(
  p_market text,
  p_side text,
  p_amount numeric,
  p_stop_loss numeric default null,
  p_take_profit numeric default null
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
    v_price, null, null, v_fee
  ) returning * into v_position;
  insert into public.demo_transactions (user_id, transaction_type, amount, balance_after, position_id)
  values (v_user_id, 'position_open', p_amount, v_balance, v_position.id);

  return jsonb_build_object('position', to_jsonb(v_position), 'balance_after', v_balance);
end;
$$;

create or replace function public.real_test_settle(p_quotes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Automatic price-based exits are intentionally disabled. Positions stay
  -- open until the user closes them through real_test_close_position.
  return;
end;
$$;

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
  return query
    select (e ->> 'market')::text, (e ->> 'price')::numeric
      from jsonb_array_elements(v_quotes) e;
end;
$$;

create or replace function public.real_test_open_position(
  p_market text,
  p_side text,
  p_amount numeric,
  p_stop_loss numeric default null,
  p_take_profit numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_price numeric;
  v_qty numeric;
  v_fee numeric;
  v_balance numeric;
  v_pos_id uuid;
  v_required numeric;
  c_leverage constant numeric := 200;
  c_max_stake constant numeric := 100000;
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
    or p_amount <> round(p_amount, 2) then
    raise exception 'The minimum position size is KSh 100, with no more than two decimal places.';
  end if;
  if p_amount > c_max_stake then
    raise exception 'The maximum position size is KSh 100,000.';
  end if;

  v_price := public.real_test_price_for(p_market);
  if v_price is null then
    raise exception 'Unknown market: %', p_market;
  end if;

  v_qty := round(p_amount * c_leverage / v_price, 12);
  v_fee := round(p_amount * 0.001, 2);
  v_required := p_amount + v_fee;

  insert into public.real_test_accounts (user_id, balance)
  values (v_uid, 0)
  on conflict (user_id) do nothing;

  update public.real_test_accounts
     set balance = balance - v_required
   where user_id = v_uid and balance >= v_required
   returning balance into v_balance;
  if v_balance is null then
    raise exception 'Insufficient test balance for this position.';
  end if;

  insert into public.real_test_positions
    (user_id, market, side, amount, quantity, entry_price, stop_loss, take_profit, entry_fee)
  values
    (v_uid, p_market, p_side, p_amount, v_qty, v_price, null, null, v_fee)
  returning id into v_pos_id;

  return jsonb_build_object(
    'position', (select to_jsonb(p) from public.real_test_positions p where p.id = v_pos_id),
    'balance_after', v_balance
  );
end;
$$;

revoke all on function public.demo_open_position(text, text, numeric, numeric, numeric) from public, anon;
revoke all on function public.real_test_market_prices() from public, anon;
revoke all on function public.real_test_open_position(text, text, numeric, numeric, numeric) from public, anon;

grant execute on function public.demo_open_position(text, text, numeric, numeric, numeric) to authenticated;
grant execute on function public.real_test_market_prices() to authenticated;
grant execute on function public.real_test_open_position(text, text, numeric, numeric, numeric) to authenticated;

notify pgrst, 'reload schema';
