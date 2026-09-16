# P0 — Auditoria e correção da Preço Justo

**Data:** 15/09/2026 · **Branch de trabalho:** `audit/preco-justo-p0` (a partir de `8a8affd`,
`finalization/grupo-sampaio-enterprise`) · **Worktree:** `C:/Users/User/Desktop/devora-p0`

Nenhum push, nenhum deploy, nenhuma transmissão à SEFAZ, nenhuma alteração no banco de produção
nem na VPS. O banco operacional local foi lido **somente em modo leitura**, imprimindo apenas
booleanos e campos não secretos. Todos os testes rodam em bancos descartáveis (`:memory:` e pilha
descartável), com certificados e CNPJs fictícios.

---

## 1. Estado de partida

| Item | Situação |
| --- | --- |
| Repositório | `EmanoelAngelo/erp-grupo-sampaio`, branch `finalization/grupo-sampaio-enterprise`, HEAD `8a8affd` = `origin` |
| Árvore do dono | limpa, exceto `.claude/launch.json` (local, fora do Git) |
| Branches antigas (`int/b`, `fix/csp-das-telas`, `rem/eco`) | Conferidas uma a uma: nada a portar. `int/b` está contida em `a571dc1e` (base do histórico limpo); a política de CSP das telas já existe (`POLITICA_DAS_TELAS_NO_CABECALHO` + teste); os consertos de `rem/eco` já estão nos testes `cupom-de-desconto` e `o-dia-do-relatorio-e-o-dia-da-loja`. Nenhum merge por suposição. |

### Linha de base (antes de qualquer alteração, em `8a8affd`)

| Verificação | Resultado |
| --- | --- |
| `npm ci` (raiz + servidor) | ok |
| Servidor (vitest) | 589 arquivos ok, 2 com falha — **7 957 testes ok, 3 falhas, 18 pulados** |
| Tela (vitest) | 325 arquivos, **2 965 testes ok** |
| Type-check (tela + servidor) | ok |
| Build (tela + servidor) | ok |

Das 3 falhas do servidor, **2 eram reais e anteriores a esta tarefa**: `o-contrato-de-variaveis`
acusava `DEVORA_API_HOST` sem documentação em `.env.example` e `.env.staging.example` (o commit
`8a8affd` só o pôs no exemplo de produção). A terceira (`fiscal-serie-numeracao`) foi contaminada
por uma edição desta auditoria feita durante a execução, e não conta como linha de base.

---

## 2. Por que o PDV diz "FISCAL NÃO CONFIGURADO"

### O que o selo faz

O selo do PDV (`FiscalBadgePdv`) consulta `GET /core/fiscal/pdv-summary`, que roda o checklist
de emissão da NFC-e (`buildReadiness(empresa, '65')`). Qualquer item de **configuração** em FAIL
vira `NOT_CONFIGURED`. O selo mostrava só "Esta operação ainda não emite nota." — o motivo ficava
num clique que ninguém conhecia, em texto de quem configura.

### O que está faltando na Preço Justo (banco local, somente leitura)

| Item do checklist | Situação |
| --- | --- |
| Razão social, CNPJ, CRT (1), endereço, CEP, UF (RS), código IBGE | **ok** |
| Inscrição estadual | **ok** — gravada igual ao número do contador (093/0491475), dígito do CGC/TE confere |
| Séries | NF-e 55 série 1 e NFC-e 65 série 1, ambas no **nº 1** |
| Ambiente | homologação |
| **Certificado A1** | **FAIL** — o arquivo está no cofre, mas **sem a senha selada** (gravado antes de a senha passar a ser guardada). Sem ela, o PDV e a fila não assinam. |
| **CSC** | **FAIL** — **nenhum CSC gravado** (nem de homologação, nem de produção). Sem ele não há QR Code e o cupom não vale. |
| Grupo tributário | `SIMPLES-101` existe (CSOSN 101); ver §4 sobre o que falta nele |
| Produtos ativos | 0 no banco local |

**A causa real são duas pendências de configuração do administrador:** reenviar o A1 com a senha e
gravar o CSC. Nenhuma das duas é defeito de permissão, de API ou de armazenamento: a rota de envio
sela a senha, a unidade fiscal é uma só (`unit-default`) na gravação e na leitura, e o isolamento
por empresa vem do token.

> **Atenção — vencimento:** o A1 carregado no banco local vale até **15/10/2026** — 30 dias a
> partir de hoje. Providenciar a renovação junto com o reenvio.

O banco da VPS não foi lido (proibido nesta tarefa). Se o administrador já reenviou o A1 lá, o
item do certificado passa e o que resta é o CSC. Depois do deploy desta branch, o próprio selo do
PDV passa a listar exatamente o que falta — é esse o conserto.

### Defeitos encontrados no mesmo caminho

1. **O selo não dizia o que faltava nem quem resolve.**
2. **Uma falha escondia a outra:** um único produto sem NCM fazia o selo dizer "faltam dados em
   produtos", mesmo com o certificado e o CSC faltando.
3. **"FISCAL OK" em homologação:** nota autorizada pelo simulador acendia "pronto", embora em
   homologação a nota não tenha valor fiscal.
4. **O selo sumia em qualquer falha de rede** — balcão sem selo parece balcão sem problema — e só
   se atualizava na venda seguinte, embora a configuração mude no painel administrativo.
5. **A1 gravado na operação errada:** com a operação errada selecionada no topo do painel e sem
   CNPJ de emitente nela, o A1 da Preço Justo era aceito, calado, em outra loja (201), e a Preço
   Justo continuava "não configurado".
6. **A1 de outra raiz de CNPJ:** trocar o CNPJ do emitente depois do envio deixava um certificado
   de outra raiz como utilizável; a recusa só vinha na assinatura.
7. **Numeração da homologação gastava a da produção:** a chave única do documento não inclui o
   ambiente e a série servia aos dois. Dez cupons de teste fariam o primeiro cupom real sair com o
   nº 11, contra o "nº inicial 1" do contador.
