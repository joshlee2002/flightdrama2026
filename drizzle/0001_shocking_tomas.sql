CREATE TABLE `example_articles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`label` varchar(256) NOT NULL,
	`articleText` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `example_articles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `historical_posts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`headline` text NOT NULL,
	`article` text,
	`category` varchar(128),
	`postingTime` varchar(32),
	`views` int,
	`likes` int,
	`comments` int,
	`shares` int,
	`revenue` float,
	`netFollows` int,
	`sourceType` varchar(128),
	`aircraftType` varchar(128),
	`storyType` varchar(128),
	`storyId` int,
	`viralAngle` varchar(128),
	`selectedHeadline` text,
	`articleSnippet` text,
	`usedHeadlineVariant` varchar(32),
	`instagramPostId` varchar(64),
	`reach` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `historical_posts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rss_sources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(256) NOT NULL,
	`url` varchar(2048) NOT NULL,
	`category` varchar(64) NOT NULL DEFAULT 'aviation',
	`isActive` boolean NOT NULL DEFAULT true,
	`lastFetchedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`sourceType` enum('manual','ai_keyword') NOT NULL DEFAULT 'manual',
	`tier` enum('core','explore','test'),
	`scoreThreshold` int NOT NULL DEFAULT 0,
	`ratedStoryCount` int NOT NULL DEFAULT 0,
	`lastRatedAt` timestamp,
	`expiresAt` timestamp,
	CONSTRAINT `rss_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `rss_sources_url_unique` UNIQUE(`url`)
);
--> statement-breakpoint
CREATE TABLE `scoring_config` (
	`id` int AUTO_INCREMENT NOT NULL,
	`configKey` varchar(128) NOT NULL,
	`configValue` text NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `scoring_config_id` PRIMARY KEY(`id`),
	CONSTRAINT `scoring_config_configKey_unique` UNIQUE(`configKey`)
);
--> statement-breakpoint
CREATE TABLE `seen_urls` (
	`id` int AUTO_INCREMENT NOT NULL,
	`url` varchar(2048) NOT NULL,
	`rejectedReason` varchar(128),
	`seenAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `seen_urls_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` text NOT NULL,
	`sourceUrl` varchar(2048) NOT NULL,
	`sourceName` varchar(256),
	`content` text,
	`publishedAt` timestamp,
	`viralScore` int NOT NULL DEFAULT 0,
	`statusLabel` enum('must_post','strong_candidate','maybe','reject') NOT NULL DEFAULT 'reject',
	`category` varchar(128),
	`viralReason` text,
	`viralTriggers` json,
	`overrideScore` int,
	`overrideLabel` enum('must_post','strong_candidate','maybe','reject'),
	`isDuplicate` boolean NOT NULL DEFAULT false,
	`duplicateOf` int,
	`approvalStatus` enum('pending','approved','rejected','edited','dismissed') NOT NULL DEFAULT 'pending',
	`scoringMethod` enum('rule_based','llm_assisted') NOT NULL DEFAULT 'rule_based',
	`processedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `stories_id` PRIMARY KEY(`id`),
	CONSTRAINT `stories_sourceUrl_unique` UNIQUE(`sourceUrl`)
);
--> statement-breakpoint
CREATE TABLE `story_packages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`storyId` int NOT NULL,
	`soyunciArticle` text,
	`hashtags` json,
	`imageRecommendations` json,
	`imageCandidates` json,
	`allHeadlines` json,
	`topThreeHeadlines` json,
	`selectedHeadline` text,
	`canvaHeadline` text,
	`canvaAspectRatio` varchar(32),
	`canvaVisualIdea` text,
	`canvaAircraftToShow` text,
	`canvaMood` varchar(128),
	`canvaBackground` text,
	`canvaHierarchy` text,
	`canvaCircleInsert` text,
	`processingStatus` enum('queued','processing','complete','failed') NOT NULL DEFAULT 'queued',
	`processingError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`soyunci_rating` varchar(20),
	`soyunci_feedback_note` text,
	`researchContext` text,
	`viralAngle` text,
	`extractedFacts` text,
	`alternativeHeadlines` text,
	`sourcesResearched` int DEFAULT 0,
	CONSTRAINT `story_packages_id` PRIMARY KEY(`id`),
	CONSTRAINT `story_packages_storyId_unique` UNIQUE(`storyId`)
);
--> statement-breakpoint
CREATE TABLE `weekly_digests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`weekStart` timestamp NOT NULL,
	`weekEnd` timestamp NOT NULL,
	`storiesApproved` int NOT NULL DEFAULT 0,
	`topCategory` varchar(128),
	`topStoryTitle` text,
	`topStoryScore` int,
	`summary` text NOT NULL,
	`recommendations` text NOT NULL,
	`rawData` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `weekly_digests_id` PRIMARY KEY(`id`)
);
