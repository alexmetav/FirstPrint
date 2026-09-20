begin;

-- Real MEXC markets replace the fictional rotating cards. Pair discovery is
-- performed by the trusted Render worker and persisted here.
alter table public.fp_markets add column if not exists pair text;
alter table public.fp_markets add column if not exists selection_day date;
alter table public.fp_markets add column if not exists daily_slot smallint;
alter table public.fp_markets add column if not exists detected_at timestamptz;
alter table public.fp_markets add column if not exists open_price numeric;
alter table public.fp_markets add column if not exists close_price numeric;
alter table public.fp_markets add column if not exists source_url text;
alter table public.fp_markets alter column result_bucket drop not null;

alter table public.fp_markets drop constraint if exists fp_markets_daily_slot_check;
alter table public.fp_markets add constraint fp_markets_daily_slot_check check (daily_slot is null or daily_slot between 1 and 2);
alter table public.fp_markets drop constraint if exists fp_markets_price_check;
alter table public.fp_markets add constraint fp_markets_price_check check (
  (open_price is null or open_price > 0) and (close_price is null or close_price > 0)
);
create unique index if not exists fp_markets_mexc_daily_slot
  on public.fp_markets(selection_day, daily_slot) where exchange = 'MEXC' and selection_day is not null;

create table if not exists public.fp_mexc_pairs_seen (
  pair text primary key,
  base_symbol text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_price numeric,
  selected_day date,
  check (pair ~ '^[A-Z0-9]{2,30}USDT$'),
  check (last_price is null or last_price > 0)
);
alter table public.fp_mexc_pairs_seen enable row level security;
revoke all on public.fp_mexc_pairs_seen from public, anon, authenticated;

-- Kept for compatibility with the first beta migration; it intentionally no
-- longer creates fictional tokens.
create or replace function public.fp_refresh_practice_markets()
returns void language plpgsql security definer set search_path = '' as $$
begin
  return;
end;
$$;