8. **NF-e do pedido online ignorava a série configurada** (`input.serie ?? 1`).
9. **A IE do RS (CGC/TE) sem conferência do dígito** e com o rótulo genérico.
10. **Regressão de linha de base:** `DEVORA_API_HOST` sem documentação nos exemplos (item do §1).

---

## 3. Correções feitas (frente fiscal)

| # | Conserto | Arquivos |
| --- | --- | --- |
| 1–4 | `ResumoFiscalDoPdv`: situação, ambiente, **uma frase com o que falta e quem resolve** (administrador, contador ou SEFAZ) e a lista item a item, com onde resolver, em texto do balcão (lista fechada: sem CSC ID, titular ou CNPJ do certificado). Configuração vence catálogo. `READY` só em produção; em homologação é "FISCAL — HOMOLOGAÇÃO", sem valor fiscal. O selo mostra a frase, a lista, "Conferir de novo", confere de novo ao voltar o foco e a cada 5 min, diz "SEM RESPOSTA" quando o servidor não responde (venda registrada não é nota autorizada) e some só em 403. | `server/src/services/core/ResumoFiscalDoPdv.ts` (novo), `server/src/routes/v1/core.ts`, `src/components/gs/FiscalBadgePdv.tsx`, `src/lib/api/core.ts` |
| 5 | Envio do A1 cujo CNPJ é o emitente de **outra** operação (e raiz diferente desta): **409 `FISCAL_CERTIFICATE_DE_OUTRA_OPERACAO`**, nada gravado. Matriz/filial (mesma raiz) continua aceita, com aviso. | `server/src/services/fiscal/FiscalCertificateService.ts` |
| 6 | Checklist: A1 de raiz diferente da do emitente é **FAIL, DIVERGENTE**. | `server/src/services/core/FiscalConfigService.ts` |
| 7 | **Série com ambiente:** coluna `core_fiscal_series.environment` (anulável; nulo = legado, serve aos dois). `resolveSerie` exige o ambiente; série marcada nunca é usada no outro. A listagem mostra o ambiente e quantas notas usaram cada série. Recusa reservar para homologação uma série que já tem nota de produção (409). A tela de Numeração ganhou o seletor de ambiente. O checklist cobra série **do ambiente** e avisa quando a legada está gastando a numeração da produção. | `server/src/db/schema.ts`, `FiscalKeyService.ts`, `FiscalDocumentService.ts`, `FiscalConfigService.ts`, `routes/v1/core.ts`, `src/pages/gs/FiscalPage.tsx`, `src/lib/api/core.ts` |
| 8 | A NF-e do pedido online resolve a série configurada do ambiente. | `server/src/services/core/OrderInvoiceService.ts` |
| 9 | Rótulo "Inscrição estadual (CGC/TE)" no RS e conferência do dígito (módulo 11, pesos 2,9,8,7,6,5,4,3,2). O número **não é reescrito** (a barra é formatação; o XML já leva só os dígitos). Dígito errado: PENDING/DIVERGENTE (a palavra final é do cadastro da SEFAZ); ausente: FAIL. | `server/src/services/core/InscricaoEstadualRs.ts` (novo), `FiscalConfigService.ts` |
| 10 | `DEVORA_API_HOST` documentado em `.env.example` e `.env.staging.example`. | `.env.example`, `.env.staging.example` |

### Migração

Uma só, **aditiva e idempotente**: `core_fiscal_series.environment TEXT` (anulável). Entra pelo
`reconcileCoreSchema`, que acrescenta colunas ausentes sem tocar em nenhuma linha. Nenhum dado
apagado ou reescrito; as séries existentes ficam "servem aos dois", exatamente como hoje.

### O que o administrador faz para a Preço Justo emitir (depois do deploy)

1. **Painel administrativo › Fiscal › Certificado**, com a **Preço Justo** selecionada no topo:
   reenviar o `.pfx` com a senha (sela a senha e preenche o cartão). Renovar antes de 15/10/2026.
2. **Fiscal › Configuração › CSC:** gravar o CSC ID e o CSC de **homologação** (portal da
   SEFAZ-RS, login do dono); gravar o de **produção** antes da virada.
3. **Fiscal › Configuração › Numeração:** marcar NF-e 55/1 e NFC-e 65/1 como **"só produção"**
   (nº 1, conforme o contador) e cadastrar uma série **"só homologação"** para os testes (sugestão:
   série 2 — confirmar com o contador).
4. Grupo tributário: completar com o contador o que está na §4.

---

## 4. Parâmetros do contador

Todos são **dado por empresa** (emitente, séries e grupo tributário), nunca regra global no
código.

| Parâmetro informado | Onde fica | Estado |
| --- | --- | --- |
| Simples Nacional, CRT 1 | Fiscal › Emitente (`core_fiscal_configs.crt`) | Gravado e validado contra a lista do leiaute |
| CGC/TE 093/0491475 | Fiscal › Emitente (IE) | Gravado igual ao informado; dígito do RS confere; campo agora rotulado "Inscrição estadual (CGC/TE)" |
| NF-e 55, série 1, nº inicial 1 | Numeração | Gravado; marcar "só produção" |
| NFC-e 65, série 1, nº inicial 1 | Numeração | Gravado; marcar "só produção" |
| CSOSN 101 | Grupo tributário `SIMPLES-101` | Gravado (ver pendências) |
| CFOP 5102 (RS) / 6102 (outras UFs) | Grupo tributário (CFOP interno / interestadual) | _frente de emissão — ver §5_ |
| PIS/COFINS "CST 49" | Grupo tributário | _frente de emissão — ver §5_ |

### Pendências contábeis (o sistema não inventa valor)

- **pCredSN** (alíquota de crédito do Simples): o CSOSN 101 exige `pCredSN` e `vCredICMSSN` no
  XML e o contador não informou a alíquota.
- **CST 49:** confirmar se vale para PIS **e** COFINS, e as alíquotas.
- ST, CEST, FCP, DIFAL (venda interestadual a não contribuinte), IPI, benefícios fiscais, natureza
  da operação por tipo de venda e exceções por produto.
- Modalidade de contingência da NFC-e (off-line tpEmis 9 e prazo), que o sistema já pede ao
  contador.

---

## 5. Demais frentes

