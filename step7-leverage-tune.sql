-- STEP 7 — higher leverage, calibrated against the simulated volatility.
--
-- The problem: a stop-out fires when the loss reaches the stake, which happens
-- at a 1/leverage adverse move. At 1:100 that is 1%, while the price was
-- swinging 1-2% per tick, so positions stopped out on almost every tick and the
-- P&L never had room to grow.
--
-- Recalibrated together:
--   leverage 1:200  -> stop-out distance 0.5%
--   volatility ~0.2% per tick (amplitude 0.002) -> a trade survives long enough
--   to move, and P&L per tick is about 40% of the stake.
--
-- Result on a 1,000 KSh stake: roughly 400 KSh per tick of movement, instead of
-- the near-zero it was showing.
--
-- The single knob is c_leverage below. Raising it raises P&L and lowers the
-- stop-out distance in lockstep.

create or replace function public.real_test_generate_quotes()
returns table (market text, price numeric)
language sql
stable
security definer
set search_path = public
as $fn$
  with bases as (
    select * from (values
      ('XAU', 527189.00::numeric, 0.0020::numeric, 1.1::numeric),
      ('EUR',    151.346::numeric, 0.0012::numeric, 2.7::numeric),
      ('GBP',    173.810::numeric, 0.0014::numeric, 4.4::numeric)
    ) as t (market, base_price, amplitude, phase)
  ),
  tick as (
    select floor(extract(epoch from now()) / 3)::bigint as t
  )
  select b.market,
         round(
           (b.base_price * (
             1
             + b.amplitude       * sin(t.t / 37.0 + b.phase)
             + b.amplitude * 0.6 * sin(t.t / 11.0 + b.phase * 2)
             + b.amplitude * 0.5 * sin(t.t / 3.0 + b.phase * 5.3)
           ))::numeric,
           6
         ) as price
  from bases b
  cross join tick t;
$fn$;

create or replace function public.real_test_quotes()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object('market', g.market, 'price', g.price)), '[]'::jsonb)
      from public.real_test_generate_quotes() g
  );
end;
$fn$;

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
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_price    numeric;
  v_qty      numeric;
  v_fee      numeric;
  v_balance  numeric;
  v_pos_id   uuid;
  v_required numeric;
  c_leverage  constant numeric := 200;
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
    or p_amount <> round(p_amount, 2)
  then
    raise exception 'The minimum position size is KSh 100, with no more than two decimal places.';
  end if;

  if p_amount > c_max_stake then
    raise exception 'The maximum position size is KSh 100,000.';
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

  v_qty      := round(p_amount * c_leverage / v_price, 12);
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
$fn$;

revoke all on function public.real_test_generate_quotes() from public, anon, authenticated;
revoke all on function public.real_test_quotes() from public, anon, authenticated;
revoke all on function public.real_test_open_position(text, text, numeric, numeric, numeric) from public, anon;

grant execute on function public.real_test_open_position(text, text, numeric, numeric, numeric) to authenticated;

notify pgrst, 'reload schema';
