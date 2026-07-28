ALTER TABLE `tap_gestures` ADD `temperature_step_mode` text DEFAULT 'level';--> statement-breakpoint
ALTER TABLE `cover_button_actions` ADD `temperature_step_mode` text DEFAULT 'level';--> statement-breakpoint
UPDATE `tap_gestures`
SET `temperature_step_mode` = 'level'
WHERE `action_type` = 'temperature'
  AND `button` IN ('top', 'bottom')
  AND `tap_type` = 'doubleTap';--> statement-breakpoint
UPDATE `cover_button_actions`
SET `temperature_step_mode` = 'level'
WHERE `action_type` = 'temperature'
  AND `button` IN ('top', 'bottom');--> statement-breakpoint
UPDATE `tap_gestures`
SET `temperature_step_mode` = NULL
WHERE `action_type` <> 'temperature';--> statement-breakpoint
UPDATE `cover_button_actions`
SET `temperature_step_mode` = NULL
WHERE `action_type` <> 'temperature';
