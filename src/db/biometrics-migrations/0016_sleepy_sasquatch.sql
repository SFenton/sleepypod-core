CREATE TABLE `adaptive_occupancy_state` (
	`side` text PRIMARY KEY NOT NULL,
	`sample_timestamp` integer NOT NULL,
	`load_present` integer NOT NULL,
	`classification` text NOT NULL,
	`person_present` integer,
	`score` real NOT NULL,
	`peak_score` real NOT NULL,
	`loaded_channels` integer NOT NULL,
	`load_velocity_score` real NOT NULL,
	`unload_velocity_score` real NOT NULL,
	`entry_velocity_supported` integer NOT NULL,
	`reason` text NOT NULL,
	`baseline` text NOT NULL,
	`last_transition_at` integer,
	`algorithm_version` text NOT NULL,
	`updated_at` integer NOT NULL
);
