# Continuação da P00 — a Preço Justo de ponta a ponta

Checkpoint técnico feito a pedido do dono, com 93% do limite de uso consumido.
Nada foi enviado ao GitHub, nada foi implantado, e nem o servidor nem o banco de
produção foram tocados. Este arquivo é o que basta para retomar sem reler nada.

**Data do checkpoint:** 16/09/2026, 07:40 (hora local).

---

## 1. Onde o trabalho está

| | |
| --- | --- |
| **Branch** | `audit/preco-justo-p0` |
| **HEAD** | o topo de `audit/preco-justo-p0` — os commits de documentação deste checkpoint. O último commit de CÓDIGO é `fba4f7d` (*fix(caixa): o papel e a tela do fechamento diziam que o dinheiro estava na gaveta sem saber*); os dois acima dele são este arquivo e o §12 do relatório. |
| **Base** | `8a8affd` (*fix(seguranca): a API escuta só em 127.0.0.1 por padrão*), na branch `finalization/grupo-sampaio-enterprise` |
| **Commits acumulados sobre a base** | 107 |
| **Árvore de trabalho** | `C:/Users/User/Desktop/devora-p0` — **limpa** |
| **Pasta do dono** | `C:/Users/User/Desktop/Grupo Sampaio` — intocada, segue em `8a8affd` |

---

## 2. Commits desta última rodada (os 24 sobre `c8870b0`)

Do mais novo para o mais antigo. Os três `merge(p5)` são as frentes da rodada
final que foram verificadas e juntadas; o resto entrou por elas.

| Hash | Assunto |
| --- | --- |
| `fba4f7d` | fix(caixa): o papel e a tela do fechamento diziam que o dinheiro estava na gaveta sem saber |
| `e2577f7` | merge(p5): fiscal-nfe-balcao |
| `b93f98a` | merge(p5): frete-conciliacao-comissao |
| `d7730c1` | merge(p5): venda-caixa-unidade |
| `288dfe1` | estilo(fiscal): o comentário da seção da NF-e volta a ficar colado nela |
| `6d4c537` | fix(fiscal): a emissão da NF-e da venda não declarava o que o contador ainda deve |
| `e38c6c6` | docs(caixa): o rodapé do fechamento manda resolver antes de dizer que fechar não resolve |
| `5b0eaf8` | perf(caixa): a devolução já paga não sai do banco no resumo do turno |
| `6faa7e6` | fix(catalogo): a loja que cadastra a unidade própria primeiro não nasce sem as padrão |
| `b332f73` | fix(caixa): o fechamento com devolução pendente diz a verdade — e a dívida não some no turno seguinte |
| `514d4a9` | test(pdv): a fila de vendas guardadas não entrega "Erro interno." no relançamento |
| `0fad36c` | fix(pdv): o cabeçalho da venda recusa texto vazio e número, em vez de 500 e vendedor fantasma |
| `7615564` | fix(asaas): a prontidão passa a PEDIR o modo do processo, que é o que fecha o atalho do .env |
| `adf6019` | doc(rbac): o mapa e o menu descreviam o gate anterior das telas novas do Fiscal |
| `47d58e5` | fix(fiscal): o botão "Emitir NF-e de devolução" do fornecedor seguia o PERFIL, e a rota cobra a capability |
| `168a6e1` | test(contador): o pacote pendente parava de guardar o anexo quando a máquina estava lenta |
| `618ccf7` | fix(fiscal): a ficha da venda não mostrava a NF-e que ela mesma emitiu, e a devolução dessa venda era beco sem saída |
| `a392674` | fix(fiscal): o indicador de IE era cravado '9' e o formulário não tinha campo para corrigi-lo |
| `0260a9d` | fix(fronteira): o aviso da tela que estoura para de prometer o que não entrega |
| `5c2a3e7` | fix(comissao): a faixa da vizinha não paga aqui, e quem saiu volta a poder ser descomissionado |
| `af8b244` | fix(fiscal): a segunda emissão com destinatário diferente devolvia a nota antiga como sucesso |
| `0c3cfce` | fix(conciliacao): recusa do recorte apaga os números do período anterior |
| `dc4e504` | fix(fiscal): o selo fiscal da venda enxergava só o cupom e cegava a devolução da NF-e de balcão |
| `b6679a4` | fix(frete): a cotação que vai para o histórico recusa transportadora fora do catálogo |

Os 83 anteriores estão no §8 de `P0-PRECO-JUSTO-AUDITORIA-E-CORRECAO.md`.

---

## 3. Branches e worktrees que ainda existem

### Já juntadas em `audit/preco-justo-p0` (podem ser apagadas depois da revisão)

