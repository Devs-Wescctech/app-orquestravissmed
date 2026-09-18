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

## Retomada autorizada: homologação e painel

Usuário autorizou continuar homologação e painel, incluindo o segundo serviço temporário anteriormente solicitado. Produção não foi alterada nem incluída nesta retomada.

### Resultado real com dois serviços: NÃO APROVADO

Executado `node scripts/probe-slot-replacement-expanded.cjs --authorized-sandbox --temporary-service`, seguido de execução diagnóstica com `--extended-readback` (até 20 leituras, intervalo de 2 segundos).

O catálogo existente só tinha o address service 6018375. Usado o serviço de catálogo 286, Consulta especializada, para criar temporariamente um segundo address service na homologação. As três execuções criaram respectivamente 6521986, 6521996 e 6522001. Nas duas últimas, GET de serviços confirmou o novo ID, `service_id=286` e `is_visible=true` antes do envio dos horários.

PUT de criação da disponibilidade retornou 201. O período de 24/09 10:10–10:40 foi enviado com dois address services, ambos duração 30 minutos. GET com `with[]=slot.services` continuou retornando apenas 6018375 para esse período, mesmo na leitura prolongada. Não atribuir definitivamente a causa à Doctoralia: ainda é necessário esclarecer a representação/ativação de múltiplos serviços nesse contrato. A ausência observada impede comprovar preservação do segundo serviço.

O script interrompeu antes da remoção seletiva, pois o estado inicial já não correspondia ao publicado. Em todas as execuções, a limpeza final de dados sintéticos foi confirmada: 24 e 25/09 vazios e catálogo novamente apenas com 6018375. Os três serviços temporários foram removidos. Nenhuma consulta de paciente, notificação ou dado de produção foi criado/modificado.

Regressão automatizada adicionada para ausência de um dos serviços na leitura: reconciliador retorna pendência, não envia PUT e não avança o registro. 18 testes do planejador/reconciliador passaram. Não enfraquecer a comparação para fazer esse teste real passar.

Referência de contrato consultada: https://integrations.docplanner.com/docs/, operações addAddressService e getSlots. O contrato documenta expansão `slot.services`; o resultado real desta homologação ainda exige esclarecimento.

### Painel: transições automatizadas aprovadas; visual ainda indisponível

`node --test apps/web/tests/*.test.cjs`: 28/28 passaram. Acrescentados testes de carregamento sob demanda, estado de carregamento, motivos/eventos da limpeza pendente, erro recuperável, nova tentativa e proteção contra exibição do erro bruto. Usam harness controlado de hooks e renderização React; não são E2E de navegador/DOM.

Nova tentativa de inventário do navegador retornou `User unavailable`, sem navegadores acessíveis. A skill Browser QA não permite declarar conferência visual concluída com essa evidência. Não houve inspeção visual ou teste interativo da tela real. Código de produção permaneceu igual nesta retomada; alterados apenas testes, script de homologação e este relatório.

Pendências atuais: esclarecer o segundo serviço ausente no GET antes de aprovar a homologação múltipla; restabelecer acesso do navegador para validar visualmente o painel. Builds/tipos anteriores do mesmo código de produção continuam válidos. Nenhum push/deploy nesta retomada.
