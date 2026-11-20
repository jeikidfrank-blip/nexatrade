-- STEP 5 — make the Real Account's simulated market actually move.
--
-- The demo feed random-walks ~0.04% per tick, so a 150 KSh position moved
-- about 0.06 KSh and the P&L looked frozen at zero.
--
-- This raises the amplitude to roughly 1% swings for gold and 0.6% for the FX
-- pairs, on a 3-second tick. P&L is still stake x price movement -- nothing is
-- generated separately from the price.
--
-- If you want calmer or wilder movement, the only number to change is the third
-- column of each row below (0.010, 0.006, 0.007).

create or replace function public.real_test_generate_quotes()
returns table (market text, price numeric)
language sql
stable
security definer
set search_path = public
as $fn$
  with bases as (
    select * from (values
      ('XAU', 527189.00::numeric, 0.0100::numeric, 1.1::numeric),
      ('EUR',    151.346::numeric, 0.0060::numeric, 2.7::numeric),
      ('GBP',    173.810::numeric, 0.0070::numeric, 4.4::numeric)
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

-- Use this generator directly for the test account, so the volatility above is
-- what the chart and the fills use.
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

revoke all on function public.real_test_generate_quotes() from public, anon, authenticated;
revoke all on function public.real_test_quotes() from public, anon, authenticated;

notify pgrst, 'reload schema';
