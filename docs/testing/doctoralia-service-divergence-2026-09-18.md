# Investigação: serviço adicional ausente na disponibilidade

Data: 18/09/2026. Escopo: homologação autorizada, facility 140548, doctor 1396868, address 1750984. Nenhuma alteração em produção ou no código de negócio.

## Conclusão delimitada

A divergência ocorre antes da remoção seletiva: o serviço recém-criado existe no cadastro, mas não aparece como disponível após PUT de slots aceito com HTTP 201. O horário contendo somente esse serviço também não aparece. Não é apenas perda do segundo elemento da lista, pois inverter a ordem não muda o resultado.

Não determinada a causa interna da Doctoralia: habilitação adicional, propagação mais longa ou falha do provedor permanecem hipóteses. Não atribuir uma causa definitiva sem confirmação. O código de remoção mantém a comparação estrita e não foi alterado para aceitar essa divergência.

## Fontes e revisão do cliente

- [API oficial](https://integrations.docplanner.com/docs/): replaceSlots aceita lista de address_services; getSlots admite expansão slot.services; getAddressServices admite filtro start.
- [Guia oficial de recursos](https://integrations.docplanner.com/guide/api-objects/resources.html): serviços do catálogo precisam ser associados ao endereço; usar o address_service_id dessa associação, não o service_id global, no PUT. Serviços visíveis são usados para disponibilidade.
- Context7 consultado: nenhum resultado correspondente à Docplanner; utilizados documentos primários oficiais.
- Cliente local revisado: replaceSlots encaminha payload sem filtrar serviços; executeRequest serializa o objeto com JSON.stringify em application/json. Captura no limite do fetch confirmou o JSON enviado, sem imprimir Authorization.

## Matriz real de reprodução

Executado `node scripts/probe-slot-replacement-expanded.cjs --authorized-sandbox --temporary-service --diagnose-services`.

Serviço original A: address_service_id 6018375, service_id 641, Primeira consulta Cardiologia.
Serviço temporário B: address_service_id 6522046, service_id 286, Consulta especializada.

Todos os períodos em 24/09/2026, duração 30 minutos:

| Horário | PUT enviado | GET slots expandido | GET services?start |
|---|---|---|---|
| 08:10–08:40 | A | A | A |
| 09:10–09:40 | B | Horário ausente | 404 Slot not found |
| 10:10–10:40 | A, B | A | A |
| 11:10–11:40 | B, A | A | A |

PUT retornou 201. Duas rodadas de leitura, primeira após 5 segundos e segunda após intervalo adicional de 10 segundos, reproduziram a matriz. A primeira tentativa diagnóstica anterior (temporário 6522044) leu imediatamente após PUT e obteve vazio/404; foi encerrada e limpa, sem atribuir esse resultado imediato como causa da divergência. O intervalo inicial foi incorporado para evitar confundir processamento inicial com o comportamento estável observado.

Uma rodada adicional com `--cardiology-service` usou B = address_service_id 6522074, service_id 4125, Consulta Cardiologia. Resultado idêntico à matriz. Assim, o sintoma não ficou restrito ao serviço genérico Consulta especializada.

GET de serviços expandido confirmou para A e B de Cardiologia:

- is_visible: true;
- price: 0 e is_price_from: false;
- is_default: false;
- is_public_insurance_flow: false;
- allowed_patients: minimum_age e maximum_age null.

Nenhuma diferença nesses campos explicou a ausência. default_duration foi enviado na criação; esse campo não foi retornado na leitura, portanto não se declara sua persistência confirmada. O PUT de slots incluiu duration 30 para ambos.

Os testes da etapa anterior já haviam repetido a leitura do serviço genérico por aproximadamente 38 segundos de intervalos mais latência, sem o segundo ID. Isso não exclui atrasos maiores não documentados. IDs novos em cada rodada evitaram repetir o mesmo payload de criação de slots entre as rodadas; sucesso HTTP sozinho não foi considerado confirmação funcional.

## Segurança e estado final

Guardas do script restringem host, unidade, médico, endereço e intervalos sintéticos. Cadastro do segundo serviço autorizado apenas com flag de teste; DELETE restrito ao ID criado naquela execução. Não houve reserva, cancelamento ou aviso a paciente. Nenhum teste em agendas reais.

Em todas as três rodadas diagnósticas desta investigação, os períodos sintéticos foram retirados e os GETs confirmaram 24 e 25/09 vazios. Serviços temporários 6522044, 6522046 e 6522074 removidos; catálogo final confirmado novamente somente com 6018375.

Script terminou com exit 0 nas rodadas completas da matriz porque coleta diagnóstico e restaura o ambiente. Isso NÃO significa aprovação do cenário de múltiplos serviços.

## Pergunta técnica para a Doctoralia (rascunho, não enviado)

Na homologação facility 140548 / doctor 1396868 / address 1750984, criamos um address service via POST services, confirmado em GET com is_visible=true. Enviamos PUT slots usando o ID retornado na criação e duration=30; resposta 201. O serviço original 6018375 fica disponível normalmente. O serviço recém-criado não aparece nem quando enviado sozinho; GET services?start retorna 404 Slot not found nesse horário. Enviar original+novo ou novo+original retorna apenas o original. Reproduzido com os serviços de catálogo 286 e 4125. Existe habilitação adicional ou prazo de propagação para o novo address service participar da disponibilidade? Se não, podem verificar por que o PUT aceita o recurso mas ele não fica disponível? Os IDs temporários já foram retirados após a coleta; uma nova reprodução deve ser combinada em homologação.

## Busca de agenda com dois serviços preexistentes

Após o pedido de teste em agenda de homologação, executado inventário somente leitura na unidade autorizada Medical Center Bruno Mendes Test (140548), usando `--inventory-sandbox`. Foram encontrados cinco profissionais/endereços, todos com calendário enabled e exatamente um serviço cadastrado visível:

| Profissional | Endereço | Único address service |
|---|---|---|
| 1396868 | 1750984 | 6018375 |
| 1396869 | 1750985 | 6018373 |
| 1396870 | 1750986 | 6018372 |
| 1396871 | 1750987 | 6018371 |
| 1396872 | 1750988 | 6018370 |

Listagens completas, sem próxima página. Nenhuma agenda com dois serviços preexistentes disponível nessa unidade. Não foram criados serviços/horários nem repetidos testes de escrita nesta rodada. Para esse cenário específico, é necessário fornecer outra agenda de homologação já preparada ou habilitar um segundo serviço com disponibilidade confirmada; não substituir por uma agenda real. A validação anterior com um serviço continua válida e não foi repetida sem motivo.
