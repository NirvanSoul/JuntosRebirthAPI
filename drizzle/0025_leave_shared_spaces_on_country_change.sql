-- La salida conserva el historial financiero; volver al país no reactiva
-- membresías. Hace falta aceptar una nueva invitación.
CREATE FUNCTION public.leave_incompatible_shared_spaces(target_user_id text, target_country text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  target_space uuid;
  successor uuid;
BEGIN
  FOR target_space IN
    SELECT s.id FROM public.spaces s
    JOIN public.space_members m ON m.space_id = s.id
    WHERE m.user_id = target_user_id AND m.status = 'active'
      AND s.type <> 'personal'
      AND s.country_code IS DISTINCT FROM target_country
    ORDER BY s.id FOR UPDATE OF s
  LOOP
    UPDATE public.space_members
    SET status = 'left', left_at = now(), updated_at = now()
    WHERE space_id = target_space AND user_id = target_user_id AND status = 'active';

    UPDATE public.space_invitations
    SET status = 'revoked', updated_at = now()
    WHERE space_id = target_space AND invited_by = target_user_id AND status = 'pending';

    -- El creador histórico no debe bloquearle un nuevo espacio de pareja
    -- al usuario que sale. La autoría de movimientos y categorías se conserva.
    UPDATE public.spaces SET created_by = NULL, updated_at = now()
    WHERE id = target_space AND created_by = target_user_id;

    IF NOT EXISTS (
      SELECT 1 FROM public.space_members m
      JOIN public.user_profiles p ON p.user_id = m.user_id
      JOIN public.spaces s ON s.id = m.space_id
      WHERE m.space_id = target_space AND m.status = 'active' AND m.role = 'owner'
        AND p.country_code IS NOT DISTINCT FROM s.country_code
    ) THEN
      SELECT m.id INTO successor FROM public.space_members m
      JOIN public.user_profiles p ON p.user_id = m.user_id
      JOIN public.spaces s ON s.id = m.space_id
      WHERE m.space_id = target_space AND m.status = 'active'
        AND p.country_code IS NOT DISTINCT FROM s.country_code
      ORDER BY (m.role = 'admin') DESC, m.joined_at, m.id LIMIT 1;

      IF successor IS NOT NULL THEN
        UPDATE public.space_members SET role = 'owner', updated_at = now() WHERE id = successor;
      ELSE
        UPDATE public.spaces SET archived_at = COALESCE(archived_at, now()), updated_at = now()
        WHERE id = target_space;
      END IF;
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.enforce_profile_country_memberships()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.leave_incompatible_shared_spaces(NEW.user_id, NEW.country_code);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_profiles_country_memberships
AFTER UPDATE OF country_code ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_country_memberships();
--> statement-breakpoint
-- Serializa aceptar invitaciones con cambiar el país, incluso si ambas
-- peticiones llegan simultáneamente. NULL solo es compatible con NULL.
CREATE FUNCTION public.enforce_shared_membership_country()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  member_country text;
  space_country text;
  shared boolean;
BEGIN
  IF NEW.status <> 'active' THEN RETURN NEW; END IF;
  SELECT type <> 'personal', country_code INTO shared, space_country
  FROM public.spaces WHERE id = NEW.space_id;
  IF NOT shared THEN RETURN NEW; END IF;
  SELECT country_code INTO member_country FROM public.user_profiles
  WHERE user_id = NEW.user_id FOR UPDATE;
  IF member_country IS DISTINCT FROM space_country THEN
    RAISE EXCEPTION 'SPACE_COUNTRY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER space_members_country_guard
BEFORE INSERT OR UPDATE OF status, user_id, space_id ON public.space_members
FOR EACH ROW EXECUTE FUNCTION public.enforce_shared_membership_country();
--> statement-breakpoint
-- Repara también membresías históricas incompatibles sin borrar sus datos.
DO $$
DECLARE profile record;
BEGIN
  FOR profile IN
    SELECT DISTINCT p.user_id, p.country_code FROM public.user_profiles p
    JOIN public.space_members m ON m.user_id = p.user_id AND m.status = 'active'
    JOIN public.spaces s ON s.id = m.space_id AND s.type <> 'personal'
    WHERE p.country_code IS DISTINCT FROM s.country_code
  LOOP
    PERFORM public.leave_incompatible_shared_spaces(profile.user_id, profile.country_code);
  END LOOP;
END;
$$;
