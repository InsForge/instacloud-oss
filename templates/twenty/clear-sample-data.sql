-- Twenty prefills every workspace it activates with example records: five companies (Airbnb,
-- Anthropic, Stripe, Figma, Notion), five people, six opportunities and a dashboard, every one of
-- them written as `createdBySource = 'SYSTEM'`. It is unconditional in v2.41.0 —
-- `WorkspaceService.activateWorkspace` calls `prefillCreatedWorkspaceRecords` with no flag in
-- front of it — and upstream gets away with it because the person who creates the workspace is
-- the person who just asked for a demo. Here the deploy creates the workspace, so the operator's
-- first login lands in somebody else's sample CRM instead of an empty one.
--
-- This removes exactly those rows. The `SYSTEM` filter is the guard: it cannot reach a record a
-- person typed, which is `MANUAL`. Set `SAMPLE_DATA` on the deploy to keep them instead.
--
-- The two prefilled workflows are deliberately NOT removed. They belong to Twenty's own
-- pre-installed apps, which also register a "Quick Lead" entry in the command menu pointing at
-- the workflow by id: deleting the record leaves that entry answering "Record not found", which
-- is a worse first impression than an automation the operator did not ask for. They are
-- automations rather than CRM records, and they are visible and deletable in the UI.
--
-- :schema is the one workspace schema, passed by entrypoint.sh, which is also the only thing that
-- runs this and only on the boot that created the workspace.
BEGIN;

DELETE FROM :"schema"."opportunity" WHERE "createdBySource" = 'SYSTEM';
DELETE FROM :"schema"."person" WHERE "createdBySource" = 'SYSTEM';
DELETE FROM :"schema"."company" WHERE "createdBySource" = 'SYSTEM';
DELETE FROM :"schema"."dashboard" WHERE "createdBySource" = 'SYSTEM';

-- The timeline entries the prefill left behind, which are what a record page shows under
-- "Timeline". Unfiltered because nothing else has happened on this instance: this runs seconds
-- after the workspace was created and before anyone has the URL.
DELETE FROM :"schema"."timelineActivity";

COMMIT;

-- What the entrypoint logs. Zero unless upstream prefilled something this file does not know
-- about, which is the case worth seeing in the log rather than guessing at from the UI.
SELECT (SELECT count(*) FROM :"schema"."company" WHERE "createdBySource" = 'SYSTEM')
     + (SELECT count(*) FROM :"schema"."person" WHERE "createdBySource" = 'SYSTEM')
     + (SELECT count(*) FROM :"schema"."opportunity" WHERE "createdBySource" = 'SYSTEM')
     + (SELECT count(*) FROM :"schema"."dashboard" WHERE "createdBySource" = 'SYSTEM');
