DELETE FROM spaces
WHERE type = 'couple'
  AND activated_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM space_invitations
    WHERE space_invitations.space_id = spaces.id
      AND space_invitations.status = 'pending'
  );
