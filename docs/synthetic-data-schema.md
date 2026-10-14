# Base sintetica para demonstracao academica

Esta base e exclusivamente ficticia. Ela nao e uma extracao real e nao contem tabela de correspondencia com a fonte arquivada.

## Esquema atual

Cada pedido mantem os campos `id`, `codigo`, `fornecedor`, `valorTotal`, `dataEmissao`, `status`, `statusApproval`, `siengeOperationalStatus`, `siengeApprovalStatus`, `siengeAuthorized`, `itens`, `obra` e `nfe`. `obra.id` identifica uma obra sintetica; o nome do fornecedor e apenas um rotulo ficticio.

`status` e `siengeOperationalStatus` representam o estado operacional: `PENDING`, `PARTIALLY_DELIVERED`, `FULLY_DELIVERED` ou `CANCELED`. `statusApproval`, `siengeApprovalStatus` e `siengeAuthorized` representam aprovacao/autorizacao e nao alteram o agrupamento operacional.

`nfe: null` e `itens: []` sao valores compativeis com o esquema demonstrado. Nao significam que o ERP nao possua esses dados.

## Regras de relacionamento

- IDs de pedidos, codigos, obras, fornecedores, equipes e demais identificadores sinteticos devem ser unicos no respectivo dominio.
- Cada pedido deve apontar para uma obra sintetica existente.
- `summary.json` deve ser recalculado a partir dos quatro arrays de pedidos, sem usar numeros da fonte arquivada.
- Os totais por status devem coincidir com os arrays; aprovacao deve ser contabilizada separadamente.
- Pedidos pendentes podem estar aprovados ou nao aprovados.

## Eventos de recebimento atuais

`data/receipts.json` contem eventos sinteticos relacionados a pedidos existentes. Nao ha eventos para pedidos cancelados e um pedido pode possuir mais de um recebimento, pois cada evento e contado separadamente; isso nao transforma uma entrega parcial em vinculo pendente.

Os cenarios cobertos sao: vinculo dentro do prazo, vinculo apos o prazo, recebimento sem vinculo ainda dentro do prazo, recebimento sem vinculo com prazo vencido e vinculo exatamente no limite.

Cada evento possui `id`, `orderId`, `receivedAt` e `linkedAt`. `linkedAt: null` representa uma pendencia de vinculacao, nao uma conclusao de entrega.

## Configuracao e convencao MASP

`data/analysis-config.json` marca explicitamente a simulacao e fixa o corte em `2025-04-01T00:00:00.000Z`, com prazo ficticio de 3 dias corridos. Todos os instantes usam ISO 8601 com `Z` (UTC). O codigo nao usa a data atual nem converte para horario local.

Para um recebimento vinculado:

`tempoVinculoDias = (linkedAt - receivedAt) / 86.400.000`

O vinculo esta dentro do prazo se `tempoVinculoDias <= 3`; acima disso e contado como fora do prazo. Para um recebimento ainda sem vinculo:

`idadeAbertaDias = (cutoffAt - receivedAt) / 86.400.000`

Recebimentos abertos sao mantidos em denominador separado. Um aberto esta vencido se `idadeAbertaDias > 3`. Os conjuntos vazios retornam percentual `0`, mediana `null` e Pareto `[]`; nunca `NaN`.

O percentual de vinculos fora do prazo e `vinculosForaDoPrazo / vinculosConcluidos * 100`. A mediana usa somente tempos de vinculos concluidos. O Pareto usa somente vinculos concluidos fora do prazo, conta cada evento uma vez, ordena por frequencia de obra e calcula percentual sobre o total de eventos fora do prazo e percentual acumulado.

As funcoes puras estao em `analysis/masp.mjs` e os testes em `test/masp.test.mjs`. Datas invalidas, referencias inexistentes, IDs duplicados e vinculos anteriores ao recebimento sao apontados em `issues` e excluidos das metricas com indicacao explicita; nao sao corrigidos ou descartados silenciosamente.

Todos os resultados desta etapa sao simulados. Nao ha estimativa de prejuizo usando valor de pedido ou tempo decorrido.

## Dashboard MASP

O dashboard academico esta em `src/` e consome, por caminhos explicitos, apenas os quatro arquivos de pedidos, `data/receipts.json` e `data/analysis-config.json`. O calculo continua centralizado em `analysis/masp.mjs`; a interface apenas filtra entradas e apresenta o resultado das funcoes puras.

