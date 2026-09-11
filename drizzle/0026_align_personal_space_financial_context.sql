-- El contexto financiero es la fuente de país/moneda de su libro personal.
-- Algunas cuentas históricas conservaron metadatos del país anterior en
-- spaces, aunque perfil y contexto ya coincidían en el nuevo país.
-- No convierte importes ni modifica movimientos, cuentas o membresías.
UPDATE public.spaces s
SET country_code = NULLIF(fc.country_code, 'ZZ'),
    currency = fc.canonical_currency,
    updated_at = now()
FROM public.financial_contexts fc
WHERE s.id = fc.personal_space_id AND s.type = 'personal'
  AND (s.country_code IS DISTINCT FROM NULLIF(fc.country_code, 'ZZ')
    OR s.currency IS DISTINCT FROM fc.canonical_currency);
