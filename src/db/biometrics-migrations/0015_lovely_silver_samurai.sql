CREATE TABLE `piezo_transition_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`transition_timestamp` integer NOT NULL,
	`sample_timestamp` integer NOT NULL,
	`sample_offset_seconds` integer NOT NULL,
	`cap_present` integer NOT NULL,
	`piezo_present` integer NOT NULL,
	`filtered_std` real NOT NULL,
	`raw_peak_to_peak` real NOT NULL,
	`autocorrelation_quality` real NOT NULL,
	`enter_threshold` real NOT NULL,
	`exit_threshold` real NOT NULL,
	`threshold_source` text NOT NULL,
	`other_side_filtered_std` real,
	`other_side_autocorrelation_quality` real,
	`pump_mode` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_piezo_transition_side_ts_offset` ON `piezo_transition_snapshots` (`side`,`transition_timestamp`,`sample_offset_seconds`);--> statement-breakpoint
CREATE INDEX `idx_piezo_transition_timestamp` ON `piezo_transition_snapshots` (`transition_timestamp`);--> statement-breakpoint
CREATE INDEX `idx_piezo_transition_side_timestamp` ON `piezo_transition_snapshots` (`side`,`transition_timestamp`);