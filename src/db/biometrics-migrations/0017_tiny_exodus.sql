CREATE TABLE `eol_occupancy_state` (
	`side` text PRIMARY KEY NOT NULL,
	`sample_timestamp` integer NOT NULL,
	`state` text NOT NULL,
	`occupied` integer NOT NULL,
	`confirmed` integer NOT NULL,
	`degraded` integer NOT NULL,
	`state_since` integer,
	`last_event` text,
	`last_event_at` integer,
	`load_above_reference` real,
	`mv60` real,
	`e20_own` real,
	`e20_partner` real,
	`algorithm_version` text NOT NULL,
	`updated_at` integer NOT NULL
);
