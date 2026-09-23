-- Read-only inventory. Run on the Orquestrador PostgreSQL database after
-- verifying the target environment. Never use this output alone to DELETE.
BEGIN TRANSACTION READ ONLY;

WITH candidates AS (
  SELECT
    b."id" AS booking_id,
    b."createdAt" AS created_at_utc,
    b."clinicId" AS clinic_id,
    b."vismedAppointmentId" AS vismed_appointment_id,
    b."doctoraliaBreakId" AS break_id,
    b."doctoraliaFacilityId" AS facility_id,
    b."doctoraliaDoctorId" AS doctor_id,
    b."doctoraliaAddressId" AS address_id,
    b."startAt" AS starts_at_utc,
    b."endAt" AS ends_at_utc,
    b."status" AS booking_status,
    lower(btrim(b."rawPayload"->>'tipo_servico')) AS stored_type,
    (
      SELECT count(*)
      FROM "BookingSync" other
      WHERE other."doctoraliaBreakId" = b."doctoraliaBreakId"
    ) AS association_count,
    (
      SELECT count(*)
      FROM "BookingSync" other
      WHERE other."id" <> b."id"
        AND other."clinicId" = b."clinicId"
        AND other."doctoraliaDoctorId" = b."doctoraliaDoctorId"
        AND other."doctoraliaAddressId" = b."doctoraliaAddressId"
        AND other."status" IN ('BOOKED', 'CONFIRMED')
        AND other."startAt" < b."endAt"
        AND other."endAt" > b."startAt"
    ) AS active_overlap_count,
    receipt."details"->>'state' AS receipt_state,
    receipt."details"->>'breakId' AS receipt_break_id,
    receipt."details"->>'clinicId' AS receipt_clinic_id,
    receipt."details"->>'facilityId' AS receipt_facility_id,
    receipt."details"->>'doctorId' AS receipt_doctor_id,
    receipt."details"->>'addressId' AS receipt_address_id
  FROM "BookingSync" b
  LEFT JOIN "AuditLog" receipt
    ON receipt."id" = 'calendar-break:' || b."id"
   AND receipt."action" = 'CALENDAR_BREAK_CREATION'
   AND receipt."entityId" = b."id"
  WHERE b."origin" = 'VISMED'
    AND b."status" IN ('BOOKED', 'CONFIRMED')
    AND b."doctoraliaBreakId" IS NOT NULL
    AND b."endAt" > (now() AT TIME ZONE 'UTC')
    AND lower(btrim(b."rawPayload"->>'tipo_servico')) IN ('exame', 'procedimento')
)
SELECT
  booking_id, created_at_utc, clinic_id, vismed_appointment_id, stored_type,
  booking_status, starts_at_utc, ends_at_utc,
  break_id, facility_id, doctor_id, address_id,
  association_count, active_overlap_count, receipt_state,
  CASE
    WHEN facility_id IS NULL OR doctor_id IS NULL OR address_id IS NULL
      OR vismed_appointment_id IS NULL THEN 'REVIEW_MISSING_SCOPE'
    WHEN association_count <> 1 THEN 'REVIEW_SHARED_BREAK'
    WHEN active_overlap_count <> 0 THEN 'REVIEW_OVERLAP'
    WHEN receipt_state <> 'OWNED' OR receipt_state IS NULL
      OR receipt_break_id IS DISTINCT FROM break_id
      OR receipt_clinic_id IS DISTINCT FROM clinic_id
      OR receipt_facility_id IS DISTINCT FROM facility_id
      OR receipt_doctor_id IS DISTINCT FROM doctor_id
      OR receipt_address_id IS DISTINCT FROM address_id THEN 'REVIEW_PROVENANCE'
    ELSE 'CHECK_FRESH_SOURCE_AND_REMOTE'
  END AS next_check
FROM candidates
ORDER BY clinic_id, starts_at_utc, booking_id;

ROLLBACK;
