ALTER TABLE `cover_button_actions` ADD `feedback_vibration_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cover_button_actions` ADD `feedback_vibration_intensity` integer;--> statement-breakpoint
ALTER TABLE `cover_button_actions` ADD `feedback_vibration_pattern` text;--> statement-breakpoint
ALTER TABLE `cover_button_actions` ADD `feedback_vibration_duration` integer;--> statement-breakpoint
ALTER TABLE `tap_gestures` ADD `feedback_vibration_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tap_gestures` ADD `feedback_vibration_intensity` integer;--> statement-breakpoint
ALTER TABLE `tap_gestures` ADD `feedback_vibration_pattern` text;--> statement-breakpoint
ALTER TABLE `tap_gestures` ADD `feedback_vibration_duration` integer;