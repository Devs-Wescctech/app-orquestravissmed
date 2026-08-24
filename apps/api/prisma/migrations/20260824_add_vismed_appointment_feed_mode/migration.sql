-- Modo futuro do feed de agendamentos VisMed por conexão.
-- A coluna é deliberadamente nullable: esta migration não faz backfill,
-- não atualiza conexões existentes e não habilita o contrato incremental.
ALTER TABLE "IntegrationConnection"
    ADD COLUMN IF NOT EXISTS "vismedAppointmentFeedMode" TEXT;