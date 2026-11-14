-- Preserve existing Jev settings when upgrading to the generic decision interface.
-- Explicit generic settings (including cleared values) always take precedence.
INSERT INTO app_settings (key, value)
SELECT replacement.key, replacement.value
FROM (
  SELECT 'decision_key' AS key, value FROM app_settings WHERE key = 'typesafe_key' AND trim(value) <> ''
  UNION ALL
  SELECT 'decision_endpoint', 'https://api.typesafe.ai/v1/systemone'
  UNION ALL
  SELECT 'decision_model', COALESCE(NULLIF((SELECT value FROM app_settings WHERE key = 'typesafe_model'), ''), 'jev-latest')
) AS replacement
WHERE EXISTS (SELECT 1 FROM app_settings WHERE key = 'typesafe_key' AND trim(value) <> '')
  AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key IN ('decision_key', 'decision_endpoint', 'decision_model'));
