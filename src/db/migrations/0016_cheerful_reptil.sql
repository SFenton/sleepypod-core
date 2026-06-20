DROP INDEX `uq_tap_side_type`;--> statement-breakpoint
ALTER TABLE `tap_gestures` ADD `button` text DEFAULT 'surface' NOT NULL;--> statement-breakpoint
ALTER TABLE `tap_gestures` ADD `power_behavior` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tap_side_button_type` ON `tap_gestures` (`side`,`button`,`tap_type`);--> statement-breakpoint
INSERT OR IGNORE INTO `tap_gestures`
  (`side`, `button`, `tap_type`, `action_type`, `temperature_change`, `temperature_amount`, `alarm_behavior`, `alarm_snooze_duration`, `alarm_inactive_behavior`, `power_behavior`, `created_at`, `updated_at`)
SELECT
  `side`, `button`, 'singleTap', `action_type`, `temperature_change`, `temperature_amount`, `alarm_behavior`, `alarm_snooze_duration`, `alarm_inactive_behavior`, `power_behavior`, `created_at`, `updated_at`
FROM `cover_button_actions`;