As frentes rodaram em paralelo, cada uma na sua branch local (`p0/*`), e foram juntadas nesta
branch com `merge --no-ff` depois de conferidas (type-check e testes da frente sobre a junção).

### 5.1 Produtos e fotos no PDV — `p0/pdv-produtos-fotos`, junção `e08bcac`

| Requisito | Antes | Depois |
| --- | --- | --- |
| Busca por nome, código interno, SKU, código de barras e código adicional | ok | ok, agora coberto por teste |
| Preço vigente, saldo, variante (o PDV vende a variante, nunca o modelo) | ok | ok; variantes de modelo arquivado também somem |
| Inativo nunca vendável | ok | ok |
| Foto no PDV | inexistente | **miniatura** na busca e na pesquisa avançada (F4); variante sem foto mostra a do modelo |
| Sem download pesado | a busca devolvia `image_url` (original) | a busca não devolve mais o original; o componente só aceita a miniatura |
| Tamanho/formato | — | miniatura gerada **no navegador** ao enviar a foto (≤ 160 px, ≤ 40 KB, WebP/JPEG), conferida pelo servidor; nenhuma dependência nova |
| Sem foto / off-line | — | espaço neutro do mesmo tamanho, nunca imagem quebrada; off-line usa o cache do navegador e não repete o pedido até a rede voltar |
| Fotos antigas | — | preenchimento em lote (Fotos em lote › "Gerar miniaturas") ou ao abrir a galeria; nunca apaga nem substitui |
| Fiscal incompleto | a NFC-e era recusada DEPOIS do pagamento | selo por item na busca e no carrinho (NCM, CFOP, origem, CEST, tributação), com a mesma régua da NFC-e; a venda não é bloqueada |
| Isolamento entre empresas (busca, imagem por id, fila) | busca ok | coberto por teste em todos |

Esquema: `core_product_images.thumb_url` e `thumb_bytes` (anuláveis, pelo reconcile). Rotas novas
sob `products.manage` (o operador de caixa recebe 403). Riscos: fotos antigas aparecem como espaço
neutro até o lote de miniaturas rodar; a validação da miniatura lê o cabeçalho, não decodifica a
imagem inteira (teto de 40 KB e cabeçalhos de segurança continuam).

### 5.2 Permissões de desconto — `p0/descontos`, junção `028d073`

| Requisito | Antes | Depois |
| --- | --- | --- |
| Limite por perfil, por empresa | um % para a empresa inteira; gerente sem teto | tabela `core_discount_limits` (empresa × perfil: % e R$ da venda, % e R$ por item); sem linha, vale o de hoje |
| Teto em R$ e por item | inexistente | aplicado, inclusive no preço unitário rebaixado |
| Item + rodapé juntos | só o % da venda | os dois conferidos |
| Liberação do gerente | existia, mas liberava qualquer valor | o servidor lê a liberação gravada e confere a ALÇADA de quem liberou |
| Motivo obrigatório | texto livre montado pela tela | motivo digitado e gravado; exigência por empresa — **ligada só na Preço Justo** (passo idempotente que só preenche o nulo) |
| Auditoria | gravava o id mandado pelo cliente | quem aplicou, quem liberou, motivo, excesso, antes e depois — tudo do servidor; senha nunca registrada |
| Comparação | ponto flutuante (7% exatos num teto de 7% pedia gerente) | centavos inteiros |
| Negativo / maior que o item / total < 0 | já recusado | mantido, coberto |
| Corpo forjado (perfil, autorizador, total, limite, preço) | a trilha levava o id do cliente | ignorado em todo lugar |
| Gerente ou liberação de outra operação | já recusado | mantido, coberto |
| Off-line | media pelo limite de quem reenviava | régua mais estreita entre quem vendeu e quem reenvia; acima do limite fica em "Regularizar"; reenvio idempotente |

Pendência do dono: **os tetos por perfil da Preço Justo não foram inventados** — até serem
preenchidos na tela da política, vale o % da empresa (10% no padrão) e o gerente segue sem teto.

### 5.3 Plaquinhas exclusivas da PJ Motors — `p0/plaquinhas-pj-motors`, junção `fd00639`

- **Regra:** usa plaquinha quem tem a marca `uses_equipment_tags` **e** é a PJ Motors (slug
  `pj-motors`). Toda rota de plaquinha confere antes: pool, lotes, layout, folha/prévia,
  liberação, avaria e troca, etiqueta e folha por máquina, formatos, candidatos e vínculo por
  unidade, reimpressão e desvínculo, trabalho de impressão, e a escolha no cadastro da máquina —
  **403 `CORE_COMPANY_NO_TAGS`** (era 409). Ligar a marca em outra empresa: **403
  `CORE_COMPANY_TAGS_PJ_ONLY`**; empresa nova nasce sem plaquinha.
- **Tela:** menu, rota e telas só na PJ Motors; URL direta em outra empresa mostra "não disponível
  nesta empresa" sem chamar a API.
- **Dados:** nenhuma DDL, nenhuma linha apagada. `ensureOfficialTagCompanies` marca só a PJ Motors
  e não limpa ninguém; a marca antiga da Oficina fica no banco mas não concede mais nada.
- **Oficina (mudança em relação à regra antiga "PJ Motors e Oficina"):** mantém, só para leitura,
  o número da máquina na OS e o QR de acompanhamento do cliente; perde menu, tela, geração,
  impressão, troca e escolha de plaquinha.
- **Decisão do dono pendente:** com a Oficina bloqueada e a PJ Motors já barrada pela regra da
  bancada (GAP-PRD-110), **ninguém gera lote novo de plaquinhas hoje**. As saídas (PJ gerar sem
  bancada, ou a Oficina cadastrar máquina com número da PJ) são decisão de produto.
- Outros riscos anotados: o texto "Plaquinha #000N" ainda sai na OS impressa da Oficina; `pj-motors`
  não está na lista de slugs reservados.

### 5.4 Emissão fiscal — `p0/fiscal-emissao`

Tudo com o simulador e A1 gerado no próprio teste; nenhuma SEFAZ real.

