# Revisão de alinhamento P3 — Dados e Pareto

Data da revisão: 2026-10-13

## Escopo e fontes

O roteiro MASP/P3 não foi localizado no projeto. A revisão foi feita contra o pedido desta auditoria e a documentação disponível em `docs/synthetic-data-schema.md`. `archive/` e arquivos brutos não foram acessados.

| Requisito | Evidência | Situação |
|---|---|---|
| Ambiente sintético identificado | Aviso permanente “Ambiente de simulação acadêmica / Dados inteiramente fictícios” | Atendido |
| Corte, prazo e UTC | Faixa de contexto mostra corte `2025-04-01`, prazo de 3 dias corridos e ISO 8601 UTC | Atendido |
| Estado inicial com 7 recebimentos | Indicador e tabela exibiram 7 eventos | Atendido |
| 5 vínculos concluídos | Indicador exibiu 5, com denominador 5 | Atendido |
| 2 fora do prazo / 40% | Indicadores exibiram 2 e 40% (`2 / 5`) | Atendido |
| 2 sem vínculo, 1 vencido | Indicadores exibiram 2 abertos e 1 vencido | Atendido |
| Mediana de 3 dias | Indicador exibiu 3 d | Atendido |
| Pareto atual | Duas obras, uma ocorrência por obra; acumulados 50% e 100% | Atendido |
| Eixos e referência | Eixo esquerdo inteiro, eixo direito 0–100%, linha de 80% e legenda visíveis | Atendido |
| Tabela equivalente | Tabela acessível exibiu obra, ocorrências, percentual e acumulado | Atendido |
| Interpretação | Texto indicou distribuição igual e ausência de concentração 80/20 | Atendido |
| Filtros sincronizados | Obra, fornecedor, combinação e Limpar filtros atualizaram indicadores, Pareto e tabelas | Atendido |
| Recorte vazio | Combinação obra Norte + fornecedor 005 exibiu zeros, mediana Não disponível, Pareto vazio e tabela vazia | Atendido |
| Uma categoria | Obra Norte exibiu uma ocorrência e acumulado 100% | Atendido |
| Teclado e foco | Tab levou o foco ao select com outline visível | Atendido |
| Mobile | Viewport 390px exibiu painel sem overflow do body; eixos, legenda e obras ficaram visíveis | Atendido após correção responsiva |
| Console | Sem erros de aplicação; apenas mensagens informativas de Vite/React | Atendido |
| Network | Após reload, requisições somente para `localhost:5173` e dados sintéticos explícitos | Atendido |
| Acessibilidade automatizada | axe: 0 violações; 39 passes; 1 análise incompleta em textos SVG curtos | Atendido com ressalva |

## Defeitos encontrados e corrigidos

O painel Pareto expandia para aproximadamente 806px em viewport de 390px por causa da largura mínima da tabela dentro do item de grid. Isso cortava o eixo direito e parte da legenda. O CSS foi ajustado para permitir `min-width: 0` no painel e dimensionamento do SVG à largura mobile.

O axe também encontrou contraste insuficiente em textos auxiliares e `aria-label` em um `div` sem papel ARIA válido. Os textos foram escurecidos e a legenda recebeu `role="group"`, sem alterar conteúdo de negócio.

## Verificações realizadas

- `agent-browser open http://localhost:5173`.
- Estado inicial auditado no navegador real.
- Filtros de obra e fornecedor testados isoladamente.
- Combinação de filtros testada com resultado vazio.
- `Limpar filtros` testado.
- Recorte de uma obra testado.
- Console e erros da página verificados.
- Network limpa e recarregada; somente localhost observado.
- Foco por teclado verificado.
- Screenshots desktop e mobile inspecionados.
- `agent-browser a11y --json` executado.
- `npm run test:masp`: 5 testes aprovados.
- `npm run build`: TypeScript e Vite aprovados.

## Limitações

- O roteiro original P3 não está presente no projeto.
- Não foram acessados dados reais, `archive/` ou arquivos brutos.
- A regra automática do axe ficou incompleta para alguns textos curtos dentro do SVG; isso não gerou violação.
- A validação visual foi feita em Chrome via agent-browser em desktop e viewport de 390px; outros dispositivos físicos não foram testados.

## Pendências acadêmicas

- A planilha Excel e o custo simulado foram implementados no gerador P3; permanece apenas a inspeção visual/recalculo em Excel ou LibreOffice.
- Formalizar no roteiro a justificativa do recorte temporal e operacional usado na demonstração.

## Exportação acadêmica implementada

O comando `npm run generate:p3` gera `exports/MASP-P3-Simulacao.xlsx` a partir exclusivamente dos JSONs sintéticos. A planilha inclui as seis abas solicitadas, fórmulas derivadas, custos classificados e Pareto combinado editável. A base exportada é completa e independe dos filtros da interface.

Validação da geração: 12 pedidos, 7 recebimentos válidos, 5 vínculos concluídos, 2 fora do prazo (40%), 2 abertos (1 vencido), mediana de 3 dias e duas obras com uma ocorrência cada e acumulados de 50% e 100%. O gerador compara os resultados com `analysis/masp.mjs` e verifica o pacote XLSX sem referências externas, `archive/` ou arquivos brutos.

