ALTER TABLE `rss_sources` MODIFY COLUMN `url` varchar(768) NOT NULL;--> statement-breakpoint
ALTER TABLE `seen_urls` MODIFY COLUMN `url` varchar(768) NOT NULL;--> statement-breakpoint
ALTER TABLE `stories` MODIFY COLUMN `sourceUrl` varchar(768) NOT NULL;--> statement-breakpoint
ALTER TABLE `historical_posts` ADD `headlineType` varchar(64);--> statement-breakpoint
ALTER TABLE `historical_posts` ADD `headlineViralityScore` int;--> statement-breakpoint
ALTER TABLE `historical_posts` ADD `saves` int;--> statement-breakpoint
ALTER TABLE `historical_posts` ADD `followersGained` int;--> statement-breakpoint
ALTER TABLE `historical_posts` ADD `platform` varchar(64);--> statement-breakpoint
ALTER TABLE `historical_posts` ADD `airline` varchar(128);--> statement-breakpoint
ALTER TABLE `historical_posts` ADD `imageType` varchar(128);--> statement-breakpoint
ALTER TABLE `story_packages` ADD `sourceConfirmation` text;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `headlineObjects` json;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `selectedViralityScore` int;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `selectedHeadlineType` varchar(64);--> statement-breakpoint
ALTER TABLE `story_packages` ADD `editorReview` json;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `editorScore` int;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `storySummary` text;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `researchExtracted` json;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `researchTimeline` text;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `researchQuotes` json;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `researchSources` json;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `researchContradictions` text;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `researchMissingInfo` text;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `researchAdditionalContext` text;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `researchEditorialHooks` json;--> statement-breakpoint
ALTER TABLE `story_packages` ADD `researchStoryQuality` json;