`p00/seguranca-isolamento`, `p00/produtos-pdv`, `p00/pdv-venda`, `p00/fiscal`,
`p00/etiquetas`, `p00/asaas-frete`, `p5/venda-caixa-unidade`,
`p5/frete-conciliacao-comissao`, `p5/fiscal-nfe-balcao`, e as cinco `p0/*` da
primeira rodada.

### NÃO juntadas — é aqui que a retomada começa

| Branch | Tip | Worktree | Estado |
| --- | --- | --- | --- |
| `p5/produtos-codigos-saldo` | `5e424cd` | `.claude/worktrees/wf_c026f94c-4c3-1` (**locked**) | 9 commits, árvore **limpa**. O agente dela ainda estava rodando no instante do checkpoint. **Sem verificação adversarial lida.** |
| `p5/etiqueta-no-papel` | `6ef9d16` | `.claude/worktrees/wf_c026f94c-4c3-4` (**locked**) | 7 commits, árvore **limpa** — o agente fechou e commitou durante o checkpoint. **Sem verificação adversarial lida.** |

As duas ficaram de fora do merge de propósito: a regra deste checkpoint é não
juntar o que não foi verificado.

---

## 4. Correções concluídas e validadas (estão no HEAD)

Resumo por área; o detalhe de cada uma está no §11 do relatório P0 e na mensagem
de cada commit, que traz o defeito medido, o conserto e a mordida.

- **Produtos e códigos** — código de barras de outra empresa parava de queimar o
  código do dono; SKU casa exato em qualquer caixa; tara e pisos percentuais com
  alfândega; campos personalizados conferem o dono.
- **PDV e caixa** — `POST /core/sales`, `/core/sale-returns` e `/core/print/jobs`
  deixam de responder 500 em entrada malformada; cabeçalho da venda recusa texto
  vazio e número; a fila de vendas guardadas não devolve "Erro interno." no
  relançamento; o turno não fecha calado devendo ao cliente, a dívida acompanha o
  cliente e não a janela do turno, e o papel e a tela agora dizem **onde** o
  dinheiro está (`naGavetaCents`) em vez de supor.
- **Fiscal** — telas para operações fiscais, pendências contábeis e devolução de
  compra; NF-e de balcão emitida pela tela; segunda emissão com destinatário
  diferente recusada (409) em vez de devolver a nota antiga como sucesso; selo
  fiscal da venda enxerga os dois modelos; indicador de IE deixou de ser cravado
  '9'; devolução da venda documentada por NF-e deixou de ser beco sem saída.
- **Etiquetas** (o que já estava juntado) — a impressão usa o que o modelo grava;
  prévia e papel pelo mesmo desenhista; acesso por capability; reimpressão do
  comprovante.
- **Asaas, conciliação e frete** — uma fonte só de verdade sobre a credencial; a
  prontidão pede o modo do processo; `/logistics/quotes` recusa transportadora
  fora do catálogo; recorte de data impossível recusado sem apagar os números do
  período anterior.
- **Segurança e isolamento** — travessia de empresa na escrita de faixas de
  comissão fechada; oráculo de existência entre empresas fechado; fronteira de
  erro por tela; plaquinhas exclusivas da PJ Motors nos dois sentidos (menu,
  rota, tela e API), inclusive nas rotas de fila de impressão.

---

## 5. Correções parcialmente concluídas

1. **Etiquetas, rodada final** (`p5/etiqueta-no-papel`, tip `6ef9d16`) — sete
   commits, árvore limpa. Fecha, entre outros, a etiqueta `PRODUCT_LABEL` que
   nunca chegava à impressora e a calibração do rolo sem efeito. **Não juntar
   antes de ler a verificação.**
2. **Produtos, códigos e saldo, rodada final** (`p5/produtos-codigos-saldo`) —
   nove commits, árvore limpa, sem verificação lida.
3. **E2E da Preço Justo** — o roteiro foi atualizado para a nova regra do
   fechamento (10.9 cobra a recusa 409 nomeando a devolução; 10.10 fecha com
   ciência declarada e confere a diferença), mas **ainda não foi executado
   depois dos merges desta rodada**. O roteiro vive fora do repositório, em
   `%TEMP%/claude/C--Users-User-Desktop-Grupo-Sampaio/d394c4ce-.../scratchpad/e2e/e2e-preco-justo.mjs`,
   com o disparador `scratchpad/rodar-e2e-pj.cjs`. **Copiá-lo para
   `scripts/e2e/` é um passo pendente** — enquanto ele estiver só no temporário,
   a entrega não é reproduzível por outra pessoa.

---

## 6. Testes executados, e o que ainda falta rodar

### Executados neste checkpoint (todos verdes)

