-- La persona invitada puede rechazar, no solo caducar o que se le revoque.
ALTER TYPE "public"."space_invitation_status" ADD VALUE IF NOT EXISTS 'declined';
--> statement-breakpoint
-- Una sola invitación pendiente por espacio y correo. El índice es la
-- protección real contra concurrencia: dos peticiones simultáneas no pueden
-- crear dos invitaciones pendientes para la misma persona.
CREATE UNIQUE INDEX "space_invitations_one_pending_per_email_idx"
  ON "space_invitations" ("space_id", lower("invited_email"))
  WHERE "status" = 'pending';