| Requisito | Antes | Depois |
| --- | --- | --- |
| CSOSN 101 com pCredSN, por empresa | funcionava, só como recusa na emissão | provado; grupo sem pCredSN é recusado ANTES de numerar |
| PIS/COFINS CST 49 | já saía em `PISOutr`/`COFINSOutr` zerado | provado |
| CFOP 5102 (RS) × 6102 (outra UF) | o CFOP do produto vencia o destino: NF-e interestadual saía com 5102 e idDest 2 (pedidos online para outro estado) | CFOP resolvido pelo destino; 5102 copiado no produto vira o 6102 do grupo; exceção do produto de outro alcance é recusada antes de numerar |
| NFC-e nunca interestadual | qualquer CFOP passava | só 5xxx, idDest 1, indFinal 1 |
| Contribuinte × consumidor final | indFinal só pelo indicador de IE; "ISENTO" gerava `<IE>` vazio | IE só dígitos (CGC/TE com barra vira os 10 dígitos); ISENTO com indicador 1 recusado; consumidor final declarável |
| Devolução de venda e de compra | não existia | NF-e finNFe 4 com NFref: venda = tpNF 0, 1202/2202; compra = tpNF 1, 5202/6202; idempotente; DANFE diz ENTRADA e a nota referenciada |
| Prazo de cancelamento | não conferido | por empresa e operação; recusado antes de chamar a SEFAZ; sem prazo cadastrado, a SEFAZ decide |
| Rejeição não queima número | rejeitada ficava rejeitada para sempre | reemissão com a MESMA série e número e chave nova; recusa denegada, duplicidade, número inutilizado e troca de ambiente |
| Inutilização só do não usado | qualquer linha bloqueava | rejeitada e nunca enviada se inutilizam; autorizada, denegada e 539 não |
| Consultar antes de retransmitir | a retentativa depois de consulta falha autorizava direto: 204/105 viravam REJECTED (risco de segunda nota) | entrega incerta consulta primeiro; resposta inconclusiva fica na fila; o trabalhador retoma sozinho |
| Um documento por venda | só por (venda, modelo): NFC-e e NF-e podiam sair as duas | o segundo modelo é recusado enquanto o outro vale; clique duplo = um documento, um número |
| Intervenção do administrador | — | `POST /fiscal/documents/:id/reemitir`, `GET/PUT /fiscal/operacoes`, `GET /fiscal/pendencias-contabeis` |
| Venda off-line ≠ NFC-e autorizada | comportamento existente, sem prova ponta a ponta | provado: tpEmis 9 → CONTINGÊNCIA, "pendente de autorização", sem protocolo; DANFCE diz "EMITIDA EM CONTINGÊNCIA", "SEM PROTOCOLO" e, em homologação, "SEM VALOR FISCAL"; venda sem NFC-e só tem "COMPROVANTE NÃO FISCAL" |
| Segredo fora de log | não provado | fluxo inteiro (emitir, queda de rede, cancelar, inutilizar) sem senha do A1, CSC, chave privada, SignatureValue ou conteúdo do certificado em console, auditoria, eventos, fila ou outbox |

Esquema: tabela `core_fiscal_operations` e colunas anuláveis `origin_type`, `origin_id`,
`referenced_access_key` em `core_fiscal_documents`. Seis rotas novas sob `requireCapability`.

Riscos anotados: SVC da NF-e não implementado (tpEmis 6/7) — NF-e com a SEFAZ fora espera na fila;
só a NFC-e tem contingência off-line (tpEmis 9). Reemitir NFC-e off-line rejeitada troca a chave
do DANFCE já entregue. As rotas novas não têm tela ainda (só API). A tributação da devolução usa o
grupo do produto, sem reproduzir ST/IPI/FCP da nota de compra original. Os endpoints reais da
SEFAZ-RS estão vazios (`SEFAZ_ENDPOINTS`): a transmissão real depende de configurá-los.

### 5.5 Etiquetas da Preço Justo — `p0/etiquetas`

**Já existia:** fila de vários produtos (7 origens), quantidade por produto, lote em folha, campos
nome/preço/SKU/código de barras/variação, geometria do modelo (tamanho, papel, margens, espaços,
orientação, colunas, linhas, 203/300/600 dpi, escala), posição inicial em folha e prévia HTML
igual à impressão.

**Acrescentado:**

| Requisito | Como ficou |
| --- | --- |
| Layout sem sobreposição, texto sem corte, preço em destaque | `LabelLayout.ts` (puro): cada etiqueta vira caixas em pontos da impressora; texto quebra e termina em reticências; o campo que não cabe sai com aviso nomeado; sem preço e código, a etiqueta é recusada |
| Código de barras legível | módulo em número inteiro de pontos do dpi do modelo, zona de silêncio dentro da caixa; aviso abaixo do módulo nominal GS1 (ex.: rolo 33 mm a 203 dpi) |
| Rolo e folha, 1–3+ colunas, posição inicial, calibração | paginação única; pular a etiqueta da esquerda no rolo de 2 colunas; deslocamento X/Y (±10 mm) |
| Validade / lote | o lote informado no item ou o de vencimento mais próximo com saldo; sem lote com saldo, sem linha |
| Saídas | navegador, driver Windows, térmica genérica, **PDF vetorial, ZPL, EPL2, TSPL** e prévia SVG — tudo do MESMO layout (teste confere o código de barras no mesmo ponto na prévia e no arquivo); térmica recusa folha A4 com motivo |
| Configuração no modelo | saída padrão, calibração X/Y, escurecimento, velocidade, corte, sensor de mídia, espaço entre etiquetas, avanço final |
| Teste, reimpressão, quem imprimiu | etiqueta de teste (EAN de amostra 040…, moldura de calibração); histórico com quem imprimiu, formato, saída, itens, quantidades e preço impresso; reimpressão com o preço de hoje |

Esquema: 9 colunas anuláveis em `core_label_templates` e a tabela `core_label_print_jobs`
(aditivos; teste reconstrói a tabela antiga e confirma). Rotas novas: `GET /labels/prints`,
`POST /labels/prints/:id/reprint`, `POST /labels/test`, sob `labels.products.print`.

