# Conferências adicionais solicitadas — 18/09/2026

Pedido: fechar homologação ampliada, painel e publicação com validação posterior. Este registro não declara a publicação concluída.

## 1. Homologação ampliada — parcial

`node scripts/probe-slot-replacement-expanded.cjs --authorized-sandbox --single-service`

PASS real na Doctoralia, unidade de homologação 140548 / médico 1396868 / endereço 1750984:

- 24/09: retirado 08:10–08:30 (20 minutos), preservados 09:10–09:30 (20 minutos) e 10:10–10:40 (30 minutos).
- 25/09: preservado 11:10–11:40, sem essa data no PUT de remoção seletiva.
- Leitura posterior confirmou os resultados. Ao terminar, ambas as datas voltaram ao estado vazio inicial.
- Nenhuma reserva, notificação de paciente ou serviço foi criado/modificado.

O catálogo da agenda contém somente o serviço 6018375. A primeira execução sem `--single-service` parou no pré-requisito, antes de escrever slots. Teste real com múltiplos serviços aguarda autorização para preparar e retirar um segundo serviço temporário. Pergunta enviada ao usuário; não presumir resposta.

Teste automatizado adicional passou para preservação de dois serviços com durações diferentes e configuração de convênios, retenção de outra data e reordenação JSONB. Isso não substitui a validação real com múltiplos serviços.

## 2. Painel — código corrigido, navegador pendente

Encontrada lacuna: `professional_cleanup_pending` não entrava no resumo de agendas nem na explicação de pendências. Correção acrescenta o evento às contagens e à seção de motivos. Texto distingue limpeza não concluída/confirmada de garantia de que nenhuma escrita ocorreu; um timeout não permite prometer preservação absoluta.

TDD: d427620 reproduziu três falhas (uma API, duas frontend); 607025b corrigiu e passou nos mesmos testes. Nenhum agendamento fictício foi adicionado ao calendário.

Validações:

- 26 testes frontend com Node Test Runner passaram, incluindo renderização React da contagem e motivos.
- 66 testes focados API passaram, incluindo observação, registro e reconciliação.
- Cobertura de planejador/observação: 88,23% statements, 80,62% branches, 89,58% funções, 91,56% linhas.
- Build API e Web passaram. TypeScript sem emissão passou separadamente nos dois projetos; o build Next por configuração existente ignora lint/types, portanto não é usado como prova dessas etapas.
- ESLint dos cinco módulos API de planejamento/registro/reconciliação/limpeza/observação passou. Não executado lint integral frontend.
- Next emitiu aviso de dependências opcionais SWC ausentes no lockfile e falhou ao tentar repará-lo; ainda assim compilou e gerou as 19 páginas com exit 0. Lockfile/manifests ficaram inalterados. Não atualizar dependências suspensas para ocultar o aviso.
- Os 1.460 testes integrais anteriores continuam sendo evidência da etapa anterior; nesta etapa não se afirma ter repetido a regressão integral ou o PostgreSQL. Reexecutados os alvos afetados pelas novas alterações.

O controle do Chrome retornou `User unavailable` ao acessar Orquestrador e Portainer. Não houve validação visual/interativa do painel; solicitada disponibilidade do navegador ao usuário.

## 3. Publicação — não executada

Usuário autorizou fechar a etapa de publicação, condicionada aos controles. Main remota continua 943b93b070c65dac19a7beac67dac869957f6bd1 na consulta desta rodada. Não há workflows versionados em `.github/workflows`; isso não prova inexistência de gatilhos externos.

Sem acesso operacional ao Portainer ainda não foi possível reconferir imagem/commit em execução, preservação do artefato anterior, configuração efetiva, gatilhos GitOps, janela/filas, backup pertinente ou dry-run direcionado. Portanto não houve push, merge ou deploy. Não usar Pull and redeploy global: a ocorrência registrada no procedimento do projeto recriou Redis; publicação deve ser limitada ao serviço vismed.

Impacto do candidato: sem migration/schema/manifest/entrypoint novos. Adiciona informações ao JSON de estado existente; retornar o código não desfaz escritas nem remoções na Doctoralia. Procedimento direcionado e retorno precisam ser confirmados no servidor antes da operação.

Próxima retomada: obter acesso ao Chrome/Portainer, concluir o cenário de múltiplos serviços se autorizado, validar visualmente o painel candidato, registrar os controles da janela, publicar exclusivamente vismed e conferir imagem/saúde/ciclo real e preservação de Redis. Nunca registrar segredos ou dados de pacientes no relatório.