Limitação de recálculo: a validação realizada aqui verifica fórmulas, valores em cache, referências internas e a estrutura XML do gráfico; não foi aberto um aplicativo Excel para forçar recálculo visual. Ao abrir em Excel, o modo de cálculo do workbook está configurado como automático.

## Custo acadêmico simulado

Foi acrescentado `data/rework-costs.json` e a aba `Custos` à planilha. O cenário possui três atividades fictícias, totalizando R$ 150,00: R$ 60,00, R$ 60,00 e R$ 30,00. A planilha registra as premissas, usa fórmulas editáveis e mantém o custo separado dos indicadores de prazo.

As verificações incluíram cálculo independente com arredondamento, conjunto vazio e rejeição de referência inexistente. Os resultados anteriores de recebimentos, indicadores e Pareto permaneceram iguais. Não foi usado valor de pedido, tempo de espera ou multa presumida.

## Verificação de codificação

A origem dos nomes estava correta em UTF-8 e a leitura Python também. A corrupção ocorria ao decodificar a saída UTF-8 do Node com a codificação padrão do subprocesso Python no Windows (`text=True` sem `encoding`). A correção foi limitada a `encoding="utf-8"` nessa comunicação; não houve reconversão dos JSONs.

Foi adicionada regressão que compara os nomes do Pareto aos nomes dos pedidos e inspeciona as strings UTF-8 do XLSX, rejeitando `AcadÃªmica`. A saída regenerada preserva `Obra Acadêmica`.
## Pendências corrigidas nesta rodada

| Pendência | Correção | Evidência | Limitação restante |
|---|---|---|---|
| Leia-me dizia sem custos | Texto harmonizado com Custos e com as parcelas 150, 120 e 30 | geração e inspeção de strings do XLSX | inspeção visual no Excel depende de aplicativo |
| Unidades pouco claras | Documentado milissegundos/86.400.000 no software e subtração de datas seriais em dias no Excel | fórmulas e documentação | Excel não foi usado para forçar recálculo |
| Pareto sem interpretação exportada | Frase gerada a partir das categorias e contagens | baseline 1/1, 50%/100% e XML da aba | sem inspeção visual no Excel |
| Exportação interpretável como dinâmica | Leia-me documenta retrato reproduzível, regeneração via JSONs e proteção de uso | proteção e comando de geração | proteção não é segurança |
| Validade simplificada | Situação e motivo agora vêm da validação do software; inválido é separado de fora do recorte | testes temporários de datas, IDs, cancelamento, referência e cutoff | base final não possui excluídos para inspeção visual |
| Custo sem relação explícita | `delayRelation` e totais por `SUMIF` | reconciliação 150 = 120 + 30 | premissas continuam fictícias e não provam causalidade |

Foram usados objetos em memória/cópias temporárias, sem alterar os JSONs finais: prazo original de 3 dias; prazo de 2 dias com 3 atrasos (60%) e Pareto Norte/Centro/Sul em aproximadamente 33,33%, 66,67% e 100%; recorte sem atrasos; uma categoria; IDs duplicados; referência inexistente; recebimento anterior à emissão; vínculo anterior ao recebimento; recebimento posterior ao corte; e limites inclusivos/exclusivos. A configuração entregue permanece com prazo de 3 dias.

## Apresentação acadêmica da planilha

O gerador aplica um padrão visual comum às seis abas: fonte Arial 11, títulos em azul-escuro, cabeçalhos em azul, fundos claros, bordas leves, linhas alternadas, quebra de texto, formatos numéricos próprios e linhas de grade ocultas. As tabelas extensas mantêm filtros, painéis congelados e um agrupamento recolhível para os campos técnicos. A aba `Custos`, por conter somente três registros, não utiliza painéis congelados. As áreas de impressão mostram a apresentação principal; o detalhamento permanece disponível no arquivo.

As seis abas usam papel A4, orientação coerente com a largura do conteúdo, rodapé com nome da aba e paginação e áreas de impressão delimitadas. O arquivo abre em `Leia-me`, com o início do conteúdo selecionado. As folhas não são protegidas, permitindo a edição manual de textos e formatos. A validação do gerador confirma abas, impressão, filtros, congelamento das tabelas extensas, ausência de painéis em `Custos`, fórmulas essenciais, gráfico combinado editável, ausência de referências externas e ausência dos erros `#REF!`, `#VALUE!` e `#DIV/0!` no pacote gerado.

### Campos técnicos e regeneração

Os campos técnicos ficam agrupados à direita nas abas `Pedidos` (colunas H:N), `Recebimentos` (I:R) e `Custos` (H:I). Eles podem ser exibidos pelo controle de estrutura de tópicos do Excel ou do Calc; se esse controle não estiver disponível, as colunas podem ser mostradas pelo menu de formatação de colunas do aplicativo.

Após qualquer alteração nos JSONs sintéticos, a exportação deve ser refeita com `npm run generate:p3`. O comando atualiza somente `exports/MASP-P3-Simulacao.xlsx` e não utiliza nem sobrescreve `MASP-P3-Apresentacao.xlsx`.