O recorte por obra e fornecedor e aplicado simultaneamente aos indicadores, Pareto e tabela. A area de qualidade exibe issues e registros excluidos dos calculos. Nenhuma interface acessa `archive/`, dados brutos, ERP, endpoints remotos ou telemetria.

O build deve publicar somente os artefatos do frontend e os dados sinteticos importados explicitamente. Nao existe exportacao, autenticacao, backend ou calculo de custos nesta etapa.

## Validacao local do dashboard

Comandos executados:

- `npm install`: executado porque nao havia lockfile; instalou as dependencias declaradas e as tipagens necessarias de React, sem vulnerabilidades reportadas.
- `npm run test:masp`: 5 testes aprovados.
- `npm run build`: tipagem TypeScript e build Vite aprovados; gerou `dist/index.html` e dois assets em `dist/assets/`.
- `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173`: servidor local iniciado e endpoint raiz respondeu HTTP 200; o processo foi encerrado depois da verificacao.

O build foi inspecionado e nao contem `archive/`, arquivos brutos, diretorios publicos de exportacao ou outros arquivos fora de `index.html` e dos assets gerados. A verificacao foi feita sem ler `archive/`.

Para iniciar localmente:

```text
npm install
npm run dev
```

A validacao automatizada confirma a resposta HTTP e os calculos. Nao foi realizada validacao interativa em navegador nesta etapa porque nenhuma ferramenta de navegador estava disponivel no ambiente.

## Diagnostico da tela em branco

O problema no modo de desenvolvimento era a importacao de `analysis/masp.mjs`, que antes usava `module.exports` (CommonJS). O avaliador de modulos do Vite tentava executa-lo como ESM e produzia `ReferenceError: module is not defined`. O build de producao conseguia empacotar o modulo, mas isso nao validava o carregamento do dev server.

A correcao foi converter apenas o formato do modulo para ESM, renomeando-o para `analysis/masp.mjs`, e atualizar os imports do dashboard, as declaracoes TypeScript e o teste. As funcoes, regras, dados, filtros e isolamento permaneceram inalterados.

Validacoes adicionais:

- SSR pelo pipeline do Vite carregou `App` e produziu HTML sem excecao.
- Dev server verificado em `http://127.0.0.1:5173/`.
- Preview de producao verificado em `http://127.0.0.1:4173/`.
- Nenhuma ferramenta de navegador estava disponivel; Console, Network, interacao de filtros, teclado e layout mobile continuam pendentes de verificacao visual real.

## Recebimentos simulados futuros

Se recebimentos forem expandidos, eles devem continuar relacionados por `orderId` a um pedido existente. O modelo deve distinguir explicitamente `physicalReceiptDate` (data do recebimento fisico simulado) e `linkageDate` (data da vinculacao simulada). Essas datas nao existem nos arquivos atuais e nao devem ser preenchidas retroativamente como se fossem campos da fonte.

Quando aplicavel, uma regra futura pode exigir `physicalReceiptDate <= linkageDate`, sem alterar `dataEmissao`.

## Planilha acadêmica P3

O comando `npm run generate:p3` (ou `python scripts/generate_p3_xlsx.py`) gera localmente `exports/MASP-P3-Simulacao.xlsx`. A geração lê somente os quatro arrays de pedidos, `data/receipts.json` e `data/analysis-config.json`; a base completa não depende dos filtros da interface.

As abas `Leia-me`, `Pedidos`, `Recebimentos`, `Indicadores`, `Pareto` e `Custos` identificam a natureza simulada. As colunas derivadas usam fórmulas do Excel e têm valores em cache para conferência. O Pareto é um gráfico combinado editável de colunas e linha, com linha de referência de 80%; não há imagem substituindo o gráfico. Datas são gravadas como instantes UTC sem conversão local e `linkedAt: null` fica como célula vazia.

O exportador compara os resultados com `analysis/masp.mjs` e interrompe a geração quando os dados sintéticos não passam na validação de integridade. A validação estrutural também verifica as partes do XLSX, o gráfico combinado e a ausência de referências externas ou nomes de arquivos originais.

O arquivo `requirements-p3.txt` fixa a única dependência Python necessária à geração (`XlsxWriter`). `exports/` permanece excluído pelo `.gitignore`.

## Custos simulados

`data/rework-costs.json` contém poucos exemplos fictícios de atividades adicionais e referencia apenas `receiptId` existente. Os registros não são causas comprovadas de atrasos e não recebem custo automaticamente por classificação de prazo.

