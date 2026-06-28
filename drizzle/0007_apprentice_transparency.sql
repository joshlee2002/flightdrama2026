-- Add apprentice scoring transparency columns to stories table
ALTER TABLE `stories`
  ADD COLUMN `ruleScore` int,
  ADD COLUMN `apprenticeConfidence` varchar(16),
  ADD COLUMN `apprenticeReasoning` text,
  ADD COLUMN `similarExamplesUsed` json;
