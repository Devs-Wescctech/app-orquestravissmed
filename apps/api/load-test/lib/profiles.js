'use strict';
/**
 * Perfis de carga do dataset sintético (WP-12A).
 * `changeRatePct` = % de entidades que mudam entre ciclos (reservado p/ 12B/12C;
 * no Cenário A o dataset é estável entre janelas para validar o skip incremental).
 */
const PROFILES = {
    small: {
        name: 'small',
        doctorsPerClinic: 2,
        addressesPerDoctor: 1,
        servicesPerAddress: 1,
        specialtiesPerClinic: 2,
        insurancesPerClinic: 1,
        doctoraliaBookingsPerDoctor: 1,
        vismedAppointmentsPerUnit: 1,
        breaksPerClinic: 0,
        slotDaysAhead: 7,
        slotsPerDay: 4,
        changeRatePct: 0,
    },
    medium: {
        name: 'medium',
        doctorsPerClinic: 5,
        addressesPerDoctor: 1,
        servicesPerAddress: 2,
        specialtiesPerClinic: 3,
        insurancesPerClinic: 2,
        doctoraliaBookingsPerDoctor: 2,
        vismedAppointmentsPerUnit: 3,
        breaksPerClinic: 1,
        slotDaysAhead: 14,
        slotsPerDay: 8,
        changeRatePct: 0,
    },
    heavy: {
        name: 'heavy',
        doctorsPerClinic: 12,
        addressesPerDoctor: 2,
        servicesPerAddress: 3,
        specialtiesPerClinic: 5,
        insurancesPerClinic: 4,
        doctoraliaBookingsPerDoctor: 4,
        vismedAppointmentsPerUnit: 8,
        breaksPerClinic: 3,
        slotDaysAhead: 30,
        slotsPerDay: 12,
        changeRatePct: 0,
    },
};

const SCENARIOS = {
    a: { name: 'a', clinics: 2, globalSyncWindows: 2, description: 'Baseline: 2 clínicas, ≥2 janelas de global sync + polling/sweep/slot' },
    // WP-12B — mesma estrutura do Cenário A (janelas de global sync + polling/
    // sweep/slot), apenas parametrizando a escala de clínicas. 50 é marco de
    // teste, não limite arquitetural.
    b: { name: 'b', clinics: 10, globalSyncWindows: 2, description: 'Escala B: 10 clínicas, mesma estrutura do baseline A' },
    c: { name: 'c', clinics: 20, globalSyncWindows: 2, description: 'Escala C: 20 clínicas, mesma estrutura do baseline A' },
    d: { name: 'd', clinics: 50, globalSyncWindows: 2, description: 'Escala D: 50 clínicas, mesma estrutura do baseline A (marco de teste, não limite)' },
    // WP-13 — cenários de fault injection: 10 clínicas / medium, janela saudável
    // T0 antes da falha e janela final de sync saudável após a recuperação.
    // `fault` referencia o plano determinístico em lib/fault-plans.js.
    f1: { name: 'f1', clinics: 10, globalSyncWindows: 1, fault: 'f1', description: 'WP-13 F1: 429 intermitente (A, breaker CLOSED) + sustentado (B, breaker abre)' },
    f2: { name: 'f2', clinics: 10, globalSyncWindows: 1, fault: 'f2', description: 'WP-13 F2: 503 sustentado, falha da 1ª probe, cooldown progressivo' },
    f3: { name: 'f3', clinics: 10, globalSyncWindows: 1, fault: 'f3', description: 'WP-13 F3: timeout >30s sem resposta (AbortController + breaker)' },
    f4: { name: 'f4', clinics: 10, globalSyncWindows: 1, fault: 'f4', description: 'WP-13 F4: WAF 405+captcha em GET comum e no OAuth (cooldown ≥5min)' },
    f5: { name: 'f5', clinics: 10, globalSyncWindows: 1, fault: 'f5', description: 'WP-13 F5: API lenta sem erro (<30s) — backpressure WP-08B' },
};

module.exports = { PROFILES, SCENARIOS };
