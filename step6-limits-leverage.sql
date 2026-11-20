-- STEP 6 — stake cap, withdrawal limits, and 1:100 leverage.
--
-- 1. Maximum stake  KSh 100,000
-- 2. Withdrawals    min KSh 500, max KSh 500,000
-- 3. Leverage       1:100, so P&L scales with the stake
--
-- Why leverage: P&L = stake x leverage x price move. At 1:100 a 1% move on a
-- 500 KSh stake is ~500 KSh, and on a 100,000 KSh stake is ~100,000. That is
-- how you get figures in the hundreds-to-hundreds-of-thousands range without
-- inventing a number that has nothing to do with the price.
--
-- A stop-out is included: if the loss reaches the stake, the position closes
-- there, so a leveraged trade can never take more than its own stake or drive
-- the balance negative.

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
  c_leverage constant numeric := 100;
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

  -- Leverage lives in the quantity: the stake controls the margin, the
  -- notional exposure is stake x 100.
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

create or replace function public.real_test_settle(p_quotes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  r            record;
  q            numeric;
  v_exit       numeric;
  v_unrealized numeric;
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

    -- Margin stop-out: once the loss equals the stake, close at the price that
    -- makes the loss exactly the stake.
    if v_exit is null then
      v_unrealized := (q - r.entry_price) * r.quantity
        * case when r.side = 'buy' then 1 else -1 end;

      if v_unrealized <= -r.amount then
        v_exit := case
          when r.side = 'buy' then r.entry_price - (r.amount / r.quantity)
          else r.entry_price + (r.amount / r.quantity)
        end;
      end if;
    end if;

    if v_exit is not null then
      perform public.real_test_apply_close(r.id, v_exit);
    end if;
  end loop;
end;
$fn$;

create or replace function public.real_test_withdraw(p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
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
    or p_amount <= 0
    or p_amount <> round(p_amount, 2)
  then
    raise exception 'Enter a valid withdrawal amount.';
  end if;

  if p_amount < 500 then
    raise exception 'The minimum withdrawal is KSh 500.';
  end if;

  if p_amount > 500000 then
    raise exception 'The maximum withdrawal is KSh 500,000.';
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
    (v_user_id, 'withdrawal', v_amount, v_balance);

  return jsonb_build_object(
    'balance', v_balance,
    'amount', v_amount,
    'mode', 'TEST'
  );
end;
$fn$;

revoke all on function public.real_test_open_position(text, text, numeric, numeric, numeric) from public, anon;
revoke all on function public.real_test_settle(jsonb) from public, anon, authenticated;
revoke all on function public.real_test_withdraw(numeric) from public, anon;

grant execute on function public.real_test_open_position(text, text, numeric, numeric, numeric) to authenticated;
grant execute on function public.real_test_withdraw(numeric) to authenticated;

notify pgrst, 'reload schema';
