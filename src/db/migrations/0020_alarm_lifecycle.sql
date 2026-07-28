ALTER TABLE `device_state` ADD `alarm_state` text NOT NULL DEFAULT 'idle';--> statement-breakpoint
ALTER TABLE `device_state` ADD `alarm_occurrence_id` text;--> statement-breakpoint
ALTER TABLE `device_state` ADD `alarm_schedule_id` integer;--> statement-breakpoint
ALTER TABLE `device_state` ADD `alarm_scheduled_for` integer;--> statement-breakpoint
ALTER TABLE `device_state` ADD `alarm_snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `device_state` ADD `alarm_ringing_until` integer;--> statement-breakpoint
ALTER TABLE `device_state` ADD `alarm_vibration_intensity` integer;--> statement-breakpoint
ALTER TABLE `device_state` ADD `alarm_vibration_pattern` text;--> statement-breakpoint
ALTER TABLE `device_state` ADD `alarm_duration` integer;--> statement-breakpoint
UPDATE `device_state`
SET
  `is_alarm_vibrating` = 0,
  `alarm_state` = 'idle',
  `alarm_occurrence_id` = NULL,
  `alarm_scheduled_for` = NULL;
