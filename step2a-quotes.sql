-- STEP 2a — price conversion plus the quote functions only.
-- No hashtext() anywhere: it is an undocumented pg_catalog function and is the
-- most likely thing that failed with "No function matches the given name and
-- argument types". The price noise below is deterministic sine instead.

update public.demo_market_prices
   set price = round(price * 130, 8),
       updated_at = now()
 where (market = 'XAU' and price < 10000)
    or (market = 'EUR' and price < 10)
    or (market = 'GBP' and price < 10);

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

create or replace function public.real_test_generate_quotes()
returns table (market text, price numeric)
language sql
stable
security definer
set search_path = public
as $fn$
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
$fn$;

create or replace function public.real_test_quotes()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
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
$fn$;

create or replace function public.real_test_price_for(p_market text)
returns numeric
language sql
security definer
set search_path = public
as $fn$
  select (e ->> 'price')::numeric
    from jsonb_array_elements(public.real_test_quotes()) e
   where e ->> 'market' = p_market;
$fn$;

revoke all on function public.real_test_generate_quotes() from public, anon, authenticated;
revoke all on function public.real_test_quotes() from public, anon, authenticated;
revoke all on function public.real_test_price_for(text) from public, anon, authenticated;

notify pgrst, 'reload schema';
