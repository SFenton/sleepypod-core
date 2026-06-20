INSERT INTO `tap_gestures` (
  `side`,
  `button`,
  `tap_type`,
  `action_type`,
  `temperature_change`,
  `temperature_amount`,
  `alarm_behavior`,
  `alarm_snooze_duration`,
  `alarm_inactive_behavior`,
  `power_behavior`,
  `feedback_vibration_enabled`,
  `feedback_vibration_intensity`,
  `feedback_vibration_pattern`,
  `feedback_vibration_duration`,
  `created_at`,
  `updated_at`
)
SELECT
  `side`,
  `button`,
  'doubleTap',
  `action_type`,
  `temperature_change`,
  `temperature_amount`,
  `alarm_behavior`,
  `alarm_snooze_duration`,
  `alarm_inactive_behavior`,
  `power_behavior`,
  `feedback_vibration_enabled`,
  `feedback_vibration_intensity`,
  `feedback_vibration_pattern`,
  `feedback_vibration_duration`,
  `created_at`,
  unixepoch()
FROM `tap_gestures`
WHERE `button` IN ('top', 'bottom')
  AND `tap_type` = 'singleTap'
ON CONFLICT(`side`, `button`, `tap_type`) DO NOTHING;--> statement-breakpoint
INSERT INTO `tap_gestures` (
  `side`,
  `button`,
  `tap_type`,
  `action_type`,
  `temperature_change`,
  `temperature_amount`
)
VALUES
  ('left', 'top', 'doubleTap', 'temperature', 'increment', 1),
  ('left', 'bottom', 'doubleTap', 'temperature', 'decrement', 1),
  ('right', 'top', 'doubleTap', 'temperature', 'increment', 1),
  ('right', 'bottom', 'doubleTap', 'temperature', 'decrement', 1)
ON CONFLICT(`side`, `button`, `tap_type`) DO NOTHING;--> statement-breakpoint
DELETE FROM `tap_gestures`
WHERE `button` IN ('top', 'middle', 'bottom')
  AND (`button` = 'middle' OR `tap_type` <> 'doubleTap');
