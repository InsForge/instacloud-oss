# Upstream's self-host seed (priv/repo/seeds.exs, realtime v2.134.10), changed in three places only.
# 1. The tenant keeps its row: updated in place, never deleted and re-inserted on every boot.
# 2. ssl_enforced follows DB_SSL, since the managed database refuses plaintext.
# 3. The tenant verifies client JWTs with JWT_SECRET; API_JWT_SECRET guards only the admin API.
require Logger

alias Realtime.Api
alias Realtime.Api.Tenant
alias Realtime.Repo
alias Realtime.Tenants

tenant_name = System.fetch_env!("SELF_HOST_TENANT_NAME")

{:ok, _flag} = Api.upsert_feature_flag(%{name: "gcm_encryption_backfill", enabled: true})

params = %{
  "name" => tenant_name,
  "external_id" => tenant_name,
  "jwt_secret" => System.fetch_env!("JWT_SECRET"),
  "extensions" => [
    %{
      "type" => "postgres_cdc_rls",
      "settings" => %{
        "db_name" => System.fetch_env!("DB_NAME"),
        "db_host" => System.fetch_env!("DB_HOST"),
        "db_user" => System.fetch_env!("DB_USER"),
        "db_password" => System.fetch_env!("DB_PASSWORD"),
        "db_port" => System.fetch_env!("DB_PORT"),
        "region" => "us-east-1",
        "poll_interval_ms" => 100,
        "poll_max_record_bytes" => 1_048_576,
        "ssl_enforced" => System.get_env("DB_SSL") == "true"
      }
    }
  ]
}

{:ok, _tenant} =
  case Repo.get_by(Tenant, external_id: tenant_name) do
    nil -> Api.create_tenant(params)
    %Tenant{} -> Api.update_tenant_by_external_id(tenant_name, params)
  end

tenant = Tenants.get_tenant_by_external_id(tenant_name)

with res when res in [:noop, :ok] <- Tenants.Migrations.run_migrations(tenant),
     :ok <- Tenants.Janitor.MaintenanceTask.run(tenant.external_id) do
  Logger.info("Tenant set-up successfully")
else
  error ->
    Logger.error("Failed to set-up tenant: #{inspect(error)}")
    System.halt(1)
end
