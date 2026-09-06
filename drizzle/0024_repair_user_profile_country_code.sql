-- Algunas bases históricas registraron 0019 sin materializar la columna.
-- Es segura tanto para ellas como para instalaciones sanas.
ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "country_code" text;
