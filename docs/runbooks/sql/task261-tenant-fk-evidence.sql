-- Task 261 PostgreSQL FK evidence. Run only against a disposable database.
-- This transaction creates no durable rows and proves cross-clinic writes fail.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO "Clinic" ("id", "name", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000261', 'Task 261 FK A', now()),
       ('00000000-0000-4000-8000-000000000262', 'Task 261 FK B', now());
INSERT INTO "IntegrationConnection" ("id", "clinicId", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000263',
        '00000000-0000-4000-8000-000000000261', now());

DO $$
BEGIN
  BEGIN
    INSERT INTO "DoctoraliaCatalogGeneration"
      ("id", "clinicId", "connectionId", "catalogScopeVersion", "facilityCount", "doctorCount", "expiresAt")
    VALUES ('00000000-0000-4000-8000-000000000264',
      '00000000-0000-4000-8000-000000000262',
      '00000000-0000-4000-8000-000000000263', 1, 0, 0, now() + interval '30 minutes');
    RAISE EXCEPTION 'cross-clinic generation was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "DoctoraliaCatalogLease"
      ("connectionId", "clinicId", "owner", "expiresAt", "updatedAt")
    VALUES ('00000000-0000-4000-8000-000000000263',
      '00000000-0000-4000-8000-000000000262', 'evidence', now() + interval '1 minute', now());
    RAISE EXCEPTION 'cross-clinic lease was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  RAISE NOTICE 'Task 261 composite tenant FK checks rejected both cross-clinic writes';
END $$;
ROLLBACK;