-- El polling consulta solo membresías activas. Con el historial de cambios de
-- país o espacios abandonados, el índice simple por user_id termina filtrando
-- cada vez más filas en cada ciclo de dos segundos.
CREATE INDEX "space_members_active_user_space_idx"
  ON "space_members" USING btree ("user_id", "space_id")
  WHERE "status" = 'active';--> statement-breakpoint

-- `/members` parte por space_id y tampoco debe recorrer personas que ya
-- salieron del espacio. Incluimos user_id para el join y el listado activo.
CREATE INDEX "space_members_active_space_user_idx"
  ON "space_members" USING btree ("space_id", "user_id")
  WHERE "status" = 'active';
