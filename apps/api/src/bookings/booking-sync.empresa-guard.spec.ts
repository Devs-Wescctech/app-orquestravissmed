/**
 * Task 206 — Guarda de consistência de empresa gestora em buildVismedCreatePayload.
 *
 * A categoria (idcategoriaservico) escolhida DEVE pertencer ao catálogo da mesma
 * empresa gestora enviada em idempresagestora. Divergência → NÃO faz o POST, erro claro.
 */
import { BookingSyncService } from './booking-sync.service';

function buildService(overrides: {
    connClientId?: string;
    doctorSpecialties?: any[];
    specMapping?: any;
    addrService?: any;
}) {
    const svc: any = Object.create(BookingSyncService.prototype);
    svc.logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    svc.vismedService = { getCreateAppointmentUrl: jest.fn(() => 'http://vismed/create') };
    svc.prisma = {
        integrationConnection: {
            findFirst: jest.fn(async () => ({ clientId: overrides.connClientId ?? '52', domain: null })),
        },
        vismedDoctor: {
            findUnique: jest.fn(async () => ({
                id: 'doc-1',
                vismedId: 9001,
                name: 'DRA. PETRO',
                specialties: (overrides.doctorSpecialties ?? []).map(s => ({ specialty: s })),
            })),
        },
        doctoraliaAddressService: {
            findUnique: jest.fn(async () => overrides.addrService ?? null),
        },
        specialtyServiceMapping: {
            findFirst: jest.fn(async () => overrides.specMapping ?? null),
        },
    };
    return svc;
}

const booking = {
    id: 228750781,
    start_at: '2026-08-20T14:00:00-03:00',
    patient: { name: 'Paciente', surname: 'Teste' },
};

describe('Task 206 — guarda de empresa gestora no payload VisMed', () => {
    it('usa a categoria da própria empresa (fallback do médico) e passa na guarda', async () => {
        const svc = buildService({
            connClientId: '52',
            doctorSpecialties: [
                // Vínculo cruzado remanescente (empresa 4) deve ser IGNORADO pelo filtro
                { id: 's-192', vismedId: 192, idEmpresaGestora: 4, name: 'Fonoaudiologia' },
                { id: 's-3484', vismedId: 3484, idEmpresaGestora: 52, name: 'Fonoaudiologia' },
            ],
        });
        const { payload } = await svc.buildVismedCreatePayload('clinic-petro', { vismedId: 'doc-1' }, booking);
        expect(payload.idcategoriaservico).toBe(3484);
        expect(payload.idempresagestora).toBe(52);
    });

    it('bloqueia o POST quando a categoria escolhida pertence a outra empresa (divergência)', async () => {
        // Mapping aprovado apontando (indevidamente) para categoria da empresa 4.
        const svc = buildService({
            connClientId: '52',
            doctorSpecialties: [
                { id: 's-3484', vismedId: 3484, idEmpresaGestora: 52, name: 'Fonoaudiologia' },
            ],
            addrService: { serviceId: 'srv-1' },
            specMapping: {
                vismedSpecialty: { id: 's-192', vismedId: 192, idEmpresaGestora: 4, name: 'Fonoaudiologia' },
            },
        });
        const bookingComServico = { ...booking, address_service: { id: 777 } };
        await expect(
            svc.buildVismedCreatePayload('clinic-petro', { vismedId: 'doc-1' }, bookingComServico),
        ).rejects.toThrow(/Guarda de consistência/);
    });

    it('falha com erro claro quando o médico só tem categorias de outra empresa', async () => {
        const svc = buildService({
            connClientId: '52',
            doctorSpecialties: [
                { id: 's-192', vismedId: 192, idEmpresaGestora: 4, name: 'Fonoaudiologia' },
            ],
        });
        await expect(
            svc.buildVismedCreatePayload('clinic-petro', { vismedId: 'doc-1' }, booking),
        ).rejects.toThrow(/não possui especialidade .* empresa gestora 52/);
    });
});
