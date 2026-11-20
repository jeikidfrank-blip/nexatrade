-- STEP 4 — remove the leftover USD wording from the demo functions.
--
-- Two replacements, both faithful copies of your originals. The ONLY changes:
--   demo_open_position : floor 10 -> 100, message "$10"  -> "KSh 100"
--   demo_deposit      : message "$100" -> "KSh 100"
-- Logic, validation and side effects are untouched.

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
as $fn$
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
$fn$;

create or replace function public.demo_deposit(p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
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
$fn$;

notify pgrst, 'reload schema';
