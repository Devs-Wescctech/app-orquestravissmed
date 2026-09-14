# Integração e validação conjunta — 14/09/2026

Branch local: `codex/integrated-sync-permissions`.
Base remota conferida: `183ec82ac74dcea13068a7467373ea0f3c7cb73d`.
Escopo autorizado: integrar e testar localmente. Sem push, publicação ou agendamentos reais.

## Ajustes reunidos

| Commit original preservado na ancestralidade | Conteúdo |
| --- | --- |
| `90ecb04f1db8e22ff39c6f5ab830d691107da261` | Recusa definitiva da VISSMED, cancelamento com comprovante persistido, proteção das retomadas e reconciliação de endereços |
| `307ae5a52df437264b73d39aad2559671c3cf5f5` | Gestão de contas e clínicas somente pelo Super Admin, edição do próprio perfil e validação de contas ativas |
| `2c533568b3ce115acd5fe8ad5f4832268657b07e` | Contagem de bloqueios confirmados na Doctoralia como sincronizados |
| `5e392f8ec932fbfc88ea82797e1c74ed8878ecfd` | Avisos do painel com explicação e orientação conforme a causa |

Os merges preservam os commits originais. Na conciliação, um ID de bloqueio sozinho não prova sincronização: exige origem VISMED, confirmação persistida, ausência de erro e situação não cancelada/não falha. Um ID de agendamento não sobrescreve uma operação explicitamente pendente.

Avisos de recusa com cancelamento pendente orientam aguardar sua confirmação. Após cancelamento confirmado, o serviço solicita a resolução do aviso anterior daquele agendamento; enquanto o resultado for incerto, mantém o aviso. A resolução usa o tratamento existente de alertas: uma falha isolada de persistência do aviso ainda pode mantê-lo visível, sem repetir o cancelamento externo.

## Resultado final

- API: **1.269 testes aprovados**, em 73 suítes. **13 testes ignorados**, em duas suítes opcionais de PostgreSQL (`booking-claim.postgres` e `sync-pipeline.postgres`), cujas configurações específicas não foram ativadas. Não são contabilizados como aprovados.
- Interface e lógica: **43 testes aprovados**, incluindo todos os arquivos `apps/web/tests/*.test.cjs` e os scripts `booking-alerts.test.cjs` e `booking-sync-state.test.mjs`.
- TypeScript: API, testes de autenticação/usuários e frontend aprovados em comandos separados. Isso é necessário porque a configuração existente do Next ignora erros de tipagem durante o build.
- PostgreSQL 16 descartável: schema aplicado somente à base de testes; passaram os testes de fila e de persistência do comprovante de recusa. Rede Docker interna, sem acesso às integrações reais.
- Dependências instaladas com `npm ci` em volumes novos deste candidato, a partir do lockfile. Nenhuma alteração em manifests, lockfile, schema ou configuração de implantação.
- Build completo Docker aprovado. Imagem local `vismed:integrated-local-20260914`, ID `sha256:fee54a396307d5e17ffa7dc75cd33adc1890bcc2ef3639cfd3266b1210dca089`.
- Inicialização da imagem com PostgreSQL e Redis descartáveis: preflight concluído, API e frontend iniciados; HTTP 200 na raiz da API e em `/login`, HTTP 401 em `/users` sem autenticação.

O build ainda emite o aviso existente do Next sobre tentativa de corrigir metadados SWC no lockfile; a compilação terminou com sucesso. Não houve alteração do lockfile local. Não foi feito teste visual interativo nem um novo teste ponta a ponta nos sistemas externos.

## Evidências e reprodução

Na pasta local que contém os checkouts: `integrated-install.txt`, `integrated-validation-final.txt` e `integrated-build.txt`. Logs de testes usam dados simulados. O primeiro log de validação é histórico; o arquivo `integrated-validation-final.txt` contém a execução após a última correção.

Com dependências instaladas e banco descartável devidamente configurado:

```sh
npm test --workspace=apps/api -- --runInBand
node --test apps/web/tests/*.test.cjs scripts/booking-alerts.test.cjs scripts/booking-sync-state.test.mjs
npx tsc --noEmit --incremental false -p apps/api/tsconfig.json
npx tsc -p apps/api/tsconfig.auth-tests.json
npx tsc --noEmit --incremental false -p apps/web/tsconfig.json
docker build -t vismed:integrated-local-20260914 .
```

O teste de comprovantes exige `REFUSAL_DB_TEST=1` e valida que o host seja `orq-refusal-test-db`, base `refusal_test`. Não usar conexão de produção para esses testes.

## Limites e próxima publicação

Esta validação conjunta substitui os resultados parciais de testes registrados nos documentos anteriores, sem apagar seu histórico. As quatro falhas antigas de configuração dos testes Auth/Users não se repetiram.

Não confirma entrega de WhatsApp/e-mail ao paciente pela Doctoralia. Essa comunicação externa continua sem validação.

Antes de publicar: revisar e autorizar o envio do candidato integrado ao Git e a janela de implantação. Antes de qualquer rollback, verificar compensações pendentes: a versão antiga não conhece seus comprovantes e não deve reprocessá-las sem procedimento controlado. Restaurar código não desfaz cancelamentos externos. Ver `booking-refusal-followup-2026-09-14.md` e `permissoes-usuarios-2026-09-14.md` para contratos e regras detalhados.