**Depende de homologação física** (nenhum modelo declarado compatível; a lista aparece ao lado
da escolha da saída): cada modelo e firmware da loja (Argox fala PPLA/PPLB, não gerado — vai pela
térmica genérica); leitura de cada tipo de código no caixa, principalmente em rolo estreito;
calibração X/Y por impressora; mídia real (gap, marca preta, contínua); largura da cabeça contra
rolos de 2 e 3 colunas; escurecimento e velocidade para o papel e a fita reais; fontes
residentes, acentos e página de código no ZPL/TSPL/EPL; cortador; driver Windows no tamanho
exato; PDF impresso em "tamanho real".

Riscos anotados: ZPL/EPL/TSPL saem como arquivo para baixar (o agente local de impressão é
restrito a impressora de cupom — envio cru pela porta 9100 seria outra mudança); a tela ainda não
oferece escolha de lote; o histórico de impressão não entra na limpeza de demonstração.

---

## 6. Testes (resultados reais)

### Validação final da branch (as cinco frentes juntadas, `aa6c0b1`)

| Verificação | Linha de base (`8a8affd`) | Final |
| --- | --- | --- |
| Servidor (vitest, suíte completa) | 7 957 ok, 3 falhas, 18 pulados (591 arquivos) | **8 187 ok, 0 falha, 18 pulados (607 arquivos)** |
| Tela (vitest, suíte completa) | 2 965 ok (325 arquivos) | **3 018 ok (333 arquivos)** |
| Type-check (tela + servidor) | ok | ok |
| Build (tela + servidor) | ok | ok (`out/index.html`, `server/dist/index.js`); só o aviso de tamanho de pacote do Vite, que já existia |
| Lint dos arquivos alterados (47 da tela, 90 do servidor) | — | tela limpa; servidor com 2 erros em testes das etiquetas, corrigidos em `aa6c0b1` e relintados |
| E2E da Preço Justo (pilha descartável, logins padrão, senhas aleatórias só no ambiente) | 68/68 (seções 0–10) | **89/89** (seções 0–13; 148 requisições, todas para a pilha descartável) |

As seções novas do E2E: **11** — o operador de caixa lê o resumo fiscal com o que falta e quem
resolve, sem segredo; PDV e gerente não leem nem enviam A1; séries por ambiente; ambiente
inventado recusado. **12** — plaquinha recusada na Preço Justo e na Oficina (até para o admin,
com o código da regra da empresa), ligar a marca fora da PJ recusado, pool respondendo na PJ
Motors. **13** — as sete saídas e a lista de homologação; etiqueta de teste em ZPL, TSPL, EPL e
PDF; térmica em A4 e saída inventada recusadas; lote de 3 no rolo de 2 colunas; histórico com
quem imprimiu; reimpressão em outra saída.

Cobertura mínima pedida, onde está: A1 válido/inválido/vencido/senha errada/CNPJ divergente e de
outra operação (`o-a1-na-porta-de-entrada`, `o-selo-fiscal-do-pdv-diz-o-que-falta`); NF-e e
NFC-e em homologação simulada, séries, rejeição, retentativa, idempotência, queda e volta da
internet, DANFE, cancelamento e inutilização (`p0-fiscal-*` e a suíte fiscal existente);
produtos e fotos (`pdv-produtos-e-miniaturas`, `pdvMiniaturasEFiscal`); descontos
(`desconto-por-perfil-com-motivo`); etiquetas de 1 e várias colunas (`etiquetas-layout`,
`etiquetas-comandos`, `etiquetas-perfis-rotas`); plaquinhas bloqueadas fora da PJ Motors
(`plaquinhas-so-na-pj`, `plaquinhasSoNaPj`); sem segredo em código e log
(`o-a1-na-porta-de-entrada`, `p0-fiscal-offline-e-segredos`, a varredura de segredo do E2E).

### Testes da frente de status fiscal

| Conjunto | Resultado |
| --- | --- |
| `server/tests/o-selo-fiscal-do-pdv-diz-o-que-falta.test.ts` (novo) | 18/18 |
| `server/tests/o-a1-na-porta-de-entrada.test.ts` (novo) | 10/10 |
| `src/components/gs/__tests__/seloFiscalDizOQueFalta.test.tsx` (novo) | 6/6 |
| 99 arquivos fiscais do servidor (filtro por fiscal, nfce, nfe, certificado, série, prontidão, danf, csc, emissão, dfe, icms, pis-cofins, municípios…) | 98/99 na primeira rodada; o arquivo que falhou (`o-a1-avisa-antes-de-vencer`, 5 casos) enviava para a Gringa o A1 da Preço Justo — o gesto que agora é recusado. Fixture corrigido (A1 fictício próprio da Gringa): 21/21 |
| `o-contrato-de-variaveis` | 23/23 (era 21/23 na linha de base) |
| Tela: selo, contingência, numeração e CSC, painel auxiliar | 23/23 |
| Type-check tela e servidor; eslint dos arquivos alterados | ok |

---

## 7. Dependências externas

| De quem | O quê |
| --- | --- |
| **Dono / administrador** | Reenviar o A1 com a senha; **renovar o A1 (vence 15/10/2026)**; CSC de homologação e de produção no portal da SEFAZ-RS; marcar as séries por ambiente. |
| **Contador** | pCredSN; CST de PIS/COFINS e alíquotas; ST/CEST/FCP/DIFAL/IPI/benefícios; natureza da operação; modalidade de contingência. |
| **SEFAZ-RS** | Primeira autorização real em homologação (o simulador não prova chave, data nem cadeia ICP-Brasil). Os endereços reais dos web services estão vazios (`SEFAZ_ENDPOINTS`): configurá-los é pré-condição da primeira transmissão. Homologar de verdade: autorização 55 e 65, cancelamento, inutilização, consulta e devolução (NFref). |
| **Impressoras de etiqueta** | Homologação física de cada modelo e firmware da loja (lista em §5.5): leitura dos códigos no caixa, calibração X/Y, mídia, escurecimento e velocidade, fontes e acentos em ZPL/EPL/TSPL. Nenhum modelo declarado compatível. |
| **Dono — decisões de produto** | Tetos de desconto por perfil da Preço Justo (a tela existe; nenhum número foi inventado). Quando gerar o próximo lote de plaquinhas (a PJ Motors gera, imprime e administra — §10.1; nenhuma outra empresa alcança). Gerar as miniaturas das fotos antigas (Fotos em lote). |