| O quê | Resultado |
| --- | --- |
| `server/tests/turno-nao-fecha-devendo-ao-cliente.test.ts` | **9/9**, com os dois casos novos (venda no cartão; dívida herdada) |
| `src/components/gs/__tests__/pendenciasEletronicas.test.tsx` | **17/17**, com os dois casos novos (cartão; corpo sem `naGavetaCents`) |
| `server/tests/contador-envio-do-pacote.test.ts` | **24/24** (conserto do relógio) |
| `npm run type-check` (tela + API) | verde |
| `eslint` nos arquivos da tela tocados | verde, 0 aviso |

### Executados na validação do merge anterior (`c8870b0`)

type-check, lint e build **0 erros**; suíte do servidor **8.323 testes ok**;
suíte da tela **345 arquivos / 3.087 testes ok**; E2E **88 PASS / 1 FAIL** — a
falha era a seção 10.9 cobrando o comportamento antigo do fechamento, já
corrigida no roteiro.

### Ainda precisam rodar (na retomada)

1. Suíte **completa** do servidor sobre o HEAD atual (o `fba4f7d` mexeu em
   `PendenciasDoTurno`, `PrintRenderer` e no contrato do resumo do turno);
2. Suíte **completa** da tela, e uma passada sob o detector de corrida
   (`ATRASO_IMMEDIATE_MS=20`);
3. `npm run build` completo;
4. **E2E** da Preço Justo com o roteiro já atualizado;
5. As suítes das duas branches não juntadas, depois do merge delas.

---

## 7. Arquivos com alteração não commitada

Na worktree de trabalho (`devora-p0`): **nenhum**. Árvore limpa.

Nas worktrees dos dois lanes (`wf_c026f94c-4c3-1` e `wf_c026f94c-4c3-4`):
**nenhum**. Ambas limpas.

Durante a escrita deste arquivo, a worktree de etiquetas ainda tinha seis
arquivos no meio do caminho (`PrintAgentQueue.ts`, `etiqueta-chega-na-impressora.test.ts`,
`EtiquetaDoProduto.tsx`, `ModelosDeEtiqueta.tsx` e os dois testes de tela deles).
Eu não os commitei de propósito — commitar por cima de um agente vivo corrompe o
trabalho dele — e o próprio agente fechou o lane no commit `6ef9d16` antes do
fim do checkpoint. Nada ficou solto.

Fora do repositório, segue a pasta do dono (`C:/Users/User/Desktop/Grupo Sampaio`)
com `.claude/launch.json` modificado: é alteração anterior a esta auditoria, não
minha, e foi deixada como estava.

---

## 8. Falhas ainda abertas (achadas, medidas, não consertadas)

Da verificação adversarial da frente de venda/caixa. As três primeiras estão
medidas por sonda HTTP, com o caminho do conserto escrito.

| Gravidade | Onde | O quê |
| --- | --- | --- |
| **Alta** | `server/src/services/core/CatalogAuxService.ts:110` | As quinze unidades padrão ainda podem nunca nascer. `jaNasceu` pergunta "existe ALGUMA das quinze siglas?" — então numa loja implantada por script, se a PRIMEIRA unidade cadastrada usar uma delas (`KG`, `CX`, `PC`…), as outras catorze não nascem e `POST /core/products` responde 400 `CORE_UNIT_NOT_FOUND` **para sempre** (listar não conserta). Medido. Caso irmão: sigla minúscula (`un`) deixa a operação com uma unidade só. O teste novo (`unidades-padrao-da-loja-nova.test.ts`) só cobre a sigla fora do vocabulário, então a suíte fica verde com o furo aberto. |
| **Média** | `server/src/services/core/SalesService.ts:824` | `origin: ""` continua entrando e é gravado como `""`, derrotando em silêncio o padrão `'pdv'`. `note` e `origin` são tratados pela mesma régua, e não são a mesma coisa: observação em branco é normal, origem em branco não. Uma linha fecha. |
| **Baixa** | `server/src/services/core/PendenciasDoTurno.ts:302` | O limite superior que sobrou (`r.created_at <= turno.closed_at`) é inalcançável: a função só roda com a gaveta aberta. Ou a leitura do turno fechado passa a existir, ou o parâmetro e o parágrafo que o explicam saem. |
| — | `p5/produtos-codigos-saldo`, `p5/etiqueta-no-papel` | Não verificadas. O que a verificação apontar entra nesta lista. |

Nenhuma das três impede a loja de vender: a primeira morde a **implantação por
script** de uma loja nova (a da Preço Justo já está semeada), a segunda suja um
campo de relatório, a terceira é documentação de um caminho morto.

---

## 9. Merges ainda pendentes

```
p5/produtos-codigos-saldo   ->  audit/preco-justo-p0
p5/etiqueta-no-papel        ->  audit/preco-justo-p0
```

Ambos **só depois** de ler a verificação adversarial de cada um e de rodar as
suítes das áreas que eles tocam.

---

## 10. Comandos exatos para retomar

```bash
cd "C:/Users/User/Desktop/devora-p0" && git log --oneline -1 && git status --short
```