create or replace function public.fp_admin_sync_mexc_pairs(p_pairs jsonb, p_observed_at timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_pair text;
  v_base text;
  v_price numeric;
  v_inserted text;
  v_baseline boolean;
  v_day date := (p_observed_at at time zone 'utc')::date;
  v_slot integer;
  v_created integer := 0;
begin
  if jsonb_typeof(p_pairs) <> 'array' or jsonb_array_length(p_pairs) > 5000 then
    raise exception 'Invalid MEXC pair batch';
  end if;
  perform pg_advisory_xact_lock(hashtext('firstprint:mexc-pair-sync'));
  select not exists(select 1 from public.fp_mexc_pairs_seen) into v_baseline;
  select count(*) + 1 into v_slot from public.fp_markets where exchange = 'MEXC' and selection_day = v_day;

  for v_row in select value from jsonb_array_elements(p_pairs)
  loop
    v_pair := upper(v_row->>'pair');
    v_base := upper(v_row->>'base');
    v_price := nullif(v_row->>'price', '')::numeric;
    if v_pair !~ '^[A-Z0-9]{2,30}USDT$' or v_base !~ '^[A-Z0-9]{1,25}$' or v_price is null or v_price <= 0 then
      continue;
    end if;

    v_inserted := null;
    insert into public.fp_mexc_pairs_seen(pair, base_symbol, first_seen_at, last_seen_at, last_price)
    values (v_pair, v_base, p_observed_at, p_observed_at, v_price)
    on conflict (pair) do update set last_seen_at = excluded.last_seen_at, last_price = excluded.last_price
    returning case when xmax = 0 then pair else null end into v_inserted;

    if not v_baseline and v_inserted is not null and v_slot <= 2 then
      insert into public.fp_markets(
        slug, symbol, name, exchange, pair, selection_day, daily_slot, detected_at,
        open_price, closes_at, settles_at, source_url, result_bucket
      ) values (
        to_char(v_day, 'YYYYMMDD') || '-mexc-' || lower(v_base) || '-' || v_slot,
        v_base, v_base, 'MEXC', v_pair, v_day, v_slot, p_observed_at,
        v_price, p_observed_at + interval '23 hours', p_observed_at + interval '24 hours',
        'https://www.mexc.com/exchange/' || v_base || '_USDT', null
      ) on conflict (slug) do nothing;
      update public.fp_mexc_pairs_seen set selected_day = v_day where pair = v_pair;
      v_slot := v_slot + 1;
      v_created := v_created + 1;
    end if;
  end loop;
  return jsonb_build_object('baseline', v_baseline, 'created', v_created);
end;
$$;

-- Settlement bucket uses the real 24-hour MEXC move from the stored opening
-- price: <=-20 crash, <-5 down, <=5 flat, <20 up, otherwise moon.
create or replace function public.fp_admin_settle_mexc_market(p_market_id uuid, p_close_price numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open numeric;
  v_change numeric;
begin
  if p_close_price is null or p_close_price <= 0 then raise exception 'Invalid close price'; end if;
  select open_price into v_open from public.fp_markets
    where id = p_market_id and exchange = 'MEXC' and status = 'open' and settles_at <= now()
    for update;
  if v_open is null then raise exception 'MEXC market is not ready to settle'; end if;
  v_change := (p_close_price / v_open - 1) * 100;
  update public.fp_markets set
    close_price = p_close_price,
    result_bucket = case
      when v_change <= -20 then 'crash'
      when v_change < -5 then 'down'
      when v_change <= 5 then 'flat'
      when v_change < 20 then 'up'
      else 'moon'
    end
  where id = p_market_id;
  perform public.fp_settle_due_markets();
end;
$$;

create or replace function public.fp_get_dashboard()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  perform public.fp_settle_due_markets();
  select jsonb_build_object(
    'profile', (select jsonb_build_object(
      'userId', p.user_id, 'walletAddress', p.wallet_address, 'username', p.username,
      'points', p.points, 'canClaimDaily', p.last_claim_day is distinct from (now() at time zone 'utc')::date
    ) from public.fp_profiles p where p.user_id = v_uid),
    'markets', coalesce((select jsonb_agg(jsonb_build_object(
      'id', m.id, 'symbol', m.symbol, 'name', m.name, 'exchange', m.exchange, 'pair', m.pair,
      'openPrice', m.open_price, 'closePrice', m.close_price, 'sourceUrl', m.source_url,
      'closesAt', extract(epoch from m.closes_at) * 1000,
      'settlesAt', extract(epoch from m.settles_at) * 1000,
      'status', m.status, 'result', case when m.status = 'resolved' then m.result_bucket else null end,
      'pool', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id),
      'totals', jsonb_build_object(
        'crash', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'crash'),
        'down', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'down'),
        'flat', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'flat'),
        'up', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'up'),
        'moon', (select coalesce(sum(x.stake), 0) from public.fp_predictions x where x.market_id = m.id and x.bucket = 'moon')
      )
    ) order by m.detected_at desc) from public.fp_markets m where m.id in (
      select latest.id from public.fp_markets latest
      where latest.exchange = 'MEXC' and latest.selection_day is not null
      order by latest.detected_at desc limit 2
    )), '[]'::jsonb),
    'predictions', coalesce((select jsonb_agg(jsonb_build_object(
      'id', x.id, 'marketId', x.market_id, 'symbol', m.symbol, 'exchange', m.exchange,
      'bucket', x.bucket, 'stake', x.stake, 'payout', x.payout,
      'placedAt', extract(epoch from x.placed_at) * 1000, 'marketStatus', m.status
    ) order by x.placed_at desc) from public.fp_predictions x join public.fp_markets m on m.id = x.market_id where x.user_id = v_uid), '[]'::jsonb),
    'leaderboard', coalesce((select jsonb_agg(jsonb_build_object('rank', q.rank, 'username', q.username, 'points', q.points, 'isMe', q.user_id = v_uid) order by q.rank)
      from (select p.user_id, p.username, p.points, row_number() over(order by p.points desc, p.created_at) as rank from public.fp_profiles p limit 25) q), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- A market without a trusted price result remains open instead of refunding or
-- settling from a client-supplied value.
create or replace function public.fp_settle_due_markets()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market public.fp_markets%rowtype;
  v_total bigint;
  v_winners bigint;
  v_net bigint;
  v_award record;
begin
  for v_market in
    select * from public.fp_markets
    where status = 'open' and settles_at <= now() and result_bucket is not null
    for update skip locked
  loop
    select coalesce(sum(stake), 0), coalesce(sum(stake) filter (where bucket = v_market.result_bucket), 0)
      into v_total, v_winners from public.fp_predictions where market_id = v_market.id;
    v_net := floor(v_total * 0.96);
    for v_award in
      select user_id,
        sum(case when v_winners = 0 then stake
                 when bucket = v_market.result_bucket then floor(stake::numeric * v_net / v_winners)
                 else 0 end)::bigint as amount
      from public.fp_predictions where market_id = v_market.id group by user_id
    loop
      if v_award.amount > 0 then
        update public.fp_profiles set points = points + v_award.amount, updated_at = now() where user_id = v_award.user_id;
        insert into public.fp_ledger(user_id, delta, reason, ref)
        values (v_award.user_id, v_award.amount, case when v_winners = 0 then 'refund' else 'payout' end, v_market.id::text)
        on conflict do nothing;
      end if;
    end loop;
    update public.fp_predictions p set payout = case
      when v_winners = 0 then p.stake
      when p.bucket = v_market.result_bucket then floor(p.stake::numeric * v_net / v_winners)::bigint
      else 0 end
    where p.market_id = v_market.id and p.payout is null;
    update public.fp_markets set status = 'resolved' where id = v_market.id;
  end loop;
end;
$$;

-- Service-role only: never grant these worker functions to browser roles.
revoke all on function public.fp_admin_sync_mexc_pairs(jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.fp_admin_settle_mexc_market(uuid, numeric) from public, anon, authenticated;
grant execute on function public.fp_admin_sync_mexc_pairs(jsonb, timestamptz) to service_role;
grant execute on function public.fp_admin_settle_mexc_market(uuid, numeric) to service_role;

commit;
