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
};

module.exports = { PROFILES, SCENARIOS };
