-- Add 'completed' to the approvalStatus enum on the stories table.
-- This allows stories to be marked as done (posted) without affecting
-- scoring, learning, or the seen-URL list.
ALTER TABLE `stories` MODIFY COLUMN `approvalStatus` enum('pending','approved','rejected','edited','dismissed','duplicate','completed') NOT NULL DEFAULT 'pending';
