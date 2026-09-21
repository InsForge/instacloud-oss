-- Twenty prefills every workspace it activates with example records: five companies (Airbnb,
-- Anthropic, Stripe, Figma, Notion), five people, six opportunities, a dashboard and two
-- workflows, every one of them written as `createdBySource = 'SYSTEM'`. It is unconditional in
-- v2.41.0 — `WorkspaceService.activateWorkspace` calls `prefillCreatedWorkspaceRecords` with no
-- flag in front of it — and upstream gets away with it because the person who creates the
-- workspace is the person who just asked for a demo. Here the deploy creates the workspace, so
-- the operator's first login lands in somebody else's sample CRM instead of an empty one.
--
-- This removes exactly those rows. The `SYSTEM` filter is the guard: it cannot reach a record a
-- person typed, which is `MANUAL`. Set `SAMPLE_DATA` on the deploy to keep them instead.
--
-- :schema is the one workspace schema, passed by entrypoint.sh, which is also the only thing that
-- runs this and only on the boot that created the workspace.
BEGIN;

DELETE FROM :"schema"."workflowAutomatedTrigger" t
      USING :"schema"."workflow" w
      WHERE t."workflowId" = w."id" AND w."createdBySource" = 'SYSTEM';

DELETE FROM :"schema"."workflowVersion" v
      USING :"schema"."workflow" w
      WHERE v."workflowId" = w."id" AND w."createdBySource" = 'SYSTEM';

DELETE FROM :"schema"."workflow" WHERE "createdBySource" = 'SYSTEM';
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
     + (SELECT count(*) FROM :"schema"."workflow" WHERE "createdBySource" = 'SYSTEM')
     + (SELECT count(*) FROM :"schema"."dashboard" WHERE "createdBySource" = 'SYSTEM');