---

## 8. Commits (locais, sem push)

| Hash | Assunto |
| --- | --- |
| `496ca05` | fix(config): DEVORA_API_HOST documentado nos exemplos de desenvolvimento e homologação |
| `4b5f18b` | fix(fiscal): a série tem ambiente — o teste da homologação não gasta a numeração da produção |
| `40f5f93` | fix(fiscal): o A1 de outra operação do grupo é recusado no envio |
| `ca83991` | fix(fiscal): a prontidão enxerga a série do ambiente, o A1 de outra raiz e o CGC/TE do RS |
| `82827e3` | fix(fiscal): o selo do PDV diz o que falta e quem resolve |
| `e08bcac` | merge(p0): produtos e fotos no PDV — miniatura, busca e fiscal incompleto no balcão |
| `028d073` | merge(p0): permissões de desconto — limite por perfil, alçada de quem libera e motivo obrigatório |
| `fd00639` | merge(p0): plaquinhas só na PJ Motors — servidor, menu, rota e telas |
| `1b0d0ee` | test(rbac): a varredura do contador conta as duas rotas das miniaturas do PDV |
| `93fa3e6` | test(fiscal): o teste de comunicação com a SEFAZ dá à Gringa o próprio A1 |
| `03c319d` | merge(p0): etiquetas da Preço Justo — layout em pontos, ZPL/EPL/TSPL/PDF, teste, histórico e reimpressão |
| `df0589e` | merge(p0): emissão fiscal — fila que consulta antes, CFOP do destino, um documento por venda, reemissão e devolução |
| `aa6c0b1` | test(etiquetas): os dois testes da frente passam no lint do servidor |

Os commits de cada frente continuam no histórico, dentro de cada junção: fotos `098cb92..b1fa5ca`
(4), descontos `e7a9286..f666aef` (6), plaquinhas `2155db4..ace6aa3` (2), etiquetas
`e3e1504..9533f44` (5), emissão fiscal `85092e5..af1e18c` (6).

### Resoluções nas junções

- **Varredura do contador:** cada frente cravou o número de rotas contra a própria base; na junção
  a conta soma as três (fotos +2, etiquetas +3, fiscal +6): **550 rotas, 546 fechadas ao
  contador**.
- **RBAC:** `mapa-final.json` recomposto mecanicamente (lado da P0 + as 6 entradas fiscais que a
  base não tinha, com o formatador conferindo o arquivo byte a byte antes de escrever); a linha de
  base e os demais artefatos **regenerados** pelos três geradores, não editados à mão.
- **NFC-e só com CFOP interno:** a frente fiscal pôs a regra no laço de `validateNfce`; a frente
  das fotos tinha extraído esse laço para `problemasFiscaisDoCadastro`, a régua única da nota e do
  selo de fiscal incompleto do balcão. A regra entrou na régua única — o balcão avisa o mesmo que a
  nota recusa.
- **Série do ambiente:** a NF-e do pedido (agora montada por `prepararNfeDoPedido`) e a NF-e de
  devolução resolvem a série com o ambiente, como a venda de balcão.
- **Pendências contábeis na prontidão:** item informativo (PENDING ou PASS, dono o contador),
  nunca trava a emissão.
- **Fixtures de A1:** dois testes gravavam o A1 de um CNPJ que é emitente de outra operação — o
  gesto que agora é recusado — e ganharam A1 fictício próprio.

---

## 9. O que não foi feito, e os limites do que foi provado

- **Nada saiu desta máquina:** sem push, sem deploy, sem acesso à VPS, sem transmissão à SEFAZ
  (nem de homologação). O banco operacional local foi lido só em modo leitura; o da VPS não foi
  lido.
- **Nenhum segredo real em teste:** certificados, CNPJs e IEs dos testes são fictícios (a única
  exceção é o número do CGC/TE informado pelo contador, usado só para provar que o dígito dele
  confere — é dado público de cadastro, não credencial).
- **O simulador não prova a SEFAZ:** chave, data de emissão, cadeia ICP-Brasil e as regras de
  validação da SEFAZ-RS só se confirmam na primeira transmissão real em homologação.
- **Impressão física não testada:** as saídas ZPL/EPL/TSPL/PDF foram conferidas como arquivo; a
  leitura dos códigos e a calibração dependem das impressoras da loja (§5.5).
- **E2E pela API:** o E2E da Preço Justo roda contra a pilha descartável pela API (logins padrão,
  gestor e PDV); as telas foram cobertas pelos testes de componente, não por navegador.
- **Frentes sem tela:** as rotas novas da emissão fiscal (reemitir, operações fiscais, pendências
  contábeis, NF-e de devolução) têm API e testes, mas ainda não têm tela.
- **Worktrees das frentes:** as branches `p0/*` e as worktrees de trabalho dos agentes
  (`.claude/worktrees/agent-*` na pasta do dono) ficaram no lugar — nada foi apagado; o conteúdo
  delas já está nesta branch.
- **Aviso de build pré-existente:** o aviso de tamanho de pacote do Vite já aparecia na linha de
  base; não é desta entrega.

---

## 10. Pendências fechadas depois do relatório

### 10.1 O teste da tela do CSC (instável sob carga)

- **Causa:** o teste, não a tela. O `abrir()` esperava o título "Numeração das notas", que é
  desenhado no primeiro render e não depende de resposta nenhuma, e em seguida procurava de forma
  síncrona o cartão do CSC — que só monta depois que a configuração fiscal chega
  (`{config && <CscCard/>}`), com a lista do cofre numa segunda leitura. Sem carga, a
  re-renderização costumava cair antes da consulta; com a CPU disputada, não.
