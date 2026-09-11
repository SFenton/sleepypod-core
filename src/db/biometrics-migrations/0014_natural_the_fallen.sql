CREATE TABLE `piezo_presence_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`timestamp` integer NOT NULL,
	`present` integer NOT NULL,
	`med_std` real NOT NULL,
	`autocorrelation_quality` real NOT NULL,
	`enter_threshold` real NOT NULL,
	`exit_threshold` real NOT NULL,
	`threshold_source` text NOT NULL,
	`decision_reason` text NOT NULL,
	`cap_present` integer,
	`cap_age_seconds` real,
	`other_side_med_std` real,
	`other_side_autocorrelation_quality` real,
	`pump_mode` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_piezo_presence_side_timestamp` ON `piezo_presence_decisions` (`side`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_piezo_presence_timestamp` ON `piezo_presence_decisions` (`timestamp`);