O custo de cada registro é `reworkMinutes / 60 * hourlyCostBRL`. O exportador arredonda cada atividade a duas casas decimais e arredonda novamente o total da soma desses valores. A aba `Custos` mantém a fórmula editável e explicita que a ausência de registro não significa custo zero comprovado.

O total não usa `valorTotal` dos pedidos, dias de espera, multas ou qualquer estimativa de prejuízo. Também não é extrapolado para a empresa ou para outros períodos. O gerador valida IDs únicos, referências de recebimento existentes, números não negativos, conjunto vazio e referência inválida.

### Codificação da geração

Os JSONs sintéticos são lidos como UTF-8. A comunicação entre Python e `analysis/masp.mjs` também decodifica explicitamente a saída do Node como UTF-8; isso evita que nomes como `Obra Acadêmica` sejam convertidos em `Obra AcadÃªmica`. O gerador verifica esse nome na saída do Pareto e nas strings do XLSX, além de rejeitar a forma corrompida.
## Regras de validade exportadas

As funcoes puras estao em `analysis/masp.mjs` e os testes em `test/masp.test.mjs`. A validacao verifica datas ISO UTC, referencias existentes, IDs duplicados, pedidos cancelados, recebimento anterior a `dataEmissao` e vinculo anterior ao recebimento. Esses registros sao marcados como `invalid` e excluidos sem correcao silenciosa. Um `receivedAt` posterior ao `cutoffAt` e `out_of_scope`, nao dado invalido: permanece identificavel e nao entra nas metricas. A aba `Recebimentos` exporta `situacao validada` e `motivo de exclusao` vindos do software; a formula da coluna `valido` nao e apresentada como equivalente a validacao completa.

## Exportacao reproduzivel e Pareto

O XLSX e um retrato reproduzivel dos JSONs sinteticos, prazo e corte no momento da geracao. As formulas ficam preservadas para transparencia, mas alteracoes devem ser feitas nos JSONs e seguidas de `npm run generate:p3`; nao ha atualizacao dinamica completa dentro do Excel. As abas sao protegidas contra edicao acidental de celulas derivadas e referencias. Essa protecao e de uso, nao de seguranca.

O Pareto e derivado em cada geracao dos recebimentos elegiveis fora do prazo, inclui todas as obras com ocorrencias, usa o total completo como denominador e ordena por quantidade decrescente, com desempate por `obra.id` crescente. A frase de interpretacao e descritiva, sem causas ou concentracao 80/20 forcada. Recorte sem ocorrencias produz Pareto vazio; uma categoria acumula 100%.

No software, diferencas em milissegundos sao convertidas em dias dividindo por 86.400.000. No Excel, datas numericas subtraidas ja retornam dias. O corte e fixo e nao usa a data atual.

## Preparacao para expansao sintetica

A base atual e uma linha de base didatica. Antes de ampliar o volume, execute `npm run validate:data`: o comando verifica identificadores unicos, status operacionais, relacionamentos entre pedidos, recebimentos e custos, datas UTC, consistencia do resumo e metadados que preservam a natureza sintetica sem vinculo com arquivos-fonte.

O gerador do XLSX tambem executa essa validacao antes de exportar. Quantidades, percentuais e textos da planilha sao calculados a partir dos JSONs; os totais atuais nao sao pre-requisitos da geracao. Uma expansao deve manter IDs sinteticos estaveis, referencias validas, `dataEmissao <= receivedAt <= linkedAt` quando houver vinculo, e ausencia de recebimentos para pedidos cancelados.

`data/synthetic-scenarios.json` declara apenas os volumes e cenarios necessarios para a demonstracao. `npm run generate:data` usa a semente declarada para recriar os JSONs, `summary.json` e `extraction-metadata.json` sem consultar o ERP ou qualquer arquivo em `archive/`. A ampliacao e intencionalmente limitada a esse esquema existente; campos novos exigem justificativa metodologica e validacao propria.

## Relacao dos custos com atraso

`data/rework-costs.json` inclui `delayRelation`: `assumida_no_cenario`, `nao_atribuida` ou `indeterminada`, sempre com justificativa. As duas atividades de R$ 60,00 sao uma premissa didatica de acompanhamento/regularizacao de vinculos atrasados; a atividade de R$ 30,00 e correcao cadastral nao atribuida ao atraso. Isso nao e evidencia real nem causa comprovada. A aba `Custos` calcula por `SUMIF` o total registrado (R$ 150,00), a parcela associada por premissa (R$ 120,00) e a parcela nao atribuida (R$ 30,00), sem usar valor de pedido, espera ou multa.
