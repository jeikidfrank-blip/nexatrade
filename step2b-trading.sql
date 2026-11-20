-- STEP 2b — the trading functions.
-- Run ONLY after step2a-quotes.sql says Success (2b calls those functions).

create or replace function public.real_test_apply_close(
  p_position_id uuid,
  p_exit_price   numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
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
$fn$;

create or replace function public.real_test_settle(p_quotes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
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
$fn$;

create or replace function public.real_test_market_prices()
returns table (market text, price numeric)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_quotes jsonb;
begin
  v_quotes := public.real_test_quotes();

  perform public.real_test_settle(v_quotes);

  return query
    select (e ->> 'market')::text, (e ->> 'price')::numeric
      from jsonb_array_elements(v_quotes) e;
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
$fn$;

create or replace function public.real_test_close_position(p_position_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
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
$fn$;

revoke all on function public.real_test_settle(jsonb) from public, anon, authenticated;
revoke all on function public.real_test_apply_close(uuid, numeric) from public, anon, authenticated;

revoke all on function public.real_test_market_prices() from public, anon;
revoke all on function public.real_test_open_position(text, text, numeric, numeric, numeric) from public, anon;
revoke all on function public.real_test_close_position(uuid) from public, anon;

grant execute on function public.real_test_market_prices() to authenticated;
grant execute on function public.real_test_open_position(text, text, numeric, numeric, numeric) to authenticated;
grant execute on function public.real_test_close_position(uuid) to authenticated;

notify pgrst, 'reload schema';
