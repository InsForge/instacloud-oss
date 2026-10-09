-- Every boot, after the schema replay: each Supabase login role gets the database's password, like upstream.
\getenv pw INSTA_DB_PASSWORD
alter role supabase_admin with password :'pw';
alter role authenticator with password :'pw';
alter role supabase_auth_admin with password :'pw';
alter role supabase_storage_admin with password :'pw';
alter role supabase_read_only_user with password :'pw';

-- Migration 20260413000000 preloads supautils, which the managed database does not ship.
alter role authenticator reset session_preload_libraries;

-- What upstream's docker/volumes/db/realtime.sql and jwt.sql do for the bundled database.
create schema if not exists _realtime;
alter schema _realtime owner to supabase_admin;
alter database :"dbname" set "app.settings.jwt_exp" to '3600';

-- Upstream ships pg_graphql off. Try it once per database, retrying on later boots until it exists.
select not exists (select 1 from _supabase_template.migrations where name = 'enable-pg_graphql') as todo \gset
\if :todo
do $$
begin
  create extension if not exists pg_graphql;
  insert into _supabase_template.migrations (name) values ('enable-pg_graphql');
exception when others then
  raise warning 'pg_graphql is not available on this database, GraphQL stays off: %', sqlerrm;
end
$$;
\endif