```bash
git -C "C:/Users/User/Desktop/Grupo Sampaio/.claude/worktrees/wf_c026f94c-4c3-4" status --short
```

```bash
cd "C:/Users/User/Desktop/devora-p0" && git merge --no-ff p5/produtos-codigos-saldo
```

```bash
cd "C:/Users/User/Desktop/devora-p0" && git merge --no-ff p5/etiqueta-no-papel
```

```bash
cd "C:/Users/User/Desktop/devora-p0/server" && npx vitest run
```

```bash
cd "C:/Users/User/Desktop/devora-p0" && npx vitest run
```

```bash
cd "C:/Users/User/Desktop/devora-p0" && npm run type-check && npm run lint && npm run build
```

```bash
node "C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-Grupo-Sampaio/d394c4ce-5e77-4722-a903-6cca223a6de3/scratchpad/rodar-e2e-pj.cjs"
```

Se o RBAC reclamar depois de um merge (a frente fiscal mexeu no mapa):

```bash
cd "C:/Users/User/Desktop/devora-p0" && node scripts/rbac/gerar-artefatos.mjs && node scripts/rbac/gerar-capability-da-rota.mjs && node scripts/rbac/gerar-capability-da-tela.mjs
```

---

## 11. Ordem recomendada dos próximos passos

1. Conferir se os dois lanes terminaram (worktrees `-1` e `-4`) e ler a
   verificação adversarial de cada um.
2. Juntar `p5/produtos-codigos-saldo` e, depois, `p5/etiqueta-no-papel`.
3. Fechar as três falhas do §8, na ordem: unidades padrão (alta), `origin`
   vazio (média), parâmetro morto (baixa) — cada uma com teste e mordida.
4. Rodar os portões completos: type-check, lint, build, suíte do servidor,
   suíte da tela (inclusive sob o detector de corrida) e E2E.
5. Copiar o roteiro E2E para `scripts/e2e/` e pendurar um `npm run e2e:pj`, para
   a entrega ser reproduzível fora desta sessão.
6. Finalizar o §11 do relatório P0 com os números finais e commitar.
7. Só então, com o dono de acordo: `git push`, e nunca antes.

---

## 12. Pendências externas — o passo exato de cada uma

Nenhuma delas é desculpa para código incompleto: em todas, o sistema já está
pronto para receber o dado e funcionar assim que ele for informado.

| Pendência | De quem | O passo exato |
| --- | --- | --- |
| **Senha do certificado A1** | Dono | Reenviar o A1 pela tela *Fiscal › Certificado* digitando a senha na hora: ela é selada no servidor e nunca trafega em log. Sem isso o PDV segue dizendo "FISCAL NÃO CONFIGURADO". |
| **Renovação do A1** | Dono | O certificado atual **vence em 15/10/2026**. Comprar/renovar e subir o novo arquivo pela mesma tela. |
| **CSC e CSC ID** | SEFAZ-RS (portal) | Gerar o CSC de **homologação** e o de **produção** no portal da SEFAZ-RS e colar em *Fiscal › NFC-e (CSC)*. Sem ele o cupom sai sem QR e é recusado. |
| **Endereços dos web services** | Dono/TI | `SEFAZ_ENDPOINTS` está vazio. Preencher antes da primeira transmissão. |
| **Autorização real em homologação** | SEFAZ-RS | Emitir uma NF-e (55) e uma NFC-e (65) em homologação e conferir autorização, cancelamento, inutilização, consulta e devolução. O simulador não prova chave, data nem cadeia ICP-Brasil. |
| **Parâmetros do contador** | Contador | pCredSN; CST de PIS/COFINS e alíquotas; ST/CEST/FCP/DIFAL/IPI/benefícios; natureza da operação; modalidade de contingência. A tela *Fiscal › Pendências contábeis* lista cada um pelo nome. |
| **Credenciais do Asaas** | Dono | Chave real e `ASAAS_PRODUCTION_ENABLED` decidido conscientemente; a tela de prontidão agora pergunta o modo do processo em vez de acreditar no `.env`. |
| **Credenciais do Melhor Envio** | Dono | Token real em *Integrações › Logística*; o catálogo de transportadoras já recusa nome fora da lista. |
| **Impressoras de etiqueta** | Loja | Homologação física de cada modelo: leitura no caixa, calibração X/Y, mídia, escurecimento, velocidade, fontes e acentos em ZPL/EPL/TSPL. Nenhum modelo declarado compatível ainda. |
| **Papel térmico 58/80 mm** | Loja | Conferir o papel do fechamento impresso nas duas larguras (o bloco já é parametrizado; a coluna de valor é `nowrap`). |
| **Tetos de desconto por perfil** | Dono | Decidir os números na tela de permissões da Preço Justo — nenhum valor foi inventado. |
