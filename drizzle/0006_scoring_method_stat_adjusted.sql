-- Add stat_adjusted to scoringMethod enum
ALTER TABLE `stories` MODIFY COLUMN `scoringMethod` ENUM('rule_based','llm_assisted','stat_adjusted') NOT NULL DEFAULT 'rule_based';