- **Descartados, com evidência:** concorrência entre arquivos (cada arquivo no seu processo do
  vitest), estado compartilhado (fetch novo por caso, sessão e `localStorage` limpos a cada caso),
  banco (jsdom, sem banco), mocks (nenhuma rota sem resposta).
- **Prova:** o mock passou a responder a configuração e a lista do CSC só depois das séries (+100
  ms), sempre; com o `abrir()` antigo o caso falha com o mesmo erro em 4 de 4 execuções, com e sem
  carga.
- **Conserto:** os casos esperam o estado que conferem (o cartão montado e os selos lidos do cofre);
  o atraso de ordem ficou permanente nos quatro arquivos que desenham a tela fiscal. Sem repetição
  e sem tempo maior como remédio. Sob carga (8 laços ocupados): 30/30 execuções verdes.
- **Produto:** a investigação achou um defeito real — o selo do CSC dizia NÃO CONFIGURADO antes de
  ler o cofre e, com a leitura recusada, para sempre. Agora diz CONSULTANDO… e SITUAÇÃO
  DESCONHECIDA.
- Commits: `56c1885` (selo) e `a89e0e4` (testes).

### 10.2 Plaquinhas: a PJ Motors gera sem bancada

- **Causa:** a regra antiga GAP-PRD-110 exigia bancada ativa para gerar, imprimir a folha do lote e
  liberar; a PJ Motors, única empresa com plaquinha, não tem bancada — ninguém gerava lote.
- **Conserto:** a regra da empresa é o portão inteiro (`8b88cc7`). As outras empresas seguem com
  403.
- **O que a verificação achou em seguida:** gerar não bastava. A plaquinha gerada pela PJ nunca
  virava "associada" — isso só acontecia no cadastro de MÁQUINA, que exige bancada — e o QR dela
  respondia 404. A PJ imprimiria adesivos mortos.
- **Conserto (`418aad1`), escolhido entre três desenhos:** a plaquinha da PJ passa a ser colada
  numa moto do estoque dela (`core_equipment_tags.unit_id`, coluna anulável; sem máquina nem
  bancada de mentira). Estoque › Unidades ganha colar, descolar (só com a moto no pátio) e trocar
  adesivo (o velho vira danificado, o QR velho morre na hora). O QR da plaquinha colada responde
  com a moto (marca, modelo, PJ Motors, "Disponível na loja"); a não colada responde 404 dizendo que
  ainda não foi vinculada, sem número nem empresa. `POST /print/jobs` com plaquinha passou a exigir
  a permissão de imprimir plaquinha: o PDV não imprime. Três rotas novas; 553 rotas, 549 fechadas
  ao contador.

### 10.3 A classe de corrida na suíte inteira da tela

- O teste do CSC era um caso de uma classe: o teste espera um elemento do primeiro render e lê de
  forma síncrona o que só aparece depois de uma resposta. Um detector (o `setImmediate` adiado nos
  processos do vitest, por onde o React 19 desenha fora do `act`) tornou todos determinísticos:
  3 022 testes varridos, 29 casos da classe em 17 arquivos, corrigidos para esperar a condição real
  (`97f8aad`).
- A varredura achou dois defeitos reais de produto no PDV (`808c1c9`): os ouvintes de tecla com
  estado religavam depois do commit (a tecla caía no ouvinte velho — o F6 com a pré-venda recém
  carregada não perguntava nada) e o campo de leitura soltava o código lido só no render seguinte
  (o bipe B ia para trás do A). Os ouvintes passaram a ligar no commit e o campo, a soltar a leitura
  no mesmo instante.

---

## 11. Prioridade 00 — a Preço Justo funcionando de ponta a ponta

Seis frentes varreram e **consertaram** as áreas que a entrega depende, cada uma na própria
branch, juntadas nesta: `p00/seguranca-isolamento`, `p00/produtos-pdv`, `p00/pdv-venda`,
`p00/fiscal`, `p00/etiquetas`, `p00/asaas-frete`. Cada conserto tem comentário com o defeito
antes da correção, teste que o prova e mordida (o teste fica vermelho quando o conserto é
desfeito). Depois de cada frente, verificação adversarial independente — e o que ela ainda
apontou virou a rodada seguinte.

### 11.1 Cadastro de produtos, códigos e estoque

| Defeito | Conserto |
| --- | --- |
| `POST /products/:id/barcodes` não conferia de quem era o produto: outra empresa cadastrava código no produto da Preço Justo (201), o código ficava **queimado** para o dono e o balcão da outra loja passava a atender ao bipe | O dono é conferido (404 como nas rotas irmãs); os leitores que decidem "este código está livre" passaram a exigir que empresa do código e do produto sejam a mesma, o que deixa inerte a linha torta herdada |
| O SKU não era achado no balcão em outra caixa e não contava como casamento exato (digitar `sh-200` para o SKU `SH-200` devolvia vazio) — caminho direto para o mesmo item ganhar dois cadastros | Uma expressão só decide "casou por código" (barras, interno, SKU, adicional), com a mesma régua do cadastro |
| Tara e pisos percentuais entravam crus: `abc` ficava gravado em coluna inteira e ia para a balança; tara negativa faz a balança somar peso; piso configurado no POST não valia para nada, em silêncio | Alfândega única na criação e na edição (tara em gramas inteiras ≥ 0; percentual ≥ 0), com recusa nomeada; o clone não herda o que não é número |
| `PUT /products/:id/custom-fields` conferia a definição do campo, não o dono do produto | Conferência de dono, como nas irmãs |
| Saldo preso no modelo de grade não tinha como sair (o movimento é recusado no modelo) | Caminho de regularização, alcançável pela tela de Movimentações |

### 11.2 Venda no PDV e caixa

| Defeito | Conserto |
| --- | --- |
| `POST /core/sales` — a rota mais usada — respondia **500 "Erro interno."** em caminhos de entrada malformada | Recusa 4xx com motivo, no lugar do 500 |
| `POST /core/sale-returns` e `POST /core/print/jobs` idem (cópias não numéricas, linha do pedido ausente) | Idem |
| O turno de caixa fechava **calado devendo dinheiro ao cliente**: devolução em duas etapas sem reembolso não aparecia no fechamento | O fechamento nomeia a pendência e não deixa fechar calado |

