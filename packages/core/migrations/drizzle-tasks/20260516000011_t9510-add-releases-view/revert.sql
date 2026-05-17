-- Revert T9510 migration: drop releases_view.
-- The view holds no data — dropping it has no data-loss risk.
--
-- @task T9510

DROP VIEW IF EXISTS `releases_view`;
