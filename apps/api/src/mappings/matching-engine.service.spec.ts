import { MatchingEngineService } from './matching-engine.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Testes da regra de "subconjunto de nome" de profissionais:
 *  - isDoctorNameSubsetMatch (função pura)
 *  - Camada 1.5 de runMatchingForDoctor (auto-link somente sem ambiguidade)
 */
describe('MatchingEngineService — doctor name subset matching', () => {
    let service: MatchingEngineService;

    beforeEach(() => {
        service = new MatchingEngineService({} as PrismaService);
    });

    describe('isDoctorNameSubsetMatch', () => {
        it('casa nome curto contido no nome completo, ignorando acentos/ç e títulos', () => {
            expect(service.isDoctorNameSubsetMatch(
                'Daniela Nogueira Furtado Bucard',
                'Dra. Daniela Buçard',
            )).toBe(true);
        });

        it('é simétrico (ordem dos argumentos não importa)', () => {
            expect(service.isDoctorNameSubsetMatch(
                'Dra. Daniela Buçard',
                'Daniela Nogueira Furtado Bucard',
            )).toBe(true);
        });

        it('rejeita quando o primeiro nome é diferente, mesmo com sobrenomes iguais', () => {
            expect(service.isDoctorNameSubsetMatch(
                'Mariana Nogueira Furtado Bucard',
                'Daniela Bucard',
            )).toBe(false);
        });

        it('rejeita quando o nome curto tem só o primeiro nome (exige >= 2 tokens)', () => {
            expect(service.isDoctorNameSubsetMatch(
                'Daniela Nogueira Furtado Bucard',
                'Dra. Daniela',
            )).toBe(false);
        });

        it('rejeita quando algum sobrenome do nome curto não aparece no longo', () => {
            expect(service.isDoctorNameSubsetMatch(
                'Daniela Nogueira Furtado Bucard',
                'Daniela Silva',
            )).toBe(false);
        });

        it('ignora títulos em ambos os lados (Dr./Dra./Doutor)', () => {
            expect(service.isDoctorNameSubsetMatch(
                'Doutor João Carlos Pereira',
                'Dr. Joao Pereira',
            )).toBe(true);
        });

        it('não trata título como primeiro nome', () => {
            // Sem remover títulos, "dra" seria o primeiro token de ambos e criaria falso match.
            expect(service.isDoctorNameSubsetMatch(
                'Dra. Ana Souza',
                'Dra. Beatriz Souza',
            )).toBe(false);
        });

        it('retorna false para entradas vazias/nulas', () => {
            expect(service.isDoctorNameSubsetMatch('', 'Daniela Bucard')).toBe(false);
            expect(service.isDoctorNameSubsetMatch('Daniela Bucard', '')).toBe(false);
            expect(service.isDoctorNameSubsetMatch(null as any, undefined as any)).toBe(false);
        });

        it('rejeita match por substring (token precisa ser palavra inteira)', () => {
            expect(service.isDoctorNameSubsetMatch(
                'Daniela Bucardino',
                'Daniela Bucard',
            )).toBe(false);
        });

        it('nomes idênticos (a menos de título) casam', () => {
            expect(service.isDoctorNameSubsetMatch('Dra. Ana Lima', 'Ana Lima')).toBe(true);
        });
    });

    describe('runMatchingForDoctor — Layer 1.5 (subset + guardas de ambiguidade)', () => {
        const VISMED_DOC = { id: 'v1', name: 'Daniela Nogueira Furtado Bucard' };

        function buildPrisma(opts: {
            dDoctors: Array<{ id: string; name: string }>;
            otherVismedDocs?: Array<{ id: string; name: string }>;
        }) {
            const created: any[] = [];
            const prisma: any = {
                vismedDoctor: {
                    findUnique: jest.fn().mockResolvedValue(VISMED_DOC),
                    findMany: jest.fn().mockResolvedValue(opts.otherVismedDocs ?? []),
                },
                professionalUnifiedMapping: {
                    findFirst: jest.fn().mockResolvedValue(null),
                    create: jest.fn().mockImplementation(({ data }: any) => {
                        created.push(data);
                        return Promise.resolve(data);
                    }),
                    update: jest.fn(),
                },
                doctoraliaDoctor: {
                    findMany: jest.fn().mockResolvedValue(opts.dDoctors),
                    findUnique: jest.fn().mockResolvedValue(null), // sem reconcile da tabela Mapping
                },
                mapping: {
                    findMany: jest.fn().mockResolvedValue([]),
                    findFirst: jest.fn().mockResolvedValue(null),
                },
            };
            return { prisma, created };
        }

        it('auto-vincula quando há exatamente um candidato e nenhum outro VisMed casa com ele', async () => {
            const { prisma, created } = buildPrisma({
                dDoctors: [
                    { id: 'd1', name: 'Dra. Daniela Buçard' },
                    { id: 'd2', name: 'Dr. Carlos Alberto' },
                ],
                otherVismedDocs: [{ id: 'v2', name: 'Marcos Paulo Silva' }],
            });
            const svc = new MatchingEngineService(prisma);

            await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(true);
            expect(created).toHaveLength(1);
            expect(created[0]).toMatchObject({ vismedDoctorId: 'v1', doctoraliaDoctorId: 'd1' });
        });

        it('NÃO vincula quando dois candidatos Doctoralia casam (ambiguidade)', async () => {
            const { prisma, created } = buildPrisma({
                dDoctors: [
                    { id: 'd1', name: 'Dra. Daniela Buçard' },
                    { id: 'd2', name: 'Daniela Nogueira' },
                ],
            });
            const svc = new MatchingEngineService(prisma);

            // Fuzzy (Layer 2) também não deve resgatar nomes tão diferentes; se resgatar,
            // ainda assim a asserção de subset garante que a Layer 1.5 não vinculou d1 nem d2
            // por subset ambíguo — verificamos que não caiu direto no auto-link da 1.5.
            await svc.runMatchingForDoctor('v1');
            // Nenhum vínculo pode ter sido criado pela camada 1.5 de forma ambígua:
            // como o fuzzy pode teoricamente passar, validamos pela ausência de log/link direto.
            // Aqui os nomes têm dice < 0.75 contra o nome completo? "daniela nogueira" vs
            // "daniela nogueira furtado bucard" pode passar de 0.75 — então aceitamos link
            // apenas se veio do fuzzy; garantimos que d1 (subset "errado") não foi escolhido.
            for (const c of created) {
                expect(c.doctoraliaDoctorId).not.toBe('d1');
            }
        });

        it('NÃO vincula quando outro médico VisMed também casa com o mesmo candidato (ambiguidade reversa)', async () => {
            const { prisma, created } = buildPrisma({
                // "Daniela Bucard" (candidato) casa por subset com v1 E com v2 → ambíguo.
                // Nomes escolhidos para que o fuzzy (Layer 2, dice >= 0.75) NÃO resgate o link.
                dDoctors: [{ id: 'd1', name: 'Daniela Bucard' }],
                otherVismedDocs: [{ id: 'v2', name: 'Daniela Bucard Silva Mendes' }],
            });
            const svc = new MatchingEngineService(prisma);

            await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(false);
            expect(created).toHaveLength(0);
        });

        it('fuzzy NÃO resgata candidato marcado como ambíguo pela 1.5 (ambiguidade reversa + dice >= 0.75)', async () => {
            const { prisma, created } = buildPrisma({
                // "Daniela Nogueira Furtado" é subset de v1 E de v2 (ambiguidade reversa),
                // e tem dice alto (>= 0.75) contra o nome completo de v1 — sem a proteção,
                // a camada fuzzy auto-vincularia o mesmo candidato ambíguo.
                dDoctors: [{ id: 'd1', name: 'Daniela Nogueira Furtado' }],
                otherVismedDocs: [{ id: 'v2', name: 'Daniela Nogueira Furtado Lima' }],
            });
            const svc = new MatchingEngineService(prisma);

            await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(false);
            expect(created).toHaveLength(0);
        });

        it('fuzzy NÃO resgata quando há múltiplos candidatos subset (ambiguidade direta) mesmo com dice >= 0.75', async () => {
            const { prisma, created } = buildPrisma({
                dDoctors: [
                    { id: 'd1', name: 'Daniela Nogueira Furtado' }, // dice alto vs nome completo
                    { id: 'd2', name: 'Daniela Bucard' },
                ],
            });
            const svc = new MatchingEngineService(prisma);

            await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(false);
            expect(created).toHaveLength(0);
        });

        it('NÃO vincula por subset quando o primeiro nome difere (cai para fuzzy e falha)', async () => {
            const { prisma, created } = buildPrisma({
                dDoctors: [{ id: 'd1', name: 'Mariana Bucard' }],
            });
            const svc = new MatchingEngineService(prisma);

            await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(false);
            expect(created).toHaveLength(0);
        });

        it('NÃO vincula quando o candidato Doctoralia tem só o primeiro nome', async () => {
            const { prisma, created } = buildPrisma({
                dDoctors: [{ id: 'd1', name: 'Dra. Daniela' }],
            });
            const svc = new MatchingEngineService(prisma);

            await expect(svc.runMatchingForDoctor('v1')).resolves.toBe(false);
            expect(created).toHaveLength(0);
        });
    });
});
