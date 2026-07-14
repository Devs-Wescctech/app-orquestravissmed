/**
 * Migração one-off: corrige entradas falsas no dicionário DoctoraliaService criadas
 * pelo bug de ingestão que gravava o address_service id (id do vínculo serviço↔endereço)
 * como se fosse o service_id do dicionário global.
 *
 * - Pivots antigos usam chave composta `${addrId}_${docId}_${linkId}` → o 3º componente
 *   é o id REAL do vínculo, e também o id falso gravado no dicionário.
 * - Para cada entrada falsa, procura a entrada correta do dicionário pelo normalizedName,
 *   reaponta SpecialtyServiceMapping e DoctoraliaAddressService, limpa invalidReason
 *   causado pelo 404 e apaga a entrada falsa.
 * - Pivots compostos são renomeados para o link id puro (novo formato da ingestão).
 *
 * Uso: node apps/api/scripts/fix-service-dict-ids.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    // 1. Pivots no formato composto antigo
    const pivots = await prisma.doctoraliaAddressService.findMany({
        where: { doctoraliaAddressServiceId: { contains: '_' } },
    });
    console.log(`Pivots compostos (formato antigo): ${pivots.length}`);

    const fakeDictIds = new Set();
    for (const p of pivots) {
        const parts = p.doctoraliaAddressServiceId.split('_');
        if (parts.length === 3) fakeDictIds.add(parts[2]);
    }
    console.log(`IDs de vínculo suspeitos no dicionário: ${fakeDictIds.size}`);

    // 2. Entradas falsas no dicionário
    const fakeServices = await prisma.doctoraliaService.findMany({
        where: { doctoraliaServiceId: { in: [...fakeDictIds] } },
        include: { mappings: true },
    });
    console.log(`Entradas falsas encontradas em DoctoraliaService: ${fakeServices.length}`);

    let merged = 0, deleted = 0, unmatched = 0, remappedMappings = 0;
    for (const fake of fakeServices) {
        const norm = fake.normalizedName
            || fake.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        // Entrada correta: mesmo nome normalizado, id diferente e que NÃO é um link id
        const correct = await prisma.doctoraliaService.findFirst({
            where: {
                normalizedName: norm,
                id: { not: fake.id },
                doctoraliaServiceId: { notIn: [...fakeDictIds] },
            },
            orderBy: { createdAt: 'asc' },
        });

        if (!correct) {
            // Sem correspondência no dicionário → apagar entrada falsa (mappings caem em cascade;
            // o próximo sync com a ingestão corrigida recria dicionário e o matching engine re-casa).
            console.log(`  [SEM MATCH] "${fake.name}" (fake id ${fake.doctoraliaServiceId}) — apagando entrada falsa (${fake.mappings.length} mapping(s) em cascade)`);
            await prisma.doctoraliaService.delete({ where: { id: fake.id } });
            unmatched++;
            deleted++;
            continue;
        }

        // 3. Reapontar SpecialtyServiceMapping (só os mappings DIRETAMENTE afetados pelo bug).
        //    Ao marcar inválido, o push também seta requiresReview=true; se o mapping tinha score
        //    de auto-aprovação (>=0.90) restauramos requiresReview=false para ele voltar a fluir.
        for (const m of fake.mappings) {
            const wasInvalidatedByBug = !!m.invalidReason;
            const restoreAutoApproval = wasInvalidatedByBug && m.confidenceScore >= 0.90;
            const existing = await prisma.specialtyServiceMapping.findUnique({
                where: { vismedSpecialtyId_doctoraliaServiceId: { vismedSpecialtyId: m.vismedSpecialtyId, doctoraliaServiceId: correct.id } },
            });
            if (existing) {
                // Já existe mapping para a entrada correta → manter o existente, limpar invalidReason
                // (a invalidação veio do id falso) e apagar o mapping falso.
                await prisma.specialtyServiceMapping.update({
                    where: { id: existing.id },
                    data: {
                        invalidReason: null,
                        invalidAt: null,
                        ...(restoreAutoApproval || (existing.invalidReason && existing.confidenceScore >= 0.90)
                            ? { requiresReview: false }
                            : {}),
                    },
                });
                await prisma.specialtyServiceMapping.delete({ where: { id: m.id } });
            } else {
                await prisma.specialtyServiceMapping.update({
                    where: { id: m.id },
                    data: {
                        doctoraliaServiceId: correct.id,
                        invalidReason: null,
                        invalidAt: null,
                        ...(restoreAutoApproval ? { requiresReview: false } : {}),
                    },
                });
            }
            remappedMappings++;
        }

        // 4. Reapontar pivots que referenciam a entrada falsa
        await prisma.doctoraliaAddressService.updateMany({
            where: { serviceId: fake.id },
            data: { serviceId: correct.id },
        });

        // 5. Apagar a entrada falsa
        await prisma.doctoraliaService.delete({ where: { id: fake.id } });
        console.log(`  [MERGE] "${fake.name}": fake ${fake.doctoraliaServiceId} → dict ${correct.doctoraliaServiceId}`);
        merged++;
        deleted++;
    }

    // 6. Renomear pivots compostos para o link id puro (novo formato).
    //    IMPORTANTE: pivots podem ter sido apagados em cascade quando uma entrada falsa sem
    //    match foi deletada (DoctoraliaAddressService.serviceId tem onDelete: Cascade) —
    //    re-verificar existência antes de mutar para não abortar a migração no meio.
    let renamed = 0, dropped = 0, gone = 0;
    for (const p of pivots) {
        const parts = p.doctoraliaAddressServiceId.split('_');
        if (parts.length !== 3) continue;
        const linkId = parts[2];
        const still = await prisma.doctoraliaAddressService.findUnique({ where: { id: p.id } });
        if (!still) { gone++; continue; }
        const clash = await prisma.doctoraliaAddressService.findUnique({
            where: { doctoraliaAddressServiceId: linkId },
        });
        try {
            if (clash && clash.id !== p.id) {
                await prisma.doctoraliaAddressService.delete({ where: { id: p.id } });
                dropped++;
            } else if (!clash) {
                await prisma.doctoraliaAddressService.update({
                    where: { id: p.id },
                    data: { doctoraliaAddressServiceId: linkId },
                });
                renamed++;
            }
        } catch (e) {
            // Row sumiu entre o check e a mutação (concorrência com sync) — não abortar.
            console.log(`  [SKIP] pivot ${p.doctoraliaAddressServiceId}: ${e.code || e.message}`);
            gone++;
        }
    }

    // NOTA: não limpamos invalidReason de mappings fora do conjunto afetado pelo bug —
    // rejeições legítimas (ex.: service_id realmente fora do catálogo da unidade) devem
    // continuar inválidas até o operador remapear em /mapping.

    console.log(`\nResumo: ${merged} mesclado(s), ${unmatched} sem match (apagados), ${deleted} entrada(s) falsa(s) removida(s), ${remappedMappings} mapping(s) reapontado(s), ${renamed} pivot(s) renomeado(s), ${dropped} pivot(s) duplicado(s) removido(s), ${gone} pivot(s) já removido(s) em cascade/concorrência.`);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
