/**
 * Task 206 — Regressões de escopo por empresa gestora nos consumidores de categoria.
 *
 * Cenário-alvo: um médico com vínculos remanescentes em DUAS empresas (52 e 4).
 * - provisionAddressServices (SlotSync) NÃO pode provisionar serviço de mapping da outra empresa.
 * - syncServicesDelta (PushSync) NÃO pode empurrar serviço de mapping da outra empresa.
 */
import { SlotSyncService } from './slot-sync.service';
import { PushSyncService } from './push-sync.service';

const specOwn = {
    id: 'spec-own', vismedId: 3484, idEmpresaGestora: 52, name: 'Fonoaudiologia',
    mappings: [{ id: 'map-own', doctoraliaService: { doctoraliaServiceId: '111', name: 'Fono Consulta', normalizedName: 'fono consulta' } }],
};
const specForeign = {
    id: 'spec-foreign', vismedId: 192, idEmpresaGestora: 4, name: 'Fonoaudiologia',
    mappings: [{ id: 'map-foreign', doctoraliaService: { doctoraliaServiceId: '222', name: 'Fono Estrangeira', normalizedName: 'fono estrangeira' } }],
};
const doctor = {
    id: 'vd-1', name: 'DRA. DUPLA',
    specialties: [{ specialty: specOwn }, { specialty: specForeign }],
};

describe('Task 206 — provisionAddressServices escopado por empresa', () => {
    function makeSlotSync() {
        const svc: any = Object.create(SlotSyncService.prototype);
        svc.logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
        svc.prisma = {
            specialtyServiceMapping: { count: jest.fn(async () => 0) },
            doctoraliaService: { findMany: jest.fn(async () => []) },
            doctoraliaAddressService: { findMany: jest.fn(async () => []), upsert: jest.fn(async () => ({})) },
        };
        svc.resolveFacilityCatalogIds = jest.fn(async () => null);
        svc.logEvent = jest.fn(async () => undefined);
        svc.markMappingInvalid = jest.fn(async () => undefined);
        const client: any = {
            addAddressService: jest.fn(async () => ({ id: 9001 })),
            getCacheIdentity: jest.fn(() => 'test'),
        };
        return { svc, client };
    }

    it('médico em duas empresas: só o serviço da empresa da clínica (52) é provisionado', async () => {
        const { svc, client } = makeSlotSync();
        const result = await svc.provisionAddressServices({ ...doctor, specialties: [...doctor.specialties] }, client, 'fac-1', 'doc-1', 'addr-1', undefined, 52);
        expect(client.addAddressService).toHaveBeenCalledTimes(1);
        expect(client.addAddressService.mock.calls[0][3].service_id).toBe(111);
        expect(result).toHaveLength(1);
    });

    it('empresa 4: só o serviço da empresa 4 é provisionado', async () => {
        const { svc, client } = makeSlotSync();
        await svc.provisionAddressServices({ ...doctor, specialties: [...doctor.specialties] }, client, 'fac-1', 'doc-1', 'addr-1', undefined, 4);
        expect(client.addAddressService).toHaveBeenCalledTimes(1);
        expect(client.addAddressService.mock.calls[0][3].service_id).toBe(222);
    });
});

describe('Task 206 — syncServicesDelta escopado por empresa', () => {
    function makePushSync() {
        const svc: any = Object.create(PushSyncService.prototype);
        svc.logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
        svc.prisma = {
            specialtyServiceMapping: { findMany: jest.fn(async () => []) },
            doctoraliaAddressService: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
        };
        svc.stableCache = {
            getOrFetch: jest.fn(async (_k: string, _t: number, fn: any) => fn()),
            invalidate: jest.fn(),
        };
        svc.logEvent = jest.fn(async () => undefined);
        svc.markMappingInvalid = jest.fn(async () => undefined);
        const client: any = {
            getServices: jest.fn(async () => ({ _items: [] })),
            addAddressService: jest.fn(async () => ({ id: 9002 })),
            deleteAddressService: jest.fn(async () => ({})),
            getCacheIdentity: jest.fn(() => 'test'),
        };
        return { svc, client };
    }

    it('médico em duas empresas: só o dict_id da empresa 52 entra no push', async () => {
        const { svc, client } = makePushSync();
        await svc.syncServicesDelta('run-1', client, 'fac-1', 'doc-1', 'addr-1', doctor.specialties, 'DRA. DUPLA', null, undefined, 52);
        expect(client.addAddressService).toHaveBeenCalledTimes(1);
        expect(client.addAddressService.mock.calls[0][3].service_id).toBe(111);
    });

    it('serviço estrangeiro pré-existente na Doctoralia NÃO é mantido como esperado (não vira expected)', async () => {
        const { svc, client } = makePushSync();
        // Endereço já tem o serviço da empresa 4 — expected só contém o da 52.
        client.getServices = jest.fn(async () => ({ _items: [{ id: 555, service_id: 222 }] }));
        await svc.syncServicesDelta('run-1', client, 'fac-1', 'doc-1', 'addr-1', doctor.specialties, 'DRA. DUPLA', null, undefined, 52);
        expect(client.addAddressService).toHaveBeenCalledTimes(1);
        expect(client.addAddressService.mock.calls[0][3].service_id).toBe(111);
        // O delta considera o 222 "não esperado" (deleção segue as SAFETYs existentes).
        expect(client.addAddressService.mock.calls.some((c: any[]) => c[3].service_id === 222)).toBe(false);
    });
});