### 11.3 Fiscal

| Defeito | Conserto |
| --- | --- |
| Três rotas fiscais existiam e **nenhuma tela as chamava** (operações fiscais, pendências contábeis, devolução de compra) | Telas construídas: o dono cadastra a operação fiscal, vê as pendências do contador e emite a devolução |
| A NF-e de devolução de venda existia no servidor e não tinha gesto na tela | Gesto na tela da devolução |
| `createNfeForSale` existia inteiro e **nenhuma tela emitia NF-e de venda de balcão** | A venda de balcão emite NF-e (modelo 55) pela tela, com destinatário validado |
| A contagem de exceções por produto casava o grupo tributário só pelo perfil | Casamento correto |

### 11.4 Etiquetas

| Defeito | Conserto |
| --- | --- |
| O painel "saída, calibração e mídia" do modelo era **decorativo**: gravava nove campos que a impressão ignorava | A impressão usa o que o modelo grava |
| A fila não sabia qual lote ia para o papel; a folha do navegador (a saída padrão) saía muda | Lote escolhido e avisado; a folha do navegador diz o que as outras dizem |
| A prévia era desenhada por outro desenhista que não o da impressão | Prévia e papel pelo mesmo layout |
| Dois becos de acesso (Impressoras por perfil; aba Etiqueta do cadastro sem perfil) | Acesso por capability, com a tela dizendo o motivo |
| Não havia como reimprimir o comprovante de uma venda passada | Reimpressão do comprovante |

### 11.5 Asaas, conciliação e frete

| Defeito | Conserto |
| --- | --- |
| A tela de Integrações e a cobrança discordavam sobre a MESMA chave (a do `.env` aparecia como "credencial desta operação") | Uma fonte só de verdade sobre a credencial |
| `test-quote`/`test-tracking` aceitavam transportadora desconhecida vinda da URL | Recusa com motivo, pelo catálogo |
| A conciliação aceitava recorte de data impossível e respondia "não houve o que conferir" | Recusa com motivo |

### 11.6 Segurança e isolamento

| Defeito | Conserto |
| --- | --- |
| Travessia de empresa na escrita de faixas de comissão; oráculo de existência entre empresas; 500 onde o certo é 404 | Conferência de empresa em cada escrita e leitura; recusa nomeada |
| Pessoa fora do vínculo virava vendedor comissionado | Vínculo conferido |
| Uma tela que estourava derrubava o sistema inteiro (uma fronteira de erro só) | Fronteira por tela: o resto do sistema continua de pé |
| `npm run lint` da tela estava **vermelho na base** | Verde |
---

## 12. Checkpoint de 16/09/2026 — onde a entrega parou

Feito a pedido do dono, com 93% do limite de uso consumido. O detalhe operacional
(comandos, worktrees, ordem dos próximos passos) está em
[CONTINUACAO-P00-PRECO-JUSTO.md](CONTINUACAO-P00-PRECO-JUSTO.md); aqui fica só o
estado.

**Branch** `audit/preco-justo-p0`, **HEAD** `fba4f7d`, árvore limpa, 107 commits
sobre a base `8a8affd`. Nada foi enviado ao GitHub; nem o servidor nem o banco de
produção foram tocados.

### 12.1 O que entrou depois do §11

A rodada final abriu cinco frentes. **Três foram verificadas e juntadas**:

- **venda-caixa-unidade** — cabeçalho da venda recusa texto vazio e número (era
  500 e vendedor fantasma); a fila de vendas guardadas não devolve "Erro
  interno." no relançamento; a dívida da devolução acompanha o cliente e não a
  janela do turno; o que fica gravado no fechamento nomeia a dívida.
- **frete-conciliacao-comissao** — `/logistics/quotes` recusa transportadora fora
  do catálogo; o recorte de data recusado para de apagar os números do período
  anterior; a faixa de comissão da empresa vizinha não paga aqui; a prontidão do
  Asaas pergunta o modo do processo em vez de acreditar no `.env`.
- **fiscal-nfe-balcao** — a segunda emissão com destinatário diferente é recusada
  (409) em vez de devolver a nota antiga como sucesso; o selo fiscal da venda
  enxerga os dois modelos; o indicador de IE deixou de ser cravado '9'; a
  devolução da venda documentada por NF-e deixou de ser beco sem saída.

**Duas ficaram de fora do merge**, porque a verificação adversarial delas não
chegou a tempo: `p5/produtos-codigos-saldo` (9 commits) e `p5/etiqueta-no-papel`
(6 commits e 6 arquivos ainda não commitados na worktree do lane). Não juntar o
que não foi verificado é a regra desta auditoria, e ela vale também no fim.

### 12.2 O último conserto: o papel do fechamento

A verificação adversarial da frente de caixa pegou uma **regressão do próprio
conserto anterior**. Ao ensinar o papel a dizer que o reembolso em espécie está
na gaveta, a frase passou a ser escolhida pela EXISTÊNCIA da devolução pendente —
e não por onde o dinheiro está. Medido: venda paga no CRÉDITO, devolução de
R$ 50,00, gaveta com esperado e contado iguais e diferença zero, e o papel
assinado mandando separar R$ 50,00 que nunca passaram por ali. O mesmo saía no
turno seguinte para a dívida herdada.

Agora o turno calcula `naGavetaCents` — a espécie que a venda devolvida pôs
NESTA gaveta, já sem o troco e limitada ao que ainda se deve — e o papel e a tela
leem esse número. Registro anterior ao conserto não traz o campo: aí não se sabe,
e a frase manda conferir em vez de chutar. Dois casos novos no servidor (cartão e
dívida herdada) e dois na tela; o caso em espécie continua cobrando a frase
verdadeira.

### 12.3 O que ficou aberto

Três defeitos medidos e ainda não consertados, listados com gravidade, arquivo e
caminho do conserto no §8 do arquivo de continuação: as quinze unidades padrão
que podem não nascer numa loja implantada por script (alta); `origin: ""` gravado
em silêncio (média); e um parâmetro morto com o parágrafo que o explica (baixa).
Nenhum impede a loja de vender.
