CREATE TABLE `cover_button_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`side` text NOT NULL,
	`button` text NOT NULL,
	`action_type` text NOT NULL,
	`temperature_change` text,
	`temperature_amount` integer,
	`power_behavior` text,
	`alarm_behavior` text,
	`alarm_snooze_duration` integer,
	`alarm_inactive_behavior` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_cover_button_side_button` ON `cover_button_actions` (`side`,`button`);
--> statement-breakpoint
INSERT INTO `cover_button_actions`
  (`side`, `button`, `action_type`, `temperature_change`, `temperature_amount`, `power_behavior`, `alarm_behavior`, `alarm_snooze_duration`, `alarm_inactive_behavior`)
VALUES
  ('left', 'top', 'temperature', 'increment', 1, NULL, NULL, NULL, NULL),
  ('left', 'middle', 'power', NULL, NULL, 'toggle', NULL, NULL, NULL),
  ('left', 'bottom', 'temperature', 'decrement', 1, NULL, NULL, NULL, NULL),
  ('right', 'top', 'temperature', 'increment', 1, NULL, NULL, NULL, NULL),
  ('right', 'middle', 'power', NULL, NULL, 'toggle', NULL, NULL, NULL),
  ('right', 'bottom', 'temperature', 'decrement', 1, NULL, NULL, NULL, NULL);