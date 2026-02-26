create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.teambuilder_teams (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  format text,
  notes text,
  slots jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teambuilder_teams_slots_is_array check (jsonb_typeof(slots) = 'array'),
  constraint teambuilder_teams_slots_max_6 check (jsonb_array_length(slots) <= 6)
);

create index if not exists teambuilder_teams_user_id_idx
  on public.teambuilder_teams (user_id);

create index if not exists teambuilder_teams_user_updated_idx
  on public.teambuilder_teams (user_id, updated_at desc);

drop trigger if exists set_teambuilder_teams_updated_at on public.teambuilder_teams;
create trigger set_teambuilder_teams_updated_at
before update on public.teambuilder_teams
for each row
execute function public.set_updated_at();

comment on table public.teambuilder_teams is
'Pokemon teambuilder teams stored per Clerk user (user_id). Slots JSON stores up to 6 Pokemon with item/ability/moves/EVs/IVs.';
