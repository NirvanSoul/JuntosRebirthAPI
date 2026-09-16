-- `spaces_one_active_couple_per_creator_idx` solo protegía a quien creó el
-- espacio. Una persona que había entrado como invitada todavía podía crear un
-- segundo espacio de pareja y terminar con dos membresías activas.
--
-- Repara primero cualquier duplicado histórico sin borrar datos financieros.
-- Se conserva prioritariamente un espacio ya activado, con más miembros y más
-- antiguo; las demás membresías pasan a `left`.
WITH ranked_memberships AS (
  SELECT
    membership.id,
    row_number() OVER (
      PARTITION BY membership.user_id
      ORDER BY
        (couple_space.activated_at IS NOT NULL) DESC,
        active_members.member_count DESC,
        (EXISTS (
          SELECT 1
          FROM public.space_invitations invitation
          WHERE invitation.space_id = couple_space.id
            AND invitation.status = 'pending'
            AND invitation.expires_at > now()
        )) DESC,
        couple_space.created_at ASC,
        couple_space.id ASC
    ) AS position
  FROM public.space_members membership
  JOIN public.spaces couple_space ON couple_space.id = membership.space_id
  JOIN LATERAL (
    SELECT count(*)::int AS member_count
    FROM public.space_members candidate
    WHERE candidate.space_id = couple_space.id
      AND candidate.status = 'active'
  ) active_members ON true
  WHERE membership.status = 'active'
    AND couple_space.type = 'couple'
    AND couple_space.archived_at IS NULL
)
UPDATE public.space_members membership
SET status = 'left', left_at = now(), updated_at = now()
FROM ranked_memberships ranked
WHERE membership.id = ranked.id AND ranked.position > 1;
--> statement-breakpoint
-- Si la membresía retirada pertenecía al creador histórico, su autoría no debe
-- seguir ocupando el índice de creación. Los movimientos conservan su autor.
UPDATE public.spaces couple_space
SET created_by = NULL, updated_at = now()
WHERE couple_space.type = 'couple'
  AND couple_space.created_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.space_members membership
    WHERE membership.space_id = couple_space.id
      AND membership.user_id = couple_space.created_by
      AND membership.status = 'active'
  );
--> statement-breakpoint
-- Un espacio que conserva miembros también debe conservar un propietario.
WITH successor AS (
  SELECT DISTINCT ON (membership.space_id)
    membership.id
  FROM public.space_members membership
  JOIN public.spaces couple_space ON couple_space.id = membership.space_id
  WHERE couple_space.type = 'couple'
    AND couple_space.archived_at IS NULL
    AND membership.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM public.space_members owner_membership
      WHERE owner_membership.space_id = membership.space_id
        AND owner_membership.status = 'active'
        AND owner_membership.role = 'owner'
    )
  ORDER BY membership.space_id, (membership.role = 'admin') DESC,
    membership.joined_at ASC, membership.id ASC
)
UPDATE public.space_members membership
SET role = 'owner', updated_at = now()
FROM successor
WHERE membership.id = successor.id;
--> statement-breakpoint
-- Los espacios duplicados que quedaron sin nadie se archivan, no se eliminan.
-- Así la reparación jamás destruye movimientos ni categorías históricas.
UPDATE public.spaces couple_space
SET archived_at = COALESCE(couple_space.archived_at, now()), updated_at = now()
WHERE couple_space.type = 'couple'
  AND couple_space.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.space_members membership
    WHERE membership.space_id = couple_space.id
      AND membership.status = 'active'
  );
--> statement-breakpoint
UPDATE public.space_invitations invitation
SET status = 'revoked', updated_at = now()
WHERE invitation.status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM public.spaces couple_space
    WHERE couple_space.id = invitation.space_id
      AND couple_space.type = 'couple'
      AND couple_space.archived_at IS NOT NULL
  );
--> statement-breakpoint
-- La guarda se ejecuta dentro de la misma transacción que crea o reactiva la
-- membresía. El advisory lock serializa operaciones simultáneas para la misma
-- persona; después se vuelve a consultar la fuente canónica bajo ese lock.
CREATE FUNCTION public.enforce_single_active_couple_membership()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.spaces target_space
    WHERE target_space.id = NEW.space_id
      AND target_space.type = 'couple'
      AND target_space.archived_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id, 0));

  IF EXISTS (
    SELECT 1
    FROM public.space_members existing_membership
    JOIN public.spaces existing_space
      ON existing_space.id = existing_membership.space_id
    WHERE existing_membership.user_id = NEW.user_id
      AND existing_membership.status = 'active'
      AND existing_membership.space_id <> NEW.space_id
      AND existing_space.type = 'couple'
      AND existing_space.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'COUPLE_SPACE_LIMIT'
      USING ERRCODE = '23514',
            CONSTRAINT = 'space_members_one_active_couple_per_user';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER space_members_single_active_couple_guard
BEFORE INSERT OR UPDATE OF status, user_id, space_id ON public.space_members
FOR EACH ROW EXECUTE FUNCTION public.enforce_single_active_couple_membership();
