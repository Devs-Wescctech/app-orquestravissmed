import { ClinicsService } from '../clinics/clinics.service';
import { BookingSyncService } from './booking-sync.service';

/**
 * Transições de status da IntegrationConnection (caso Petrópolis/LEANDRO):
 * - teste de conexão falho NÃO rebaixa uma conexão 'connected' em uso;
 * - conexão 'error' com credenciais continua elegível para polling;
 * - conexão 'disconnected' deixa de ser polled mesmo com timer já instalado.
 */
describe('IntegrationConnection status gate', () => {
    describe('ClinicsService.testIntegration (falha)', () => {
        function makeService(conn: any) {
            const prisma: any = {
                integrationConnection: {
                    findFirst: jest.fn().mockResolvedValue(conn),
                    update: jest.fn().mockResolvedValue(conn),
                },
            };
            const docplanner: any = {
                createClient: jest.fn().mockReturnValue({
                    getFacilities: jest.fn().mockRejectedValue(new Error('WAF challenge')),
                }),
            };
            const vismed: any = {
                getUnidades: jest.fn().mockRejectedValue(new Error('timeout')),
            };
            return { service: new ClinicsService(prisma, docplanner, vismed), prisma };
        }

        it('mantém status connected quando o teste falha em conexão em uso', async () => {
            const { service, prisma } = makeService({
                id: 'c1', clinicId: 'cl1', status: 'connected', clientId: 'id', clientSecret: 's', domain: null,
            });
            const res = await service.testIntegration('cl1');
            expect(res.success).toBe(false);
            const data = prisma.integrationConnection.update.mock.calls[0][0].data;
            expect(data.status).toBeUndefined();
            expect(data.lastTestAt).toBeInstanceOf(Date);
        });

        it('rebaixa para error quando a conexão não estava connected', async () => {
            const { service, prisma } = makeService({
                id: 'c1', clinicId: 'cl1', status: 'disconnected', clientId: 'id', clientSecret: 's', domain: null,
            });
            await service.testIntegration('cl1');
            expect(prisma.integrationConnection.update.mock.calls[0][0].data.status).toBe('error');
        });

        it('VisMed: mantém status connected quando o teste falha em conexão em uso', async () => {
            const { service, prisma } = makeService({
                id: 'v1', clinicId: 'cl1', status: 'connected', clientId: '42', domain: null,
            });
            const res = await service.testVismedIntegration('cl1');
            expect(res.success).toBe(false);
            expect(prisma.integrationConnection.update.mock.calls[0][0].data.status).toBeUndefined();
        });
    });

    describe('BookingSyncService revalidação por tick (getEligibleConnection)', () => {
        function callGate(freshConn: any) {
            const fakeThis: any = {
                prisma: {
                    integrationConnection: { findFirst: jest.fn().mockResolvedValue(freshConn) },
                },
                logger: { warn: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() },
            };
            const fn = (BookingSyncService.prototype as any).getEligibleConnection;
            return { result: fn.call(fakeThis, 'cl1', 'doctoralia'), fakeThis };
        }

        it("conexão com status 'error' e credenciais continua elegível", async () => {
            const conn = { clinicId: 'cl1', status: 'error', clientId: 'id' };
            const { result } = callGate(conn);
            await expect(result).resolves.toBe(conn);
        });

        it("conexão desconectada após o agendamento do timer deixa de ser polled", async () => {
            // O findFirst filtra status != 'disconnected' → banco devolve null
            const { result, fakeThis } = callGate(null);
            await expect(result).resolves.toBeNull();
            expect(fakeThis.logger.warn).toHaveBeenCalled();
            const where = fakeThis.prisma.integrationConnection.findFirst.mock.calls[0][0].where;
            expect(where.status).toEqual({ not: 'disconnected' });
            expect(where.clientId).toEqual({ not: null });
        });
    });
});
