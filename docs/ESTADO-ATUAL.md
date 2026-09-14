# Estado atual — Grupo Sampaio ERP

**Este é o documento que vale.** Onde `CHECKPOINT.md`, `KNOWN_LIMITATIONS.md` ou
qualquer outro divergirem daqui, vale este — e a divergência é defeito a
corrigir, não margem de interpretação.

Havia quatro documentos dizendo coisas diferentes sobre os mesmos módulos: um
declarava CRM, oficina, locação e BI "prontos para produção" enquanto outro os
listava como legado. Quem lesse o primeiro tomaria decisão errada. Por isso um
só passa a responder.

Um módulo só aparece como **funcionando** quando existe teste comportamental
**e** verificação contra o sistema rodando. Nada é declarado homologado sem
resposta de ambiente externo real.

**Onde essa régua ainda não foi cumprida, está dito na própria linha.** Seis
telas entregues nas últimas rodadas — Locais de estoque, Unidades, Balança,
Plano de contas, Comissões e Operadoras — têm teste de servidor farto e **nenhum
teste de navegador**. Foram verificadas na tela, uma vez, contra o banco real;
o que falta é a rede que impede a regressão silenciosa.

---

## O tamanho do que existe

Os números abaixo estavam parados havia treze rodadas — diziam 46 telas quando
já eram 55, e 64 serviços quando já eram 139. Um documento que se declara "o
que vale" e traz número errado gasta a própria autoridade.

| Medida | Número |
| --- | --- |
| Telas no aplicativo | 67 (as plaquinhas entraram na rodada 53) |
| Itens de menu dizendo "em breve" | 1 (Automações) |
| Tabelas relacionais no núcleo | 111 · coleções JSON legadas: 213 → 132 (rodada 36) |
| Serviços no servidor | 165 arquivos (110 no núcleo) |
| Testes | 4.085 no servidor (291 arquivos; 28 pulados são sandbox/homologação, que exigem credencial externa) + 1.295 no navegador (97 arquivos) — inclui as 20 suítes da auditoria integral e os fechos dos P1 |
| Rotas em `core.ts` | 354 (a volta da contingência no fechamento; a lista de vendedores do balcão na rodada 67; a homologação do Asaas na 62; o teste de comunicação com a SEFAZ na 58; a entrada de peça na bancada na 55; a OS em papel na 54), e **todas declaram quem alcança** — a regra de lint em AST recusa rota calada |
| Rotas nos outros roteadores de `v1` | rodada 36 apagou 5 roteadores (loja fantasma, promoções, OMS, workshop, rentals): 19 → 14. Antes disso, 292 (duas apagadas na rodada 34), e desde a rodada 31 **todas declaram** — guarda-middleware ou `rotaPublica('motivo')` |
| Versão do esquema | 73 |

### O cofre, em 27/08/2026

A chave que sela o `.pfx` do certificado, as chaves do Asaas, o token do
webhook e a senha da caixa de e-mail **era a padrão de desenvolvimento** —
escrita neste repositório. `DEVORA_ENCRYPTION_KEY` nunca tinha sido declarada,
e o código caía no valor de fallback.

Isso foi rotacionado: os cinco segredos foram resselados com uma chave própria,
de 32 bytes aleatórios, numa operação tudo-ou-nada com cópia antes. Provado numa
cópia do banco: 5/5 abrem com a nova, 0/5 com a antiga, e o `.pfx` saiu byte a
byte idêntico (12.864 bytes, mesmo sha256).

**Resselar não é trocar.** Enquanto a chave publicada valia, cópias inteiras do
banco saíram da máquina — 527 objetos no bucket remoto e 717 no disco. Cada uma
abre os cinco para quem tiver o repositório. Trocar a fechadura não recolhe a
chave que já está na rua.

Por isso as quatro credenciais de PROVEDOR estão marcadas
`PROVIDER_ROTATION_REQUIRED` em `GET /core/system/secrets-readiness`: elas
precisam ser reemitidas nos portais que as emitiram, e só o dono pode fazer
isso. A marca se apaga sozinha, por credencial, quando a nova for colada.

O `.pfx` é a exceção: é inútil sem a senha, que nunca esteve no banco.

| Segredo | Selo | Troca no provedor |
| --- | --- | --- |
| A1 (.pfx) da Preço Justo | `SEALED_CURRENT_KEY` | não |
| Senha do A1 | `ABSENT` | — (falta enviar) |
| Asaas sandbox | `SEALED_CURRENT_KEY` | **sim** |
| Asaas produção | `SEALED_CURRENT_KEY` | **sim** |
| Token do webhook | `SEALED_CURRENT_KEY` | **sim** |
| Senha do e-mail | `SEALED_CURRENT_KEY` | **sim** |

A rotação tem comando próprio: `node dist/scripts/rotacionar-chave.js`, com as
duas chaves vindas do AMBIENTE e um ensaio obrigatório antes. Nunca por
argumento de linha de comando — aquilo fica no histórico do shell.

### A fila para a central

O backup remoto lia `DEVORA_SUPABASE_*` e a sincronia lia `SUPABASE_*`. Mesma
conta, dois nomes: o backup subia, a sincronia nunca ligou, e 118 eventos das
seis empresas ficaram doze dias parados enquanto o log dizia "sem credencial"
a cada boot — para um dono que tinha preenchido a credencial.

Agora há um nome só, o `DEVORA_*`. O nome antigo, se aparecer no ambiente, é
denunciado no diagnóstico em vez de ignorado.

A sondagem de esquema continua no ciclo: central sem esquema não é central
fora do ar, e o envio **não é sequer tentado** contra ela — gastar as doze
tentativas levaria a fila inteira a `dead` em cerca de uma hora.

Isso deixou de ser pendência em 30/08/2026: os três SQL de `docs/supabase`
foram aplicados (via Management API, depois que o SQL Editor executou
parcialmente duas vezes em silêncio), e a fila inteira está do outro lado —
**199 eventos** (os 118 represados mais 81 da carga inicial do histórico),
todos entregues, projetados e carimbados, com reconciliação por chave e por
empresa. A carga inicial tropeçou uma vez no próprio id (texto numa coluna
`uuid` — as centrais de mentira dos testes aceitavam qualquer string, e o
contrato entrou na suíte junto com o conserto) e os mesmos 81 foram
reaproveitados, sem evento novo e sem uuid sorteado.

E o diagnóstico parou de guardar fóssil: `central_projection_last_error` era
só escrito, nunca apagado — com a central 100% saudável, ainda se lia o erro
da véspera. Agora a projeção aceita pela central (e só ela) limpa o erro
superado; fila vazia e entrega sem projeção não apagam nada, e falha nova
escreve por cima. A limpeza toca só `core_meta` — nenhum evento é reescrito
para o diagnóstico ficar bonito.

### O backup, depois de 27/08/2026

Ele copiava o `.db` e só ele. Se o disco morresse, o banco voltaria do bucket
com todos os links de imagem apontando para arquivos que não existem mais em
lugar nenhum — o sistema voltaria parecendo inteiro, com a vitrine sem foto.

Agora os arquivos sobem também, num pacote com **manifesto separado** (para
ser lido sem baixar o pacote) e **sha256 por arquivo** (para "baixou" virar
"voltou igual"). Só quando MUDAM: uma loja troca o logo uma vez por ano, e
mandar o mesmo pacote todo dia encheria um bucket pago de cópias iguais.

Provado contra o bucket real: 2 arquivos, ida e volta, sha256 idêntico,
estrutura preservada, temporário apagado.

**E eram 458 arquivos a mais que não deviam estar lá.** Em
`data/uploads/lojas` havia 458 PNG de 70 bytes — o 1x1 dos testes —, todos sem
referência no banco. A suíte escrevia na pasta de produção porque só
`WorkshopPhotoService` obedecia ao redirecionamento. Corrigido nas três
pastas; os 458 foram MOVIDOS para `server/data/quarentena`, não apagados.

| Onde | O que é | Arquivos |
| --- | --- | --- |
| `<raiz>/data/uploads/lojas` | logo e capa de loja | 0 |
| `server/data/uploads/produtos` | foto de produto | 2 |
| `server/data/uploads/os` | foto de ordem de serviço | 0 |

As duas raízes diferentes são acidente histórico e ficam como estão: os links
já gravados no banco apontam para elas.

### A auditoria final integral (30/08/2026)

Antes da hospedagem, o sistema inteiro foi auditado FUNCIONALMENTE — não "a
rota existe", mas "o fluxo completo prova o efeito": 16 suítes novas de
auditoria (`server/tests/audit-*.test.ts` + 4 de navegador) atravessam
UI→API→serviço→banco→consulta→relatório com matemática exata em centavos. O
PDV certificou verde nas SEIS empresas (turno completo com fechamento em
diferença zero); o isolamento de tenant saiu ileso de 23 falsificações; o
financeiro fecha exato (venda→lançamentos→taxa de operadora→DRE→comissão).

O objetivo era quebrar antes dos usuários — e quebrou. Os consertos, cada um
com vermelho provado antes: mock de TEF alcançável em produção; NF-e legado
fabricando autorização/recibo/cancelamento/CCE/inutilização (neutralizados);
BI executivo hardcoded em zero (removido); cliente write-once (CPF sem
validação, máscara duplicando, sem edição/inativação — tela incluída); preço
negativo no cadastro; e-mail duplicado na equipe; senha provisória sem saída
(login avisa, autosserviço novo, tela de troca no primeiro acesso); token de
terminal irrevogável (revoke + listagem); gaveta aceitando NaN/negativo/meio
centavo; cupom sem desconto de item/acréscimo; DANFCE com aritmética que não
fechava; lista de vendas truncando em 200 em silêncio; competência gravada
no dia de GREENWICH (venda das 22h competia o dia — e na virada, o MÊS —
seguinte); devolução no dia errado nos insights; recusa fiscal por
configuração queimando numeração; grupo tributário ineditável (pCredSN);
setLabor sem guarda em OS paga; aceite de orçamento sem porta no balcão e
sem validade após mudança de valor; pontos resgatados confiscados no
cancelamento; pedido de compra ignorando o conferido da doca; quinze telas
batendo na cara de perfis sem alcance.

A prova de que a auditoria não tocou no dado real: o sha256 do banco
operacional é o MESMO do início ao fim (`39df087b…`), com integridade ok e
zero violações de FK — todos os testes rodaram em bancos temporários.

### Os quatro P1 internos, fechados em 31/08/2026

1. **A emissão abre o cofre.** O pipeline fiscal exigia a senha do A1 no
   corpo de cada emissão — e nenhuma tela a enviava: emissão real pela UI era
   inalcançável. Agora `signDocument`/`advanceDocument` resolvem o
   certificado UMA vez por chamada: senha digitada ganha (compatibilidade
   administrativa — o teste de comunicação com a SEFAZ continua pedindo a
   digitada de propósito); senão, a senha SELADA no cofre. O botão do PDV,
   que envia corpo vazio, passou a emitir de verdade. A senha nunca aparece
   em resposta, log, auditoria ou erro serializado (varredura com senha
   plantada prova); B não assina com o A1 da A; adapter que se declara de
   teste não transmite em produção nem injetado por dentro. Os atos
   administrativos (cancelamento/CCE/inutilização/DF-e) seguem exigindo
   senha digitada — decisão registrada para o dono.

2. **A conciliação de recebimento ganhou tela.** Compras → Conciliação de
   recebimento: pedido × NF-e item a item (pedida × faturada ×fator ×
   conferida, preço pedido × preço nota), estados OK/Divergência/Pendente/
   Parcial/Concluído pela MESMA régua do `recalcReceived`, item extra/
   faltante/não casado sinalizados, e só ações que o servidor suporta
   (abrir, conferir, vincular, confirmar). Sobre-entrega (nota 12 num pedido
   de 10) tem o comportamento real provado e afirmado: o recebido excede sem
   capar, status `recebido`.

3. **A porta da oficina espelha a senha provisória** (componente extraído
   `TrocaDeSenhaProvisoria`), e o guarda `Protected` passou a barrar sessão
   com `mustChangePassword` em QUALQUER rota — reload, URL direta e voltar
   redirecionam para a porta do ambiente da pessoa, com a etapa aberta.

4. **O menu não promete o que o servidor nega — por construção.**
   `o-menu-nao-promete-o-que-o-servidor-nega.test.ts` deriva por AST o
   `requireProfile` das rotas-chave de 18 telas e o espelha contra
   navItems/gsRoutes nos dois sentidos; mordida provada três vezes (perfil
   plantado no menu, gate removido do roteador e perfil removido do
   servidor — as três direções ficam vermelhas nomeando perfil e rota).

### Os três bloqueadores de publicação, fechados em 30/08/2026

A auditoria de prontidão encontrou exatamente três impedimentos objetivos, e
os três eram do repositório — nenhum dependia de terceiro:

1. **Os comandos do operador apontavam para o nada.** O commit que criou o
   rotacionador de chave varreu a pasta `server/scripts/` (scripts soltos da
   era dev), mas ~20 aliases do `package.json` continuaram apontando para ela
   — inclusive `npm run backup:verify` e `db:restore`, que o checklist de
   go-live manda rodar. Recriados como CLIs FINOS sobre as funções oficiais já
   testadas (`snapshotDatabase`, `verificarBackup`, `restaurarBackupEm`,
   `listarBackups`) em `server/src/scripts/`; os aliases de readiness mortos
   saíram (as telas e rotas respondem aquilo hoje). A varredura de segredos
   passou a olhar O QUE O GIT RASTREIA — a antiga varria o disco e reprovaria
   o `.env` legítimo de toda máquina configurada. Um teste novo confere que
   TODO alias npm aponta para arquivo que existe, nas duas bases (`--prefix
   server` resolve contra `server/`).

2. **Dockerfile e CI pinavam Node 20 — e `node:sqlite` exige 22.5.** O
   container morria no `import`, antes de abrir a porta. Agora é UMA versão:
   Node 24 no Dockerfile, no CI e no `.nvmrc`; `engines >= 22.5` nos dois
   `package.json`.

3. **A documentação de publicação ensinava um deploy que não liga.** Os
   exemplos declaravam `VITE_DEVORA_API_BASE_URL`, que nenhuma linha lê — o
   código lê `VITE_API_BASE_URL`, e ela é de BUILD (embutida no bundle). E o
   `DEPLOY.md` mandava preencher `.env.production`, arquivo que o runtime não
   carrega (a API lê o arquivo chamado `.env`, ou o ambiente real). O contrato
   agora está escrito num lugar só: uma variável de build no frontend, tudo o
   mais é runtime da API. As 14 chaves `VITE_*` fantasma saíram dos exemplos.

A prova é uma homologação local de produção, sem publicar: API compilada sobe
com `NODE_ENV=production` em ambiente isolado (banco novo em pasta
temporária, `.env` real ignorado, segredos fortes gerados na hora e nunca
impressos), health e readiness respondem, o atalho sem senha de então
respondia 404 desligado e derrubava o boot ligado (hoje a porta nem existe —
ver a rodada 34, abaixo), uploads servem, o caminho do banco e o do backup
obedecem ao ambiente, o diário RECUSA copiar banco que não é o operacional, e
o SIGINT encerra com código 0. O restore foi executado de verdade para um
destino isolado (íntegro, 0 violações de FK, segunda tentativa no mesmo
destino recusada) com o banco operacional intacto — hash idêntico antes e
depois.

### A retenção do bucket

Não existia. A poda local existe desde a rodada 35 — trinta dias, mínimo sete;
a remota, nunca: 530 objetos, 2,7 GB, num armazenamento pago.

A política é avô-pai-filho, com os prazos vindos do que o sistema guarda: 14
dias de diários (o intervalo entre um defeito entrar e alguém notar), 8 semanas
de semanais (quando se descobre que um lançamento vinha errado desde antes), 12
meses de mensais (o ano fiscal). Mínimo 7. Todo número vem do ambiente, e valor
inválido cai no padrão em vez de virar "apague tudo".

A poda **não é automática**: é o comando `podar-bucket.js`, com ensaio
obrigatório. Os backups anteriores à rotação da chave só entram com
`--incluir-legados` — e mesmo assim o mais recente de cada selo é preservado,
porque é o caminho de volta se algo na rotação tiver escapado.

Ensaio de 27/08: WOULD DELETE 0, WOULD KEEP 530, 523 legados preservados. Com
autorização, sairiam 523 e ficariam 7. **Nada foi apagado.**

### O backup local ainda está no mesmo disco

`DEVORA_BACKUP_DIR` nunca foi definida, e o padrão é a pasta vizinha do banco.
O diagnóstico do dono responde `LOCAL_BACKUP_SEPARATE_MEDIA: NO` — não se
inventa disco que não existe. Enquanto isso, a proteção real é a cópia remota,
e só ela.

Um aviso sobre o número de testes, porque ele já valeu menos do que parecia:
até a auditoria da rodada 14, o total incluía 15 casos que não tocavam em código
de produção — nove eram `expect(true).toBe(true)`. Esses saíram, e três guardas
estruturais entraram no lugar (ordem de exclusão do banco, varredura de
`requireProfile`, consistência menu ↔ roteador). Contagem de teste só é medida
de confiança quando cada caso consegue falhar.

O sistema roda em dois processos: um servidor Node/Express com SQLite (WAL,
transacional) e um aplicativo React que fala com ele por HTTP. Não há banco no
navegador: o dado é um só, e é do servidor.

---

## O que funciona

Tudo abaixo tem teste e foi visto funcionando na tela, com dado real.

### Núcleo

| Módulo | Observação |
| --- | --- |
| Banco central | SQLite WAL, transacional, migrations numeradas e idempotentes |
| Autenticação | Argon2id, refresh com rotação, bloqueio por tentativa, tudo no servidor |
| RBAC e isolamento | `companyId` vem do vínculo, nunca do corpo da requisição |
| Toda rota do núcleo declara quem alcança | 312 de 312 em `core.ts`. Silêncio deixou de ser opção: uma regra de lint em AST recusa rota nova sem declaração, e recusa também a declaração escondida dentro de um `if` ou de um callback. Ver "A matriz de permissões" |
| Seis operações | Preço Justo, Gringa, Me Mimei, Conceito, PJ Motors e Oficina |
| Produtos e variantes | Código interno por sequência da empresa; EAN-13 interno com dígito verificador |
| Estoque | Razão idempotente, saldo nunca negativo, reserva separada de saldo |
| Locais de estoque | Onde a peça está. Dimensão do razão, não chave do saldo — o total continua sendo o total. **Um escritor só**: a transferência manual. Entrada por NF-e, venda, devolução e inventário gravam local nulo e caem no GERAL |
| Unidades serializadas | Chassi, IMEI, número de série. Identidade acoplada dentro do `applyMovement`, que é o único escritor do saldo |
| Importação de planilha | A loja nova nasce com catálogo **e saldo**. Molde da entrada de NF-e: o arquivo sobe em BYTES (nunca `file.text()`, que destruiria o acento do Excel brasileiro dentro do navegador), vira um lote em conferência, e só o botão de confirmar cria produto e chama `applyMovement`. Codificação, separador e mapa de colunas ficam à vista e editáveis — corrigir uma detecção errada relê os MESMOS bytes, sem reenviar o arquivo. **Produto que já existe não tem o cadastro tocado**: entra só o saldo. Linha torta vira ERRO da linha, com o número da planilha, e é pulada — nunca derruba as outras |
| O que a importação avisa antes do clique | Sem saldo (o PDV recusa a venda), sem preço (o produto sai de graça no caixa), quantas linhas serão descartadas por erro, e quantas casam com produto existente — nessas a quantidade **soma** no estoque atual. Com erro ou reimportação, confirmar exige segundo clique com o número escrito. Uma importação que só diz "200 produtos criados" entrega uma loja que parece pronta e não é |
| Caixa | Abertura, sangria, suprimento, fechamento com diferença. O total por forma só conta pagamento liquidado — PIX pendente não entra na conferência |
| Vendas | Idempotentes por chave; preço vem do cadastro, não do cliente. Baixas somadas por produto — o mesmo item em duas linhas baixa a soma |
| Política do balcão | O que o operador pode conceder sem chamar o dono, por operação: limite de desconto, prazo da venda a prazo e validade da reserva. **Nulo significa o comportamento de hoje**, nunca ausência de valor — e a tela diz qual dos dois é |
| A alçada mede a CONCESSÃO INTEIRA | Desconto de rodapé + desconto de linha + preço abaixo do vigente, contra o total bruto calculado no SERVIDOR. Antes o denominador vinha do corpo da requisição, e desconto de linha e preço rebaixado não passavam por nada — a regra dos 10% era contornável de três jeitos. A recusa diz de onde veio cada centavo |
| A alçada promete só o que cobra | A lista de ações restritas tinha cinco nomes e **quatro nunca foram exigidos em lugar nenhum** — quem a lia acreditava que cancelar uma venda pedia gerente. Caiu para duas, e cada uma declara ONDE é cobrada. "Cancelar venda" saiu da lista e o BOTÃO entrou: a rota já existia, já estornava estoque, comissão e fidelidade, e nenhuma tela chamava |
| Teto de sangria | Quanto o caixa tira da gaveta sem chamar ninguém. Antes não havia teto: qualquer operador com caixa aberto zerava a gaveta. **Não vale para quem já tem alçada** — em loja pequena o gerente é quem fica no caixa, e a sangria existe para proteger o dinheiro; travá-la para ele manteria o dinheiro exposto |
| A liberação do gestor é consumida | Vinculada a uma venda, com teto em valor E em percentual, recusada na segunda tentativa. Antes era conferida por existência: uma liberação servia para infinitas vendas |
| Formas de recebimento | Catálogo no servidor. Método desconhecido é recusado na entrada; crediário declarado e desligado. **No cliente o `PagamentoDialog` ainda mantém uma segunda lista como reserva**, e decide "é cartão?" comparando o nome do método em vez de usar o campo que o servidor devolve |
| Financeiro | Um fato econômico por origem, direção e parcela; contas a pagar e a receber |
| Plano de contas | **A CATEGORIA GANHOU LEITOR**: o DRE quebra receita e despesa por ela, e o formulário de lançamento passa a oferecê-la. Antes dava para criar e não dava para atribuir — a rota descartava o campo que o serviço aceitava. **O CENTRO DE CUSTO continua sem leitor**, e a tela que o cadastra diz isso: ele foi cortado da rodada 24 de propósito, porque tem zero cadastros e nenhum relatório o consome |
| DRE por competência | Receita e despesa por categoria, com "Sem categoria" tendo casa própria nos dois lados. Cada lançamento entra em EXATAMENTE uma linha, e três invariantes conferem isso antes de a resposta sair. **NÃO tem CMV**, e é recusa e não adiamento: a tabela de itens da venda não guarda o custo do que foi vendido, e o único custo disponível é sobrescrito pela última nota que entra. **NÃO é caixa**: a tabela de baixas está vazia, porque os serviços de origem quitam gravando o valor direto |
| A ressalva é parte do relatório | Painel fixo, sempre aberto, listando o que o número não inclui. Um DRE que omite a própria limitação vira imposto pago errado |
| Comissões | Grupos, faixas e vínculo do vendedor. A apuração é fato gravado com base e alíquota congeladas, e devolução gera linha de estorno em vez de reescrever o passado. **O fechamento grava histórico que nenhuma tela lê de volta** — depois de fechar, resta o selo "fechado" |
| Operadoras de cartão | Taxa por bandeira e parcela, com calendário de recebimento. Sem taxa cadastrada a venda segue pelo caminho antigo, de uma linha só — a trava que impede número inventado |
| Clientes | Entidade única por operação |
| Auditoria | `core_audit_log`, append-only. A leitura por empresa recusa `companyId` de terceiro; só `admin_geral` atravessa |

### Balcão e operação

| Módulo | Observação |
| --- | --- |
| PDV | Venda ponta a ponta; atalhos F2–F10 sem tomar F5, F11 e F12 do navegador |
| Devoluções | A venda continua tendo acontecido; devolução é fato novo |
| Inventário | Contagem congela o esperado e ajusta só a diferença |
| Compras | Fornecedores e pedidos; pedido não movimenta estoque, entrada movimenta |
| Entrada por XML | Conferência item a item antes de dar entrada |
| O XML da nota de entrada é GUARDADO | Era o único buraco irreversível do sistema: o arquivo do fornecedor era lido, virava linha, e era descartado. Agora ele é gravado **verbatim** — nunca reserializado, porque a assinatura do fornecedor cobre os bytes —, e há uma rota para baixá-lo. **A nota que já existia no banco fica sem arquivo para sempre**: não há backfill possível, e a tela diz isso com a data da própria nota |
| Pacote mensal do contador | Um zip por mês com as notas emitidas em formato `nfeProc`, os eventos ocorridos no período, os XML das compras, as faixas inutilizadas e o DRE — mais um LEIA-ME que declara **o que não tem e por quê**. Cada consulta é própria e **sem LIMIT**: reusar as das telas truncaria um mês real em silêncio. Homologação, fixture e protocolo `TEST-` ficam de fora. A tela em `/sistema/fiscal/fechamento` abre no mês mais recente COM matéria-prima, mostra as contagens e as pendências (**nenhuma bloqueia o download**) e baixa o zip autenticado |
| Janela de impressão do PDV | O cupom chega à janela como conteúdo já baixado, e não como URL. A janela aberta por URL não manda cabeçalho, e a rota do documento passa por `authMiddleware` — ela respondia **401 todo dia**, mostrando erro de autenticação no lugar do cupom. Agora a busca leva o Bearer e a janela recebe um `blob:` |
| Etiquetas | Folha medida em MILÍMETRO, desenhada no servidor. 6 origens, 7 formatos, 3 modos de quantidade. O preço impresso é o que o caixa cobra |
| Balança | Arquivo de produtos gerado. **Só o CSV genérico está confirmado** — ver "O que depende de você" |
| Orçamentos e pré-venda | Nenhum dos dois é venda |

### Oficina

| Módulo | Observação |
| --- | --- |
| Ordens de serviço e Kanban | Colunas no servidor; peça **reserva** ao ser lançada e baixa quando o serviço é autorizado (rodada 55) |
| Regras por operação | Etiqueta na Oficina, kanban e estoque na Preço Justo |
| Grupos de mecânicos | Por bancada, nas duas oficinas |
| Peças | Visão do mecânico sem custo nem margem. A tela **dá entrada** (rodada 55): bipa, repõe ou cadastra com documento de origem, preço derivado de custo + percentual, endereço na gaveta e mínimo editável |
| A peça existe, é lançada e é cobrada | Produto vira peça de bancada por uma ação própria do cadastro, com **uma porta só** — o PUT de edição recusa a troca e aponta a ação certa. A tela da OS ganhou o caminho de lançar e devolver, que o servidor tinha e ninguém alcançava. Peça sem preço de venda é **recusada** no lançamento: a NF-e cria produto com preço zero de propósito, e sem essa recusa a OS fecharia sem custo e a loja daria a peça |
| A peça não vaza para a venda | Fora da vitrine nas sete consultas públicas, fora do contrato de locação e da pré-venda, fora de kit, e fora da busca do PDV por padrão. **A bipagem do código de barras continua achando** — responder "não encontrado" para item que existe na gaveta empurraria o operador a cadastrar de novo e racharia o estoque em dois cadastros —, mas para e pergunta de que bancada é |
| Equipamentos e plaquinha | QR abre página pública sem login e sem dado do dono |
| Moto da loja com plaquinha | A peça de estoque da loja e o equipamento da oficina são o mesmo bem, ligados por ato humano na tela de Unidades. **A oficina é outra empresa**, então o vínculo atravessa `company_id` de propósito — e só alcança equipamento interno não vendido, nunca aparelho de cliente |
| A venda carimba a plaquinha | Vender a peça grava dono, data e venda no equipamento, espelhando o cadastro do comprador na empresa da oficina pelo documento. Devolução e baixa desfazem. **Exige cliente com CPF**: sem documento não há espelho, e o portal ficaria mudo para quem acabou de comprar |

### Comércio

| Módulo | Observação |
| --- | --- |
| Loja pública | Vitrine por operação, com identidade própria. Desde a rodada 56 a loja declara **que negócio faz** (`storefront_preset`) e a página se arruma sozinha: densidade da grade, proporção do card, onde a busca entra e a chamada do herói. Departamentos em **árvore**, selos que só afirmam o que o cadastro sustenta, e produtos relacionados. A rodada 57 terminou o acabamento: todo fetch com carregando/vazio/erro, celular sem enterrar a grade, teclado operando tudo (diálogo, Enter nos códigos, foco visível), plural decidido, e as fotos podem chegar sem quebrar nada (`FotoDeProduto` com fallback e lazy) |
| Conta do cliente | Cadastro, endereços e pedidos |
| Pedidos e OMS | Separação, conferência, embalagem, expedição com rastreio |
| Entrega | Sem entrega arranjada é retirada — nunca frete grátis por omissão |
| Administração da loja | Temas, banners, destaque de produto |
| Promoções | No PDV e na loja, com a mesma regra |
| Tabela de preço (revenda/atacado) | O preço da tabela é um candidato a preço VIGENTE, ao lado das promoções, e vence o menor — todos calculados sobre o preço de cadastro, nunca um sobre o outro. Com isso o desconto combinado entra no denominador da alçada: o revendedor de 15% fecha a venda sem chamar gestor, e o que o operador conceder ALÉM da tabela continua sendo medido. A venda guarda nome e percentual como fotografia (`core_sales.price_table_name`), e o orçamento guarda a tabela de que falava. Mão de obra (preço aberto) fica de fora dos dois lados, pela mesma decisão do servidor. A vitrine pública passa tabela nula: preço anunciado é de todo mundo. **Nas telas:** a de clientes tem o seletor (só gerência, e só tabela ativa), a de tabelas diz quantos clientes usam cada uma, e o PDV reprecifica POR CLASSE — cada linha do carrinho guarda para qual cliente foi precificada (`CartLine.precificadaPara`) e toda linha que não bate é reprecificada por `POST /core/pricing/cart`, venha ela do bipe, da pré-venda, da espera retomada ou do preço aberto |
| CRM e fidelidade | Lead não é cliente; ponto é dívida da loja, não receita |
| Locação | Alugar reserva, não debita |

### Gestão

| Módulo | Observação |
| --- | --- |
| Painel | Métricas calculadas; estado vazio quando não há dado |
| BI | Operações lado a lado; margem admite quando não sabe o custo |
| Auditoria | A trilha (`core_audit_log`) legível: quando, quem (nome, por JOIN), ação, entidade e detalhe em frase. Filtro por ação, busca e paginação NO SERVIDOR, com total filtrado. Só `admin_geral`/`gestor` — quem opera aparece na trilha, não a lê; roteador, menu e rota citam a mesma lista (`DONOS_DO_GRUPO`) |
| Conciliação bancária | Relata divergência; corrigir é decisão de quem responde pelo caixa |
| Usuários e equipe | Pessoa é uma só; o que muda é o perfil |
| Offline | Casca do app em cache pelo service worker (só no build de produção; resposta de API nunca vem do cache) e, de escrita, só a **venda do PDV**: guardada no navegador com a chave de idempotência, reenviada sozinha (5 s, 10 s, 20 s e daí a cada 30 s) quando o servidor da loja volta, e — se ele a recusar — entregue a ele para relançar ou descartar. Todo o resto para com o servidor fora (ver "Servidor da loja: ponto único") |

---

## Servidor da loja: ponto único (GAP-PRD-046 — decisão do dono)

O DEVORA **não é offline-first**. O servidor da loja é o ponto único de cada
instalação, e a documentação antiga ("cliente com fila offline") prometia mais
do que existe. O que existe, medido:

- **Continua com o servidor fora:** a venda do PDV (dinheiro, PIX lançado à
  mão, cartão da maquininha avulsa). Ela fica guardada **no navegador daquele
  caixa** e sobe sozinha quando o servidor volta; a barra do topo diz se o
  problema é a rede do computador ou o servidor da loja.
- **Para com o servidor fora:** consulta atualizada de preço e estoque, abrir e
  fechar caixa, OS, cobranças, NFC-e e maquininha integrada (a cobrança passa
  pelo servidor).
- **A venda que o servidor recusa ao voltar** (a gaveta daquele turno fechou,
  o estoque acabou) não fica presa no computador: vai para **Regularizar**,
  visível ao gestor e a todos os caixas, onde é relançada com a mesma chave na
  gaveta aberta ou descartada pela gerência com motivo.
- **O limite que só o dono decide:** a venda que ainda **não subiu** mora no
  navegador daquele caixa. Se aquele computador morrer antes de o servidor
  voltar, ela se perde. A proteção escolhida é a opção (a) da auditoria —
  **nobreak no servidor da loja, backup diário (`db/backup.ts`) e o
  procedimento de `docs/OPERATIONS.md`** ("Servidor da loja fora do ar"). A
  opção (b), tornar o ERP offline-first (banco local em cada caixa e
  sincronização), é projeto novo, não conserto: fica registrada aqui como
  decisão pendente do dono.

---

## O que depende de você

Nenhum destes é defeito. O código existe, é chamável e está testado até onde dá
para testar sem o outro lado. O que falta é credencial ou equipamento — e
enquanto faltar, a tela **diz o que falta** em vez de oferecer botão que falha.

| O que | Estado | O que você precisa providenciar |
| --- | --- | --- |
| NF-e (modelo 55) | `READY_FOR_CERTIFICATE` | Certificado A1 (.pfx) + senha, e CNPJ, IE, CRT e série da operação |
| NFC-e (modelo 65) | `READY_FOR_CERTIFICATE` | CSC e CSC ID por operação, além do certificado |
| Asaas | `BLOCKED_CREDENTIAL_ROTATION` | As chaves ficaram guardadas em cópias do banco seladas pela chave publicada: **reemita sandbox, produção e o token do webhook no portal**. Depois, teste a conexão pela tela — teste anterior à troca não vale |
| Banco central | `READY_FOR_SCHEMA` — a credencial existe e funciona | Os três arquivos de `docs/supabase` rodados no SQL Editor do projeto. **118 eventos esperam na fila desde 15/08/2026** |
| Correios / Jadlog **diretos** | `NOT_IMPLEMENTED` (sem integração direta) | Nada: PAC, SEDEX e os serviços da Jadlog são cotados, comprados e rastreados **pelo Melhor Envio**. Um contrato direto com os Correios ou a Jadlog exigiria programar a integração — a credencial sozinha não basta (GAP-PRD-118) |
| Melhor Envio — **cotação** (checkout e página do produto) | `READY_FOR_CREDENTIAL` | O **token de produção** de cada operação, colado em Loja → Logística, e `LOGISTICS_PRODUCTION_ENABLED=true` no servidor. O token de sandbox é opcional e só confere: nunca vira preço cobrado. Ver "O que falta no Melhor Envio" abaixo |
| Melhor Envio — **etiqueta e rastreio** | `READY_FOR_CREDENTIAL` | O mesmo token (com permissão de carrinho, compra, geração, impressão e rastreio), **saldo na carteira** do Melhor Envio, o endereço do remetente completo em Fiscal → Configuração e a NF-e autorizada de cada pedido (ou a decisão do contador pela declaração de conteúdo, em Loja → Logística). Programado e provado com o `fetch` dublado (GAP-PRD-119/120); **nenhuma etiqueta real foi comprada** |
| Impressão silenciosa e gaveta | `READY_FOR_HARDWARE` — agente local, fila, telas e página de teste prontos (GAP-PRD-082) | A impressora térmica de cada balcão, o agente instalado no computador do caixa (`docs/OPERATIONS.md`) e a página de teste impressa em Configurações › Impressoras |
| Taxas de operadora de cartão | Configuração pendente nas seis operações (medido em 11/09/2026) | Taxa e prazo de cada contrato em Financeiro › Operadoras de cartão. Sem elas o cartão entra como recebido no dia, pelo valor cheio; a prontidão de go-live (`/system/go-live`, `configurationPending`) lista a operação que falta |
| TEF / maquininha | `READY_FOR_HARDWARE` | SDK do provedor e PinPad físico |
| Balança Toledo, Urano, Filizola | `READY_FOR_HARDWARE` | Um arquivo exportado **pela sua balança**, com dois ou três produtos, para acertar as posições dos campos |

### O que falta na balança, exatamente

O arquivo é gerado e baixa. As regras comuns às três marcas estão aplicadas e
testadas: uma linha por item, texto sem acento, preço em centavos inteiros,
descrição cortada na largura do campo, e o código de barras fora do arquivo —
a balança compõe o dela a partir do PLU.

O que **não** foi conferido são os offsets de cada marca. Por isso os três
layouts estão marcados `confirmado: false` no código, a tela avisa isso onde se
clica, e há teste travando essa marcação — se alguém inverter para `true` sem
ter testado numa balança, o teste quebra.

O **CSV genérico** está declarado funcionando, porque é o único que este código
controla de ponta a ponta: o software da balança costuma deixar apontar qual
coluna é qual.

Adivinhar o layout produziria um arquivo que a balança recusa sem dizer por
quê — e a culpa cairia no sistema.

### O que falta no Melhor Envio, exatamente

Esta linha dizia "token de sandbox e de produção" quando **produção não existia
no código**: o adapter só conhecia o endereço do sandbox, a chave
`LOGISTICS_PRODUCTION_ENABLED` desligava as chamadas em vez de ligá-las, e o
checkout só cotava com uma variável de teste (`LOGISTICS_HOMOLOGATION_TESTS`)
que nenhuma tela mostrava (GAP-PRD-030, 126, 127). Isso foi programado; o que
vale agora:

- **Quem decide é o ambiente do token.** Na tela Loja → Logística o gestor
  escolhe *Sandbox* ou *Produção*, cola o token e testa a conexão. Token de
  sandbox cota o sandbox (`sandbox.melhorenvio.com.br`) e aparece só na cotação
  de conferência, com tarja própria. Token de produção cota
  `melhorenvio.com.br` e é o **único** que vira preço de frete no checkout.
- **A chave do servidor.** Com `LOGISTICS_PRODUCTION_ENABLED=false` (o padrão),
  o token de produção fica guardado mas nenhuma chamada de produção é feita, e a
  tela diz isso pelo nome da chave. É a mesma régua do Asaas.
- **Servidor de produção** (`DEVORA_API_ENV=production` ou
  `NODE_ENV=production`) não usa token de sandbox nem produz cotação simulada.
- **O que foi provado, e como.** Roteamento, cabeçalhos, formato do corpo,
  leitura da resposta (preço personalizado da conta, serviço sem preço
  descartado, token recusado) — com o `fetch` dublado
  (`server/tests/melhor-envio-producao.test.ts`). **Nenhuma chamada real à
  produção foi medida**: não há token. O primeiro teste de conexão com o token
  de verdade é a homologação.
- **Etiqueta, despacho e rastreio** (GAP-PRD-119/120). Na ficha do pedido
  (Pedidos → nº do pedido), o bloco **Envio** diz o que falta para comprar a
  etiqueta — token, medidas, endereço do remetente, NF-e — e compra no
  Melhor Envio em três atos (carrinho → pagamento com o saldo da carteira →
  geração), no ambiente do token. Saldo que falta deixa o envio no carrinho, e
  **Tentar de novo** retoma sem criar outro. A etiqueta imprime pelo link do
  provedor e se cancela enquanto não foi postada.
- **Despacho** (botão "Expedido"): com etiqueta, o código vem dela; sem
  etiqueta (agência, motoboy, transportadora local) o operador diz **quem
  leva** — Correios, Jadlog, Melhor Envio, outra ou entrega da loja — e o
  código, que para os Correios é conferido (AA123456789BR). Data e operador
  ficam no envio.
- **Rastreio**: a agenda do servidor consulta os envios a caminho
  (`LOGISTICS_TRACKING_SYNC_MINUTES`, padrão 60) e o botão **Atualizar
  rastreio** consulta na hora. Postagem vira "expedido" e entrega vira
  "entregue" com origem **provedor**; "entregue" clicado na loja fica com
  origem **operador** e o nome de quem clicou. A falha da consulta fica
  gravada e aparece no ERP e no portal. O cliente vê a transportadora, o
  **link público** de rastreio (Correios oficial; Melhor Rastreio para Melhor
  Envio e Jadlog) e os eventos; o e-mail "a caminho" leva o link.
- **O que não foi medido**: nenhuma chamada real ao Melhor Envio (sem token).
  A primeira etiqueta comprada com o token de verdade é a homologação — e
  ela gasta saldo; faça com um pedido real e barato.

### O que "READY_FOR_CERTIFICATE" quer dizer no fiscal

O caminho inteiro existe: chave de 44 dígitos, numeração por série,
assinatura, fila com nova tentativa, recuperação de resposta perdida, DANFE e
DANFCE, cancelamento, carta de correção e inutilização. A partir da rodada 16 há
o botão que dispara tudo isso — na venda do PDV e no pedido da loja.

Sem o certificado, o botão **não aparece**, e no lugar dele a tela lista o que
falta. Foi decisão deliberada: oferecer e falhar no meio do atendimento é pior
do que não oferecer.

### Numeração e CSC ganharam tela (rodada 33)

Dois itens que o `readiness` cobrava — `serie` e `csc` — **só existiam por
rota**. O dono abria `/sistema/fiscal/configuracao`, lia "Nenhuma série
configurada" e "CSC não configurado", e não havia nenhum lugar no sistema onde
resolver. Era pendência sem botão: o checklist mandava fazer algo impossível.

Agora os dois têm cartão na mesma tela:

- **Numeração das notas** — lista as séries de cada modelo com o próximo
  número, e grava série nova. A numeração só anda para frente; a recusa de
  regressão (`409`) chega como frase, porque repetir um número já enviado é
  rejeição por duplicidade com a venda já feita.
- **CSC** — grava CSC ID e token. O token **sobe e não desce**: fica cifrado
  no cofre do servidor, o campo é limpo depois de gravar, e a tela mostra
  apenas "CONFIGURADO" e o ID. O ambiente **não é escolha**: acompanha o
  ambiente da operação, senão dá para gravar o CSC de teste marcado como
  produção.

Três defeitos apareceram ao ligar a tela, porque campo de tela é texto:

1. `serie: 'abc'` chegava como NaN até o bind do INSERT e devolvia **500 cru**
   ("NOT NULL constraint failed") numa tela de configuração.
2. `serie: -1` e `serie: 1000` eram **aceitos em silêncio** — fora da faixa
   0–999 do layout da NF-e, gravando uma série que nenhuma emissão usaria,
   enquanto o checklist seguia dizendo que faltava série.
3. O pior, e o único que o teste de tela não pegava sozinho: o navegador faz
   `Number('abc')` → NaN, e `JSON.stringify` grava NaN como `null`. No
   servidor, `Number(null)` é **0** — dentro da faixa. Digitar uma letra
   gravava a **série 0**, calada, e a nota sairia na série errada.

O modelo também passou a ser conferido: `model: '99'` gravava uma série para um
modelo que não existe, e o checklist continuava em `serie:FAIL` sem dizer por
quê.

### O que falta para a nota do pedido online

Além do certificado, o cliente precisa ter endereço com **código IBGE do
município** — a NF-e identifica o município pelos 7 dígitos, não pelo nome. O
campo existe no portal do cliente e é opcional no cadastro; sem ele o pedido
entrega normalmente e só a nota espera.

### O que a central ainda não provou

A função `erp_apply_projections` (em `docs/supabase/03-projecao.sql`) nunca rodou
contra um Postgres real, porque não há credencial. O que está testado é o lado
do nó: quais linhas são montadas, com que chave, em que ordem, e o que acontece
quando a central recusa. Ao aplicar a migration, confira o retorno da primeira
sincronização — ele informa quantas linhas foram projetadas.

---

## O que não existe

**Automações.** É o único item do menu que diz "em breve", e continua assim de
propósito: automação sem processo estabelecido vira regra que dispara sozinha
sem ninguém entender por quê. Entra quando houver o que automatizar.

**DRE.** Um comentário em `SalesService` diz que a linha de taxa de cartão "sai
como linha própria para aparecer no DRE". O DRE não existe. A linha é gravada
corretamente; o relatório que a leria é que ainda não foi feito, e entra na
rodada do Painel junto com o consumo de categoria e centro de custo.

**Cancelamento de venda pela tela.** A rota, o serviço e a função de cliente
existem; o botão, não. O menu promete "cancelar desfaz" ao lado de "devolver não
altera a venda", e hoje só a devolução tem caminho na interface.

**Saída da OS de montagem interna.** `closeOrder` recusa encerrar sem custo
quando a OS tem peças lançadas, e com peças ela vai para `aguardando_pagamento`.
A única saída de lá é `settleOrder`, que exige uma venda — e ninguém cobra a
loja por montar a própria moto. Então a OS de montagem fica parada nesse estado.
Isso é conhecido e está nomeado no código: por causa dele, a recusa de vender
moto que está na bancada olha só os quatro estados em que ela está
**desmontada**. Se olhasse "≠ finalizada", toda moto montada com peças viraria
invendável para sempre.

**O histórico de montagem no portal do comprador.** Quem compra passa a ver a
moto e as ordens que **ele** abrir dali em diante. O que a oficina fez antes da
venda não vai junto: aquelas ordens não têm cliente, e mostrá-las abriria a
porta que o portal fecha de propósito — um dono lendo o que o anterior escreveu
— além de expor custo interno de montagem. A tela de vínculo diz isso com essas
palavras, para não prometer o que não entrega.

**Entrada sem senha — por desenho.** Nenhuma rota emite sessão sem senha, em
ambiente nenhum. O atalho de desenvolvimento que listava os usuários na tela de
login saiu por inteiro na preparação da entrega (ver a rodada 34, abaixo). O
único caminho sem digitar senha é o token de terminal, registrado por um
administrador e revogável.

---

## O que a auditoria da rodada 14 encontrou

Três agentes releram as treze rodadas anteriores procurando três coisas
diferentes: migração que falha em silêncio, teste que passa pelo motivo errado, e
código que existe sem ninguém alcançar. O que foi corrigido na mesma rodada:

| Achado | Onde estava |
| --- | --- |
| Saldo bancário e comissão do time abertos a qualquer sessão | `/finance/setup` e `/commissions/*` sem guarda de perfil |
| Auditoria de outra empresa acessível pelo `companyId` da URL | o parâmetro sobrescrevia a empresa do token |
| PIX pendente contado como recebido no fechamento | a consulta filtrava o status da venda, nunca o do pagamento |
| Dois perfis inexistentes guardando cinco rotas | `'financeiro'` e `'tecnico'`, fora de `ASSIGNABLE_PROFILES` |
| Ordem de exclusão com pai antes do filho | `core_product_units` × `core_equipment`, e `core_users` × `core_customers` |
| Passo de migração pulável por um número de versão mentiroso | o passo 3 recria tabela, e reconciliação não desfaz constraint |
| Menu oferecendo o PDV para quem o guarda devolvia | `ROTA_PDV` não aceitava a gestão, ao contrário da gaveta e da bancada |

Nenhum deles foi encontrado por teste. Por isso a rodada entregou também as
redes que faltavam: varredura de `requireProfile`, ordem de exclusão conferida
contra as chaves estrangeiras reais, `schema-drift` enxergando UNIQUE e CHECK
além de coluna, consistência menu ↔ roteador, e o vocabulário de status de
pagamento cobrado nos próprios testes.

---

## O que a conferência da rodada 21 encontrou

A rodada que fez a alçada medir a concessão inteira foi relida procurando o que
ela mesma proíbe. Os três achados vieram com medida, contra banco de teste, e os
três foram fechados com teste que falha quando o guarda sai:

| Achado | Onde estava | Como ficou |
| --- | --- | --- |
| Desconto NEGATIVO passava: moto de R$ 12.000 com `discountCents: -100000` gravou `total_cents` 1.300.000 (mais que o bruto) e concessão de −8,33% | `SalesService.createSale`, no rodapé e na linha | recusa explícita nos dois, com a mesma decisão que o acréscimo negativo recebeu — um significado por campo |
| `core_authorizations.granted_gross_cents` escrita e lida por decisão nenhuma | o consumo comparava só centavos | a liberação passa a valer como PERCENTUAL: tirar a moto do carrinho fazia os mesmos R$ 3.400 virarem 68% e a venda fechava |
| `core_quotes.concession_gross_cents` escrita no INSERT, lida por ninguém | a conversão comparava centavos absolutos | a conversão compara percentual — a queda de preço de tabela, que virava fatia maior sem virar linha de auditoria, agora vira |
| `core_quotes.authorization_id` escrita na criação, lida por ninguém | o `authorizationId` da rota é o do CORPO, outro caminho | o detalhe do documento mostra "Desconto liberado por ⟨nome⟩", com data e teto |

Nenhuma das três colunas foi removida da migração: as três ganharam leitor no
mesmo commit, e o leitor de duas delas é uma decisão que recusa venda.

### E a suíte parou de deixar 935 MB para trás a cada rodada

A limpeza dos bancos temporários morava num `process.on('exit')` que apagava a
pasta — e o comentário ao lado dizia que isso "resolve o caso normal", com o
Windows como exceção rara. **Medido: uma execução completa deixava 155 pastas e
935 MB; três deixavam 440 pastas e 2,6 GB.** Uma pasta por arquivo de teste, toda
vez: o `rmSync` falhava em 100% dos casos, porque o processo morre com o SQLite
ainda aberto.

O conserto tem duas camadas — a conexão é FECHADA antes do `rmSync`, e
`tests/global-setup.ts` apaga a pasta-raiz da execução depois que todos os
workers morreram, que é o único momento sem handle aberto. Medido depois:
155 pastas antes da execução (resíduo da medição), **0 pastas e 0 MB** depois.

---

## O contador entra sozinho (rodada 29)

A rodada 27 entregou **o que** ele leva; esta entrega **ele mesmo entrando**. Sem
isso, alguém da loja precisa lembrar de gerar e enviar todo mês — e o mês que
passa é justamente o que ninguém percebe.

**É um perfil de `core_users`, não um portal com token próprio.** Um portal seria
a terceira verdade sobre quem entra, depois de `core_users` e
`core_customer_accounts`, e obrigaria a reimplementar Argon2id, refresh com
rotação, bloqueio por tentativa, vínculo por empresa e desligamento — cinco
mecanismos de segurança, dos quais algum ficaria para trás. O perfil herda os
cinco no dia em que nasce.

**O que o mantém estreito é o guarda, não a boa vontade.** `contador` vive no
ambiente `contabilidade` e em nenhum outro, então toda rota que declara alcance
por ambiente já o recusa sem uma linha escrita; e `temPermissao` falha fechada
para perfil que não está em módulo nenhum, o que cobre os outros 17 roteadores.
Das rotas do sistema ele alcança **três**, nomeadas uma a uma: a prévia do
fechamento, o pacote do mês e o XML de uma nota de compra.

**A varredura é o coração da rodada.** Um teste enumera as rotas pelo AST e bate
em todas com um login de contador de verdade: as três respondem o número exato
esperado, e **todas as outras respondem 403**. Rota nova aberta a ele por engano
deixa esse teste vermelho antes de chegar em produção. Um segundo teste amarra
os dois `Record` de ambiente — o do servidor e o do navegador, que vivem em
arquivos diferentes e que o compilador não liga um ao outro.

### Dois defeitos de escalada que esta rodada expôs e fechou

`PERFIS_DE_DONO` guardava só a **atribuição** do perfil, nunca a conta de quem já
o tem. Medido: um gerente de loja recebia 403 ao tentar criar um gestor — e
conseguia **trocar a senha** do gestor existente (tomando a conta) e
**desativá-lo**. A porta da frente recusava e a de trás não. Agora as duas
operações conferem o perfil do **alvo**, com a mesma régua.

### O que continua em aberto

**Desligar não cortava a sessão que já estava na mão — dívida paga na rodada
31.** O refresh reemitia o que a linha da sessão dizia, sem nunca abrir
`core_users`: desligado renovava o token a cada hora **para sempre**,
`session_version` era escritor sem leitor, e rebaixado renovava com o perfil
antigo. Agora o refresh espelha o login: usuário ativo, versão conferida e
perfil relido do vínculo — e a recusa revoga, então reativar a conta não
ressuscita o token antigo. **A janela de uma hora foi fechada (GAP-PRD-053):**
`authMiddleware` confere a conta a cada requisição — ativa, mesma
`session_version`, ainda vinculada à operação — e o perfil que vale é o do
vínculo de agora. Desligou, trocou a senha ou saiu da operação: cai na
requisição seguinte, e não "em até uma hora".

**A regra de lint em AST cobria só o `coreRouter` — dívida paga na rodada 31.**
Eram 277 rotas em 17 arquivos fora do alcance dela — e duas (`POST
/storefronts/:id/carts` e `/orders`) estavam autenticadas e **sem permissão
nenhuma**: qualquer perfil criava pedido com valor arbitrário. Foram guardadas
na rodada 29; a rodada 31 alargou a regra para os dezenove roteadores de
`src/routes/v1` — ela aprendeu o idioma do middleware
(`requirePermission('x')` como argumento) e ganhou a declaração
`rotaPublica('motivo')` para rota aberta por desenho. A varredura acusou 67
rotas caladas; todas viraram declaração explícita, **nenhuma mudou de
alcance** (a prova por rota está em
`tests/rodada-31-alcance-declarado.test.ts`).

---

## O que estava aberto agora — e fechou (rodada 34)

A rodada 34 não construiu nada: fechou cinco coisas que a auditoria de 23/08
(3 exploradores, 33 auditores em 8 dimensões, cada achado grave passado por um
cético) mediu abertas **no sistema rodando**. Cada uma tem teste que fica
vermelho se o conserto sair.

**Qualquer aparelho na rede entrava sem senha.** O `.env` desta máquina ligava
o atalho de desenvolvimento sem senha e não declarava `DEVORA_API_ENV` — logo
'development', onde a trava de produção não disparava de propósito —, e o
servidor escuta em todas as interfaces. Medido com `curl` pelo IP da máquina:
a lista dos **23 funcionários** das seis empresas (6 `admin_geral`, 6
`gestor`), e a rota vizinha emitindo sessão só com o id. Ganhou então uma
quarta trava (só o loopback, pelo socket).

**Na preparação da entrega o atalho saiu por inteiro** — rotas, cliente,
painel da tela de login e a chave do esquema. A porta não existe em ambiente
nenhum, de origem nenhuma (nem do loopback): quem pede os endereços antigos
recebe o 404 genérico da API. A variável que o ligava ficou aposentada, junto
com a do build da tela e a do acesso por card: ligada num processo de produção
(`DEVORA_API_ENV` production/staging ou `NODE_ENV=production`), a API recusa
subir e diz qual linha apagar; fora de produção sobe ignorando e avisa no log;
a conferência da implantação mostra "Variável aposentada presente"; e o
`secret:scan` recusa arquivo do repositório que a escreva ligada. A matriz
completa está em `server/tests/acesso-sem-senha-em-ambiente-nenhum.test.ts`.

**`GET /loja/orders/:id` devolvia o CPF inteiro** a quem soubesse o id —
`SELECT *` espalhado com `...order`, enquanto a rota irmã do portal mascarava o
documento. Nenhuma tela a chamava. **Apagada**, com lápide; o teste que a usava
passou para a rota do gestor, e um novo prova o 404.

**O bloqueio de login era arma.** Contava falhas por login, de qualquer
origem: quem soubesse o login do gerente (está no cupom) errava cinco vezes de
um celular e o gerente ficava 15 minutos fora do próprio caixa — e
`GET /auth/lockout/:login`, pública e sem chamador, confirmava que deu certo.
Agora são **dois tetos**: 5 por par (login + origem, lida do socket) e 50 por
login. O gerente entra do caixa dele com o atacante trancado; força bruta
distribuída bate no teto alto. O portal do cliente passou a usar o mesmo par —
sem isso, oito erros de um celular não travavam mais. A rota pública sumiu.

**A reserva de estoque não expirava.** O checkout reservava na hora e nada
soltava: um visitante sem conta esgotava a vitrine fechando pedidos e não
pagando. `cancelOrder` já sabia soltar — faltava **quem o chama com o
relógio**. `OrderReservationExpiry` roda no backend a cada 15 minutos e cancela
o não pago com mais de 25 h (24 h do PIX + folga do webhook). Recebe "agora" de
fora, para o teste e a rotina provarem a mesma função. Pedido pago nunca é
tocado, por duas camadas.

**Pagamento que falhava no meio travava para sempre.** O evento do webhook era
gravado antes de processar, fora de transação; se `markOrderPaid` falhasse, a
linha ficava com `processed = 0` e a próxima entrega do provedor recebia
"Evento já recebido". A tabela sempre teve `processed` e `error` — o desenho
previa retomar; a implementação não retomava. Agora só evento **processado** é
duplicata; o travado é retomado, a falha fica em `error` e é **relançada**,
porque engolir devolveria 200 e o provedor pararia de reenviar.

---

## O backup que salva (rodada 35)

O que existia estava **correto e inútil**. Correto: snapshot pré-migração e
backup manual, os dois por `VACUUM INTO`, com o WAL. Inútil por três motivos
medidos: morava na **mesma pasta do banco, no mesmo disco**; só rodava quando
alguém lembrava (a última vez, 17/08); e a poda mantinha 10 arquivos sem
distinguir motivo — dez migrações seguidas **apagavam todos os backups manuais
do dono**. E `scripts/restore-verify.ts` procurava `devora-backup-*.json` numa
pasta que não existe: era do projeto anterior e nunca rodou aqui, mas imprimia
"Restore verify OK".

Agora:

- **Diário no backend.** `startDailyBackup` roda ao subir e a cada 24 h. Visto
  no log contra o banco real: 4,78 MB, íntegro.
- **Pasta configurável** por `DEVORA_BACKUP_DIR`. Enquanto for o mesmo disco
  do banco, o diário **avisa no log a cada execução** — outro disco é decisão
  de quem opera, e o código não pode fingir que resolveu.
- **Poda por família e com mínimo.** Migração (14 dias, mín. 3, máx. 10) e
  diário/manual (30 dias, mín. 7) são podados em separado, e a pasta **nunca
  fica vazia por limpeza**.
- **Restauração de verdade.** `npm run db:backups` lista com veredito de
  integridade; `npm run db:restore -- <backup> <saída>` restaura **num caminho
  novo** e recusa destino que já existe — restaurar por cima do banco em uso
  corrompe os dois. Provado contra o backup de hoje: 316 tabelas, 6 empresas,
  19 produtos no arquivo restaurado.
- **Verificação que abre o arquivo** e pergunta ao SQLite (`integrity_check`).
  O teste estraga 512 bytes no meio de um backup que abre — e foi escrito
  depois de provar que, com a verificação desligada, a suíte seguia verde.
- **`safety.ts` deixou de prometer o git.** O banco não está mais no git; a
  rede de salvação é o diário.

---

## A vitrine de cada negócio (rodada 56)

Medido no banco real antes de escrever uma linha, e é a frase que define a
rodada: **a diferença entre as cinco lojas do grupo, na vitrine, era
exclusivamente a paleta de cores.** Mesma ordem de seções, mesma grade de
2/3/4 colunas, mesmo card, mesmos filtros, mesma paginação de 12. Uma
importadora de variedades e uma loja de moda saíam idênticas trocando o verde
pelo azul.

E o catálogo está quase vazio: 19 produtos no grupo, 5 visíveis na loja,
**zero com foto**, zero destaques, nenhuma loja com logo, capa, chamada ou
faixa — as duas únicas linhas de `core_storefront_settings` têm todos os
campos nulos. Então o que a rodada entrega não podia depender de o dono
preencher nada: a vitrine tem de ler como um negócio de verdade **estando
vazia**, e melhorar conforme ele preenche.

### A escala de tipo inteira estava inerte

Conferindo a vitrine contra o banco real, o título da loja saiu com **15px**
onde o token diz 28. Medindo os outros: `xs`, `sm`, `lg` e `2xl` computavam
todos 15px. A regra que o Tailwind tinha gerado:

```css
.text-\[var\(--gs-text-2xl\)\] { color: var(--gs-text-2xl); }
```

`text-[…]` é ambíguo — serve para cor e para tamanho — e sem dica de tipo o
Tailwind resolve como **cor**. O `font-size` nunca era aplicado (herdava os
15px do corpo) e, de quebra, tentava pintar o texto de `28px`, valor que o
navegador descarta calado.

O projeto declarava sete degraus — 12, 13, 15, 18, 22, 28, 36 — e renderizava
um só. **Nenhum título era maior que o corpo, em tela nenhuma, desde que os
tokens existem.** É por isso que toda página tinha a mesma textura cinza e nada
guiava o olho. Foram **1.083 classes em 81 arquivos**, e um teste de varredura
recusa a próxima escrita sem a dica.

### O tipo da loja virou dado, e a página se arruma

`core_companies.storefront_preset`: `variedades`, `moda`, `beleza`,
`veiculos`. Não é o mesmo que `kind` — aquele responde "isto é loja ou
oficina"; este responde "que negócio esta loja faz".

Uma **tabela** decide o arranjo, e não cinco páginas: densidade da grade,
proporção do card (roupa é alta, frasco é quadrado), se a busca abre a página
e a chamada padrão do herói. Cinco páginas divergiriam no primeiro conserto
feito em quatro delas — a cicatriz que este repositório já tem.

Quem entra numa **importadora** sabe o que quer e procura: a busca é a primeira
coisa da tela e cabe mais coisa por linha. Quem entra numa loja de **moda**
quer ver: foto grande, três por linha, card em retrato. **Veículos** mostra um
modelo por vez. Loja sem tipo cai num arranjo **neutro** e sai inteira.

A cor continua sendo da MARCA, e não do arranjo: Gringa e Conceito são as duas
"moda" e têm paletas diferentes.

### O herói funciona vazio, que é o estado real

Ele só desenhava o que estivesse preenchido — e como nada está, era uma seção
invisível: um herói que ninguém nunca viu. Agora sempre diz **que loja é essa**
e **que negócio ela faz**, com a chamada do gestor quando existe e a frase do
tipo quando não.

### Os departamentos são a árvore, e os selos não mentem

`listCategories` devolvia `SELECT DISTINCT p.category`: uma lista de strings
onde "Camisas", que é galho de "Vestuário", aparecia ao lado do próprio pai.
A hierarquia **já existia** — `TaxonomyService` a mantém, com tela própria, e o
cadastro de produto escolhe a categoria a partir dela. A loja é que mostrava
texto solto. Agora vem em árvore, com a contagem do que dá para comprar, e o
galho só aparece depois de o departamento ser escolhido.

Os **selos** só afirmam o que o cadastro sustenta: retirada, frete grátis acima
de X, prazo, parcelamento e troca. Com o cadastro vazio de hoje, cada loja
mostra dois — "Retire na loja" e "Troca em 7 dias" —, e os dois são verdade.
Entrega desligada não vira selo de entrega mesmo com valor gravado, e o
parcelamento ganhou cadastro próprio (`installments_max`): `core_acquirer_rates`
responde "quanto a operadora me cobra", não "em quantas vezes eu vendo".

### Três defeitos que a rodada tornaria visíveis

- **A foto quebraria no dia em que existisse.** Toda imagem da vitrine usava o
  caminho cru do banco. As imagens são servidas pela API, noutra porta, e o
  Vite não tem proxy — `src="/uploads/…"` bate no Vite e dá 404. O resolvedor
  existe desde sempre e só as telas do ERP o usavam. Nove pontos corrigidos.
- **A promoção da loja não aparecia na loja.** A seção de ofertas era desenhada
  só na home do grupo. A Gringa tem produto em promoção e a vitrine dela não
  dizia em lugar nenhum — e a consulta já recebia o slug, com o resultado
  jogado fora.
- **O produto sem foto abria com um vazio de tela inteira.** Um retângulo cinza
  ocupando a viewport com "Sem foto cadastrada" no meio, e o nome e o preço
  abaixo da dobra — em 100% das páginas, porque nenhum produto tem foto. O
  lugar da foto virou um componente só (eram quatro cópias, com dois textos
  diferentes) que carrega a inicial e a cor da loja e diz "foto em breve".

### O que a revisão adversária pegou

5 lentes, 30 agentes, 25 achados, 12 refutados, **13 confirmados e
consertados**. Os que mais importam vieram do próprio conserto da escala:

- **O KPI passou a esconder dígito.** Com os 36px valendo de verdade, a faixa
  de quatro colunas do Painel dá ~180px de caixa num notebook de 1280 e
  "R$ 128.430,55" pede 239px — e o gestor lia o faturamento com o último
  dígito coberto pelo cartão vizinho. Não se ajeitava sozinho porque
  `formatCents` separa o "R$" com espaço **não-separável**, o que faz do valor
  uma palavra só, e a grade usa `minmax(0, 1fr)`, o que impede a coluna de
  crescer. O número virou elástico, amarrado à largura do próprio cartão: a
  1920 ele volta aos 36px cheios. *(Eu tinha medido este e concluído que não
  existia — na página errada, com um valor curto. A revisão mediu a certa.)*
- **O build quebrou por causa do teste novo.** A varredura do Tailwind é
  textual: ela leu o template literal do teste da escala e gerou
  `.text-[length:var(--gs-text${token})]`, que o minificador de CSS não
  consegue ler. Teste não é template — saiu da varredura.
- **`fotoAtiva` não zerava ao trocar de produto pela prateleira nova.** Sair de
  um produto com três fotos na terceira e cair num de uma só deixava a tela
  tentando montar uma imagem sem endereço. Junto vinham o aviso "Adicionado ao
  carrinho" do produto anterior e a quantidade escolhida lá.
- **"Não declarado" era desfeito na subida seguinte.** O carimbo do tipo rodava
  a cada boot, e escolher "nenhum" é escolha legítima — a vitrine voltava
  sozinha ao arranjo que o dono tinha tirado. O carimbo ficou só na migração e
  na semeadura.
- **A contagem da pílula não batia com o clique**, por dois motivos: somava as
  variantes da grade (que aparecem num card só) e dobrava a caixa de um jeito
  que o SQL não consegue igualar — `LOWER` do SQLite não mexe em letra
  acentuada. As duas pontas agora fazem a mesma dobra, e há teste que compara
  o número da pílula com o número do clique.
- **Na home do grupo, o mesmo departamento em duas lojas virava duas pílulas**
  com contagens que nenhuma batia com o filtro, que ali não tem loja.

Mais: o selo comia o "frete grátis sempre" (`free_above_cents = 0`); "1 dia
úteis"; parcela digitada com letra virava `null` no JSON e apagava o selo com a
tela dizendo "Salvo"; tipo inválido devolvia 400 **depois** de gravar o resto
do formulário; o preview do logo no painel usava caminho cru; trocar de loja
carregava o departamento da anterior; `npm run db:seed` estourava no meio num
banco anterior à rodada; a cotação de frete montava a prateleira ao lado para
jogar fora; e a varredura da escala só guardava um lado da ambiguidade — token
de **cor** com a dica de tamanho passava verde e apagava a cor.

Esquema 70 → 71. Nenhuma rota nova: o contador segue em 348.

## Bloco A do fechamento — o fiscal inteiro

A auditoria de entrega encontrou sete bloqueadores fiscais. Nenhum era
cosmético: com qualquer um deles no lugar, **nenhuma nota seria autorizada** ou
sairia em nome errado.

| # | O que estava | O que passou a valer |
| --- | --- | --- |
| **B1** | `dhEmi` renomeava o relógio de Greenwich: nota das 14h saía declarando 20h UTC, três horas no futuro | `momentoFiscal(quando, uf)` converte de verdade, com o deslocamento da UF do emitente |
| **B2** | A chave usava o mês da MÁQUINA e o `dhEmi` usava UTC — na venda das 22h do dia 31 eles discordavam do mês | As duas respostas saem do mesmo cálculo |
| **B3** | O XML da NFC-e não tinha `<infNFeSupl>` nem QR Code, e o gerador só era chamado pelo módulo legado | QR versão 2 no XML, payload `chNFe|2|tpAmb|cIdToken|hash`, URL do portal do RS. Sem CSC, recusa dizendo de onde ele vem |
| **B4** | `soma(itens) === total` — qualquer venda com desconto de rodapé morria sem dizer por quê | A conta inteira: `soma − desconto + acréscimo`. O XML ganhou `vDesc` completo e `vOutro` |
| **B5** | `CSOSN 102` fixo para toda empresa, e o `<imposto>` sem PIS nem COFINS | Tributação de `core_tax_groups`, por empresa. ICMS por CRT, PIS/COFINS por CST, CFOP por UF de destino |
| **B6** | `serie ?? 1` — a loja cadastrava a série 5 e a nota saía na 1 | `resolveSerie` lê a configuração; sem série ativa, recusa dizendo onde cadastrar |
| **B7** | A fila fiscal não filtrava por empresa: a Gringa transmitia a nota do Preço Justo com o próprio certificado | `claimNext(companyId)`. Nem reivindica nem trava o item da vizinha |

### Mais três, do mesmo domínio

- **A senha do A1 no cofre.** Era exigida a cada chamada, e o desenho explicava
  a intenção: "todo ato fiscal real tem alguém presente". Isso serve para um
  ato por dia; para o PDV produz um de dois desfechos, ambos piores — ninguém
  emite nota, ou a senha vira papel colado no monitor. Agora é selada com o
  mesmo primitivo do `.pfx`, do CSC e do Asaas.
- **A contingência tinha volta que não voltava.** O documento ia para `QUEUED`
  e o item da fila continuava `dead`. Agora a fila volta junto, com as
  tentativas zeradas — e a função ganhou rota, porque estava escrita, testada e
  inalcançável.
- **`recoverStaleItems` não tinha chamador.** Item travado por processo morto
  ficava `sending` para sempre. Agora `claimNext` o recupera antes de
  reivindicar, na mesma empresa.
- **Inutilização recusada queimava a numeração.** A faixa avançava antes da
  SEFAZ e nada voltava atrás: o gerente digitava 10-20 por engano, a SEFAZ
  recusava, e a numeração saltava sem inutilização autorizada que justificasse
  o buraco. Agora desfaz — e só quando ninguém mexeu na sequência no meio.

### O que a implantação de uma operação exige agora

Emitir passou a exigir **grupo tributário** e, na NFC-e, **CSC**. As duas
recusas são o conserto, não efeito colateral: sem grupo a tributação seria
inventada, e sem CSC o cupom nasce sem QR — que a SEFAZ recusa e o consumidor
não confere.

### Dependências externas que restaram

| O quê | Por quê | Quem resolve |
| --- | --- | --- |
| **CSC e CSC ID** da Preço Justo | Sem eles não há QR, e sem QR não há NFC-e | Portal da SEFAZ-RS |
| **Alíquota de crédito do Simples (`pCredSN`)** | O contador confirmou CSOSN **101**, que é "com permissão de crédito" e exige o percentual no XML | Contador |
| **Emissão em homologação** | O simulador não valida data, chave nem QR | Só o dono, contra a SEFAZ-RS |

---

## Bloco B do fechamento — o dia da loja

O sistema inteiro recortava data pelo relógio de **Greenwich**. Pelotas está
três horas atrás: a venda das 21h30 de 31 de agosto é gravada como
`2026-09-01T00:30:00.000Z`, e para o banco ela era do dia 1º de setembro.

Não é caso raro. No varejo, **tudo que acontece depois das 21h caía no dia
errado** — e em loja que fecha às 22h, é a última hora de todo dia.

### Onde isso custava dinheiro

| Onde | O que acontecia |
| --- | --- |
| **Painel** | O gerente abria no fim do expediente e a última hora de venda não estava lá |
| **DRE** | A venda de 31/08 às 22h aparecia em setembro, com a mercadoria saída em agosto |
| **Pacote do contador** | A mesma venda ia escriturada no mês seguinte |
| **Lista de vendas** | Filtrar "31/08" não trazia a venda de 31/08 |
| **Documentos fiscais** | Idem, e ainda perdia o último dia inteiro do período |
| **Conciliação bancária** | `occurred_at` é data e `settled_at` é instante; os dois recebiam o mesmo parâmetro, e o último dia sumia só de um lado — a diferença aparecia como divergência |
| **Promoção** | "Válida até 31/12" morria às **21h do dia 30**, com a campanha ainda anunciada e o preço voltando ao de tabela sozinho |
| **Validade de reserva** | `setHours(23,59,59)` usa o fuso da MÁQUINA: num contêiner em UTC, a peça reservada era solta três horas antes do prazo |
| **Garantia** | `sold_at` lido cru punha a base no dia seguinte, e a ficha que o cliente leva vencia um dia depois |
| **Competência do pedido online** | `now.slice(0, 10)` — mesma história, no e-commerce |

### O dono da regra

`server/src/services/core/CalendarioOperacional.ts` e `src/lib/datas.ts`. Duas
formas, cada uma com um domínio claro:

- **`diaDaLojaSql(coluna)`** — para consulta que corta por dia ou agrupa por
  dia. Troca direta de `substr(coluna, 1, 10)`: os sentinelas `'0000'`/`'9999'`
  continuam funcionando, e o `GROUP BY` também.
- **`limitesDoPeriodo(de, ate)`** — para consulta que compara instante. Converte
  as pontas do período nos instantes UTC da meia-noite e do último milissegundo
  locais.

As duas dizem a mesma coisa por caminhos diferentes, e o teste cobra que
concordem instante a instante — porque o SQLite não tem banco de fusos e o
JavaScript tem. Enquanto o Brasil não tiver horário de verão, o deslocamento
fixo do SQL descreve o ano inteiro; se voltar a ter, a asserção que percorre 365
dias fica vermelha e aponta o único arquivo que muda.

### Uma decisão revista, com a razão preservada

`FiscalClosingService` documentava a convenção antiga e a defendia:

> Manter a MESMA convenção do resto do sistema é o que garante que o pacote e a
> tela contem a mesma história; mudá-la aqui sozinho criaria duas verdades.

A razão estava certa e continua valendo. O que mudou foi a convenção: o dono
único passou a existir, e o recorte do pacote sai de lá junto com o do painel,
o do DRE e o das listas.

### A tela parou de refazer a conta do servidor

Duas telas montavam instante a partir de `<input type="date">` com
`new Date(...).toISOString()` — promoção e validade de orçamento. Isso lê data
pura como meia-noite de Greenwich, e usava o fuso do **navegador**: o mesmo
documento nascia com prazos diferentes conforme a máquina de quem digitava.

Agora a data viaja crua e quem a fecha no último instante do dia é o servidor
(`comoInstanteInicial` / `comoInstanteFinal`). O teste de tela que exigia a
conta duplicada foi reescrito: o jeito de ter uma conta só não é sincronizar as
duas, é apagar uma.

### O fuso da máquina não pode decidir nada

Os dois arquivos de teste forçam `TZ=UTC` antes de qualquer import. Esta máquina
de desenvolvimento roda em `America/Sao_Paulo` — foi exatamente por isso que o
defeito atravessou 3.216 testes de servidor e 860 de navegador: qualquer teste
escrito aqui acertava por acidente. O servidor de produção roda em UTC, que é o
padrão de quase todo contêiner.

### Um defeito introduzido e pego no meio da rodada

Ao migrar a garantia, `diaDaLoja` passou a converter também `entered_at` — que
é data de calendário, não instante. Converter o que não tem hora é inventar uma:
a ficha passou a dizer "entrou em 11/08" para a máquina que entrou em 12, e
quatro testes de equipamento ficaram vermelhos de uma vez. A regra virou parte
do módulo: **data de calendário entra e sai igual**.

### A varredura de segredos voltou a ser legível

118 avisos numa execução, todos de cópias do repositório dentro de
`.claude/worktrees`. A varredura pula `server/tests` comparando o caminho a
partir da raiz, e dentro da cópia esse prefixo não bate. `.claude` entrou na
lista de ignorados: um alerta que sempre acende deixa de ser lido.

### Portões

3.261 testes no servidor (223 arquivos) · 876 no navegador (82 arquivos) ·
lint, tipos e build verdes · varredura de segredos OK · `integrity_check` e
`foreign_key_check` do banco operacional limpos, lidos **somente leitura**.

---


## Bloco C do fechamento — o dinheiro

Sete defeitos com a mesma assinatura: **o número sai plausível**. Ninguém abre o
banco para conferir R$ 594,00 — abre-se a tela, o valor parece razoável, e ele
vira base de imposto ou motivo de ligação para o cliente.

| # | O que estava | O que passou a valer |
| --- | --- | --- |
| **D1** | Lançamento de venda **cancelada** continuava na lista e nos totais de Contas. O cobrador ligava para o cliente e levava 409 ao tentar dar baixa — porque `settleEntry` recusa cancelado, e recusa com razão. Pior: o painel usava `status='open'`, Contas usava `settled_cents < amount_cents` e o DRE usava `cancelled_at IS NULL` | Um critério só, nos três lugares: **`cancelled_at IS NULL`**. É o carimbo, e não o status, porque `aplicarStatus` recalcula o status a cada baixa — uma baixa lançada depois do cancelamento devolvia a linha para 'open' |
| **D2** | `replace(/\./g,'')` apagava o ponto DECIMAL: `1234.56` virava `123456` e o extrato importava a conta **multiplicada por cem**, sem erro na tela. O comentário logo acima prometia aceitar os dois formatos | O leitor certo já existia em `format.ts`, com a regra do grupo de três e teste próprio. As duas cópias quebradas saíram; o extrato ganhou sinal (débito é negativo) e notação contábil entre parênteses |
| **D3** | Estorno somava **−R$ 500** em vez de zero: o filtro `reversed_at IS NULL` tirava a baixa original e deixava a contrapartida negativa — que ainda virava "baixado sem extrato", divergência que não existe | As duas linhas saem juntas (`reverses_id IS NULL` também) |
| **D8** | Linha do extrato casada com baixa **estornada** simplesmente sumia do relatório feito para achá-la | Volta como divergência, com o valor do banco. Fora do período continua não sendo divergência — são coisas diferentes, e agora se distinguem |
| **D4** | O fechamento de comissão eram **três escritas sem transação**. Falha no meio deixava conta a pagar órfã **e** as linhas ainda abertas: o fechamento seguinte pagava o mesmo período de novo | `withTransaction` em volta do bloco inteiro (é reentrante: o `createEntry` de dentro abre SAVEPOINT) |
| **D7** | Devolução em etapas deixava **comissão residual**: a proporção era aplicada sobre o saldo VIVO. Venda inteira devolvida em duas etapas deixava R$ 25,00 vivos; em quatro, R$ 31,64 | A conta é sobre o ACUMULADO devolvido contra a comissão ORIGINAL, menos o que já foi estornado — assim ela se corrige sozinha, inclusive no arredondamento |
| **D5** | A conciliação do Asaas lia só `status = 'confirmed'`. O webhook grava também `paid_after_cancel` e `amount_mismatch` — **exatamente o dinheiro que precisa de alguém olhando** — e nenhum dos dois carimba `confirmed_at` | Os três estados entram, e a janela passou a usar `COALESCE(confirmed_at, updated_at)`. Sem isso, incluí-los no `status` não bastaria: continuariam fora do recorte |
| **D6** | A chave `(origin_type, origin_id)` **colapsava parcelas**: pedido de R$ 300 em 3× comparava só a última parcela e acusava R$ 200 de divergência inexistente | Os dois lados somam por fato. E duas cobranças confirmadas para o mesmo pedido agora **aparecem** como divergência, em vez de sumir |

### A conta que recebe é a da operação

Achado desta rodada, fora da lista: `getAsaasApiKey` caía para a chave do
`.env` quando a empresa não tinha credencial no cofre, e a guarda era
`DEVORA_API_ENV === 'production'` — o modo do **processo**, não o ambiente da
**cobrança**.

As duas se separam exatamente na configuração deste projeto: instalação local,
`ASAAS_PRODUCTION_ENABLED=true`, e a chave de produção do Preço Justo no
`.env`. Nessa combinação, cobrança da Gringa saía **na conta do Preço Justo** —
dinheiro real, de cliente real, no CNPJ errado, sem erro em tela nenhuma.

Para produção, a única fonte passou a ser o cofre, por operação. Não há como o
código saber de quem é a chave do `.env`; tratar a empresa ativa como dona seria
adivinhar. Em sandbox o fallback continua, que é onde se desenvolve e onde
nenhum dinheiro muda de mãos.

### A rede de centavos exatos

`dinheiro-em-centavos-exatos.test.ts` não cobre um defeito: impede o próximo.
R$ 0,01, cem itens de um centavo, R$ 100,00 em 3× (o resto vai na primeira),
R$ 0,02 em 3×, taxa de 2,99%, desconto, acréscimo, os dois juntos, baixa em
duplicidade e venda reenviada. Cada conta escrita à mão — vinda da mesma função
que a produz, o teste provaria só que ela é igual a si mesma.

### O que já estava certo, e por isso não entrou

O webhook de pagamento já tinha rede completa: idempotência do mesmo evento dez
vezes, evento fora de ordem que não desfaz o pagamento, token de uma operação
que não confirma cobrança de outra, evento desconhecido sem efeito, e retomada
de evento que falhou no meio. A divisão de parcelas já punha o resto na
primeira. Nada disso foi reescrito.

### Portões

3.317 testes no servidor (228 arquivos) · 893 no navegador (83) · lint, tipos e
build verdes · varredura de segredos OK.

---


## Blocos D a G e a macrovalidação

### D — Oficina, PJ Motors e estoque

**A OS da Oficina imprimia PJ MOTORS.** O dado (`brand_company_id` da bancada de
mobilidade) estava errado, e quem o punha lá era uma MIGRAÇÃO, com o vínculo
cravado em código e reimposto a cada subida do servidor — corrigir pela tela
durava até o próximo deploy. Três partes: a semeadura parou de mandar, o passo
72 desfez o dado uma vez (e só onde ainda estava errado), e a escolha ganhou
tela em Oficina › Oficinas e bancadas. O `'Grupo Sampaio'` do cabeçalho saiu:
identidade ausente virou recusa que nomeia onde resolver.

**A plaquinha congelava.** `applyMovement` decidia o estado da unidade pelo TIPO
do movimento, e venda, ajuste, perda e consumo de OS são todos `'out'`. A
unidade ficava `sold` sem passar nem por `venderPelaUnidade` nem por
`baixarPelaUnidade`: a moto sumia da lista de adotáveis com a mensagem "já foi
vendida", para uma moto que ninguém vendeu. Quem decide passou a ser a
referência.

**O ajuste manual sem motivo** e o **`referenceType` livre** — este último dava
para rotular um ajuste como `sale`, que é uma das referências que DÃO DONO à
plaquinha. E o **código de barras** passou a ser conferido também na edição, nas
duas tabelas: contra `core_products` era 500 cru; contra `core_product_barcodes`
não havia nada, e passavam a existir dois produtos respondendo ao mesmo bipe.

### E — a matriz das seis operações

Percorre as classes de dado uma a uma (catálogo, clientes, fornecedores,
estoque, venda, financeiro, configuração fiscal, numeração, documento, bancada,
identidade impressa) e, para cada uma, tenta atravessar a fronteira. Cada bloco
tem o par: recusa sobre o dado da vizinha **e** passagem dentro da própria
empresa — sem a segunda metade, recusar tudo também passaria.

E um bloco de falsificação com dado PLANTADO à força no banco, porque sem ele os
testes acima passariam num sistema que simplesmente não tem dado para vazar.

Uma asserção da primeira versão passava pelo motivo errado
(`expect([slug, nomes]).not.toContain(...)` confere a membresia do PAR): só a
mordida provada mostrou.

### F — o pedido de retirada

O padrão de toda loja é `pickup_enabled: 1, delivery_enabled: 0` — **todo pedido
online nasce sendo de retirada**, e a tela avançava por um mapa fixo
`embalado → expedido`. O servidor recusava com 409, a tela não conhecia "pronto
para retirada", e o pedido ficava parado em "Embalado" com a mercadoria no
balcão. O vocabulário e as duas ordens de etapas passaram a vir do servidor.

**Pedido reembolsado continuava andando** — com o e-mail "seu pedido está a
caminho" indo para quem acabou de ser reembolsado.

**O webhook legado atravessava as seis.** Sem `companyId` na URL, o token era
comparado com o do ambiente e a conferência de tenant era curto-circuitada.
`findCompanyByAsaasWebhookToken` já existia, sem um único chamador: conhecer o
token prova de quem é o evento.

### G — publicação

**`DEVORA_TRUST_PROXY`.** O limite de taxa conta por `req.ip`; atrás de um proxy
isso é o IP do proxy, e as seis operações dividem o mesmo balde de 300 — um robô
na vitrine derruba a venda do balcão com 429. Ligar `trust proxy` e pronto
trocaria um problema por outro (o `X-Forwarded-For` é forjável, e some quem
tenta força bruta), então o valor é do dono, recusado na subida se for absurdo, e
zero por padrão.

**O carteiro de e-mail** deixou de ser decidido no boot. A batida sem credencial
já era inofensiva — o `if` não protegia nada e só criava dependência de ordem.

### A macrovalidação

Quatro travessias completas, uma por operação, com cada número conferido contra
o anterior. O que ela **não** prova está escrito nela: nada contra a SEFAZ e nada
contra o Asaas de verdade.

---

## Os doze resíduos da auditoria (rodada 73)

O relatório da rodada anterior fechou declarando **doze defeitos ainda
abertos**. Esta rodada os fechou, um a um, com teste vermelho antes e mordida
provada depois. O que segue é o que cada um custava.

### Dinheiro e mercadoria (os seis primeiros)

**O carrinho de duas lojas despachava a segunda de graça.** O `checkout`
divide o pedido por empresa e a tela avisa que serão dois pedidos; o frete não
acompanhou. `index === 0 ? shipping.priceCents : 0` mandava a cotação inteira
para o primeiro pedido e o segundo nascia com R$ 0,00 e o MÉTODO do primeiro
colado nele. Medido no vermelho: R$ 65,00 a menos. Agora cada loja cota a sua,
a tela mostra um grupo por loja, e o checkout recebe `shippingPorEmpresa`.

**Mercadoria ficava presa no modelo de grade.** Cinco lugares já sabiam que
modelo não é item de venda; `generateVariants` tomava a decisão e não tratava
a consequência — o saldo que já estava no modelo virava órfão: aparecia no
Estoque, sumia do PDV, escapava da contagem de inventário (o único mecanismo
para fazer sistema e prateleira concordarem), CRESCIA a cada entrada de nota
pelo código de barras antigo, e tinha uma saída errada: o checkout online
aceitava o id do modelo. A regra mudou-se para o funil por onde todos passam
(`applyMovement` recusa modelo e kit-que-desmembra), e gerar grade com saldo
no modelo passou a ser recusado, dizendo quantas unidades distribuir.

**Clique duplo na entrada de peça somava a carga duas vezes.** A referência do
movimento era `randomUUID()`: cada chamada inventava uma chave nova, então o
`UNIQUE` do razão nunca colidia. O guarda estava lá, armado, e nunca disparava
— era a única entrada de estoque sem referência estável. O comentário que
justificava o UUID estava certo no motivo (duas cargas da mesma nota
acontecem) e errado na conclusão: a chave vem de quem deu o gesto
(`Idempotency-Key`), porque duas viagens são dois bipes e um clique repetido é
o mesmo formulário.

**Reorçar não reservava a peça de volta.** Orçamento recusado solta a peça —
certo. Reorçar não prometia nada, o balcão vendia, e o cliente que aprovasse
pelo portal recebia "Estoque insuficiente" sem ação possível e sem a oficina
saber. A promessa não podia ser simplesmente refeita (`reserveStock` é
idempotente pela referência), então a referência passou a carregar o CICLO e o
estado da peça deriva só do ciclo mais alto.

**Dez caixas de doze davam entrada como dez unidades.** Não existia conversão
de unidade na entrada de nota. O saldo entrava doze vezes menor (o PDV recusa
venda do que está na prateleira) e o custo doze vezes maior (markup e margem
passam a mentir para o lado que ninguém questiona). A conversão estava dentro
do arquivo o tempo todo: o layout obriga o par `uTrib`/`qTrib`, e o parser o
descartava. Quando nem a nota resolve, a entrada é recusada nomeando a linha e
as duas unidades, e o conferente informa quantas vêm na caixa.

**O carrinho mostrava o preço de ontem e cobrava o de hoje.** O `localStorage`
guarda o produto inteiro congelado; o `checkout` reprecifica pelo banco. O
cliente lia R$ 246,75 e o PIX saía por R$ 329,00. A cotação de frete já
perguntava o preço ao banco e jogava fora — passou a devolvê-lo, e a tela o
adota e DIZ que mudou.

### Estoque, oficina e acesso (os outros seis)

**O saldo por local ficava negativo no lugar errado.** `location_id` era
preenchido por um único chamador; venda, OS e nota gravavam NULL, e a leitura
cobrava o NULL do local padrão — GERAL −3 com a mercadoria na Vitrine. O total
estava certo; a distribuição era ficção, e `transferStock` valida contra ela.
A saída sem local declarado passou a escolher o local que TEM a mercadoria.

**Contagem com moto faltando não tinha fim.** O esperado é congelado na
abertura (certo) e o acerto de serializado é recusado (também certo). O
conferente dava baixa pelo chassi, o saldo passava a bater, e o acerto
estourava com a mesma frase mandando fazer o que já fora feito. A pergunta
passou a ser contra o saldo de AGORA.

**A OS antiga sumia do quadro e o relógio dela continuava.** O kanban pedia
sem filtro e sem limite: recebia as cem OS de número mais alto, finalizadas
incluídas. Numa oficina que fecha 15/dia, a OS parada desde segunda não
aparece em coluna nenhuma — e card que não existe não acende o SLA. Cada
coluna passou a pedir a sua lista, com o próprio total.

**A vitrine congelava o balcão.** Três consultas por produto dentro do laço,
com `node:sqlite` síncrono no mesmo processo que atende `/core/sales`. 100
produtos custavam 301 consultas; agora custam o mesmo punhado que 10. A
passada em memória ficou onde estava — promoção e grade não são coluna.

**Cinco telas abriam para quem o servidor recusa.** Administração da loja,
Entrega, E-mails, Conciliação Asaas e Logística declaravam só `ROTA_GESTAO`. O
estoquista e o atendente montavam a tela inteira e colecionavam 403. Duas
listas novas, citadas pela rota e pelo menu, com varredura por AST no servidor
exigindo que os dois lados digam o mesmo.

**37 das 70 telas nunca eram montadas por teste nenhum.** A rede nova monta
TODA rota do roteador com o servidor respondendo vazio — estado vazio é a
primeira coisa que toda tela vê, e tela que quebra no vazio quebra na estreia.
A lista vem do roteador: escrita à mão, ela ficaria para trás na primeira tela
nova.

### O defeito que a própria conferência encontrou

O passo de migração 73 foi escrito com `CORE_TARGET_VERSION` ainda em 72. O
passo roda assim mesmo, mas `haPassoPendente` não o enxerga — e o **snapshot
antes da migração não é tirado**. O comentário do passo 46 já avisava do
defeito espelhado (alvo maior que o último passo), e só esse lado tinha teste.
O caso novo lê a declaração e exige que o maior `stepApplied` seja o próprio
alvo, nos dois sentidos.

Conferido no banco operacional depois do fato: as três colunas são nullable e
entraram por ALTER, `integrity_check` e `foreign_key_check` limpos, as três
reconciliações das seis empresas voltaram zero, e foi tirada uma cópia
consistente por `VACUUM INTO`.

---

## A nota que a SEFAZ recusaria (rodada 72)

A auditoria de entrega abriu com um achado que para tudo: **nenhuma nota seria
autorizada**. Não uma nota — todas, o dia inteiro, desde a primeira.

### O relógio renomeado

O `dhEmi` do XML nascia assim, nos dois montadores:

```
    issuedAt.toISOString().replace(/.d{3}Z$/, '-03:00')
```

`toISOString()` devolve o relógio de **Greenwich**. Trocar o `Z` por `-03:00`
não converte nada: apenas renomeia aquele relógio, afirmando que ele é local. E
"14:00 em Greenwich" e "14:00 em Pelotas" são instantes diferentes, com três
horas entre eles.

Uma nota emitida às 14h em Pelotas tem `toISOString()` = `17:00:00.000Z` e saía
declarando `2026-08-26T17:00:00-03:00` — que significa 20:00 UTC, **três horas
no futuro**. A SEFAZ recusa toda nota com data de emissão posterior ao horário
de recebimento.

O simulador não pegava porque não valida data. Só a SEFAZ de verdade pega — e
pega na primeira.

### O segundo relógio

A chave de acesso carrega AAMM, e `buildAccessKey` o tirava de
`issuedAt.getFullYear()`/`getMonth()`: o fuso **da máquina do servidor**, que
não é nem Greenwich nem necessariamente o da loja. Eram dois relógios
respondendo "quando foi esta nota" — e na venda das 22h do dia 31 eles
discordavam do mês. Chave incoerente com a emissão também é rejeição, com a
venda já registrada e o número já queimado.

### A regra passou a ter um lugar só

`MomentoFiscal.momentoFiscal(quando, uf)` devolve as duas respostas do mesmo
cálculo: o `dhEmi` com o deslocamento do emitente e o AAMM que a chave usa. O
deslocamento vem da **UF** — o Brasil tem quatro fusos e nenhum horário de verão
desde 2019; se ele voltar, este é o arquivo que muda, e só ele. UF fora da
tabela cai em Brasília: errar por uma hora é ruim, declarar Greenwich seria
errar por três e rejeitar tudo.

`buildAccessKey` passou a **receber** o AAMM e a conferi-lo, em vez de
recalculá-lo — adivinhar o fuso ali recriaria o segundo relógio.

### O que trava o retorno

- prova ponta a ponta: o XML de uma NFC-e das 22h do dia 31 em Pelotas sai com
  `<dhEmi>2026-08-31T22:00:00-03:00</dhEmi>` e chave começando em `43 2608`;
- o texto relido dá **o mesmo instante** que entrou (é isso que a SEFAZ confere);
- varredura recusando `toISOString().replace(Z, deslocamento)` em qualquer
  arquivo de `services/core` — a forma que *parece* certa e já apareceu duas
  vezes, escrita pela mesma intuição, em arquivos diferentes.

**A prova que falta é sua:** emitir uma nota em homologação contra a SEFAZ-RS.
O simulador não valida data nem chave.

---
## A tela não promete o que não faz (rodada 71)

Quatro lugares onde a tela dizia uma coisa e o sistema fazia outra.

**O acréscimo ganhou o campo que a tela mandava usar.** A faixa "Acima do
preço vigente" instrui, com todas as letras: *"Acréscimo de verdade — juros,
frete — entra no pagamento, onde fica visível"*. No pagamento não havia onde. O
servidor aceita `surchargeCents` desde sempre: coluna própria, recusa de valor
negativo (com a mensagem mandando lançar como desconto, que é o que passa pela
alçada) e a regra escrita de não inflar a base de comissão — juros na base
deixaria dar mais desconto quanto mais juros se cobra. Era um campo inteiro sem
leitor. Sem ele, quem precisa cobrar frete sobe o preço da linha: vira "acima
do vigente" e o servidor cobra o preço da tabela.

**A ajuda prometia crediário.** A lista dizia "dinheiro, débito, crédito, PIX,
crediário" e o crediário está desligado no catálogo do servidor: nunca é
devolvido por `/payment-methods`, não vira botão, e a tecla não escolhe nada.
Venda a prazo é justamente o que um cliente pede em voz alta no balcão. A ajuda
passa a listar os quatro meios que existem, com varredura cobrando.

**A reimpressão falhava em silêncio.** O `void` engolia a rejeição: impressora
sem resposta ou pop-up bloqueado, e o cupom não saía sem nada mudar na tela — o
operador clicava de novo achando que o clique não pegou, com o cliente
esperando o papel. Reimprimir não refaz venda nem mexe em caixa; o único
estrago possível ali era o silêncio.

**A gaveta aceitava tipo de movimento inventado.** A rota repassa
`movementType` cru e o sinal era decidido por `=== 'withdrawal' ? −abs : +abs`.
Tipo do TypeScript não existe em execução: qualquer outro texto caía no ramo
POSITIVO e virava dinheiro entrando na gaveta, com um tipo que nenhum relatório
sabe ler. Agora os três tipos legítimos são conferidos em execução.

### Conferido na tela, com o banco real

Camisa de R$ 129,90 no carrinho, F10 abre o pagamento, R$ 15,00 no campo
"Acréscimo (juros, frete)" → total e falta receber passam a **R$ 144,90**. Esc
fechou o pagamento e o F6 limpou o carrinho; o turno seguiu aberto e nada foi
gravado.

---
## O fechamento do dia bate com o papel (rodada 70)

A tela que fecha a gaveta é a última do dia e a mais delicada: o operador está
com as notas na mão e o que ele registrar ali vira fato. Ela tinha quatro
problemas — e nenhum era conta errada.

| O defeito | O conserto |
| --- | --- |
| **Dois números verdadeiros que se contradiziam.** "Recebido no turno · dinheiro" é o que o cliente ENTREGOU; "Esperado na gaveta" é o que FICOU. Numa venda de R$ 50 paga com R$ 100, um diz 100 e o outro diz 50, e nada explicava a diferença — quem confere conta R$ 50 e vai procurar um erro que não existe | O servidor passa a mandar o troco do turno, e a tela escreve a conta: *entregue − troco = gaveta*. A linha só aparece quando houve troco |
| **O esperado não dizia de onde veio.** O servidor sempre mandou os movimentos — abertura, cada venda, cada sangria, cada suprimento, com nota — e a tela guardava dois números e jogava o resto fora | "Como o esperado foi formado", recolhido por padrão. É a diferença entre *confie no número* e *confira o número* |
| **Sem o resumo, o turno fechava às cegas.** Consulta falhou → esperado "—", diferença some, e o botão vermelho continuava ativo. Fechar assim grava conferência sem confronto, e o turno não reabre | Botão travado, com a frase que diz por quê |
| **Fechar não tinha volta e não perguntava nada** — e mora na mesma linha do Suprimento e da Sangria, alimentado pelo MESMO campo de valor | Confirmação mostrando contado × esperado e a diferença antes de encerrar |

Mais duas do mesmo dia:

- **Esc não fechava o diálogo do caixa**, embora a ajuda ensine que Esc fecha
  modal e o pagamento obedeça. Agora fecha — e, com a confirmação de
  fechamento na tela, Esc responde à pergunta em vez de fechar tudo.
- **Com o caixa aberto não sobrava controle nenhum na tela.** A faixa com
  "Abrir caixa (F3)" é `{!cash && ...}` e sumia; os seis botões do rodapé são
  de venda. Sangria, suprimento e fechamento passavam a depender de alguém ter
  lido o F3 dentro do popup de ajuda. A faixa "Caixa aberto · Op.: … · Loja"
  virou o caminho para a gaveta.

### Conferido na tela, com o banco real

PDV da Preço Justo: a faixa de identidade abriu o diálogo, que mostrou
"Caixa aberto · Preço Justo · Op.: Carlos Gerente", esperado R$ 100,00 e a
composição **"Como o esperado foi formado (1 movimento) — Abertura de caixa
+ R$ 100,00"** — batendo com o fundo que o dono lançou às 11h30. Esc fechou o
diálogo e o turno seguiu aberto. Nada foi gravado.

---
## O balcão entre um cliente e outro (rodada 69)

Nenhuma destas quebra a venda isolada. Todas atrapalham o SEGUNDO cliente da
fila — que é o estado normal de uma loja aberta.

| O defeito | O conserto |
| --- | --- |
| **A prateleira vazia só aparecia no Finalizar.** O carrinho aceitava qualquer produto em qualquer quantidade sem olhar saldo; o servidor recusa (`CHECK (quantity >= 0)`), e a recusa chegava depois de o cartão já ter passado na maquininha avulsa | Faixa vermelha no momento do bipe, com o nome do produto, o saldo e o pedido. Não bloqueia — a prateleira pode ter a peça que o sistema não sabe que tem —, mas avisa enquanto o conserto ainda é barato |
| **O foco não voltava para a busca depois da venda.** Quem fecha pelo pagamento tem o foco dentro do diálogo, que desmonta em seguida: o leitor de código de barras passa a bipar no vazio, a cada cliente | `clearSale` devolve o foco à busca |
| **O TROCO do cliente anterior ficava no maior texto da tela.** A faixa central é 26px e só era limpa no começo do Finalizar: o primeiro item do próximo cliente entrava com "TROCO R$ 47,25" escrito acima dele | A mensagem sai quando o próximo item entra no carrinho |
| **Esc não fechava o modal de pré-vendas**, embora o botão dele se chame "Fechar (Esc)" e a ajuda ensine que Esc fecha modal | Esc fecha |

### O padrão que apareceu três vezes: aviso derrubando balcão

Três painéis do PDV só informam — o selo fiscal, o painel fiscal da última
venda e a barra de conexão. Cada um derrubou a tela inteira nesta auditoria,
sempre do mesmo jeito: o servidor devolveu uma forma que a tela não previa e o
componente estourou lendo um campo (`SITUACAO[situacao].classe`,
`status.document.status`, `prontidao.reasons[0]`).

A barreira global do `App` pega a queda, então não é tela branca literal: é a
página de erro do sistema com um botão que recarrega. Para quem está no balcão
dá no mesmo — o carrinho montado com o cliente na frente se perde.

Os três foram consertados onde nasceram. Além disso, os três painéis passam a
ser montados dentro de `PainelAuxiliar`: quando um deles quebra, ele some e o
balcão segue vendendo. Um selo que diz "FISCAL OK" não pode custar uma venda.
Há varredura cobrando que o próximo painel informativo do PDV nasça protegido.

### Conferido na tela, com o banco real

PDV da Preço Justo, caixa aberto (fundo de R$ 100,00 lançado pelo dono às
11h30): pedir 999 de uma camisa com saldo 0 acendeu a faixa vermelha —
"Estoque insuficiente: Camisa Social Slim · Azul · M (saldo 0, pedido 999) — a
venda será recusada. Acerte o estoque antes de cobrar." O F6 limpou o carrinho,
apagou a faixa, devolveu a quantidade para 1 e **o foco para a busca**. Nada
foi gravado.

---
## A venda que ficou na fila (rodada 68)

Quando o servidor não responde, o POST da venda é **guardado** com a chave de
idempotência e sobe sozinho quando a conexão volta. O erro que sinaliza isso —
`API_QUEUED_OFFLINE` — quer dizer "deu certo, só ainda não subiu", e caía no
ramo genérico do PDV: faixa vermelha, diálogo de pagamento aberto, carrinho
intacto.

O operador lê "Sem conexão" em vermelho com o cliente na frente e faz o óbvio:
cancela e refaz. O carrinho novo nasce com chave NOVA — a antiga morre com o
cancelamento —, e quando a rede volta a fila sobe **duas vendas** do mesmo
cliente: duas baixas de estoque, dois lançamentos de dinheiro.

Agora a venda enfileirada fecha o pagamento, limpa o carrinho e avisa em tom de
confirmação, com a instrução que evita o estrago: **NÃO refaça esta venda.**

A segunda metade é a barra da fila. Ela dizia sempre "Ainda não foi possível
enviar. Tentaremos de novo." — verdade para rede instável, mentira para a
recusa que mais acontece aqui: a venda foi guardada com a sessão de caixa
daquele turno, o turno fechou, e o servidor passa a recusar. Nova tentativa
nunca vai dar certo, e o dinheiro já foi recebido do cliente. O motivo já era
gravado a cada tentativa e ninguém lia; agora a barra mostra a recusa com as
palavras do servidor, e a venda continua na fila — recusa não é descarte.

---
## Cada loja é a sua (rodada 67)

Quatro coisas em que o grupo aparecia no lugar da loja — ou em que a loja não
aparecia de jeito nenhum.

| O defeito | O conserto |
| --- | --- |
| **A comissão de todas as lojas ia para o operador do caixa.** O PDV monta o seletor "Vendedor" chamando `GET /core/team`, que exige gerente. O 403 caía num catch silencioso, o seletor nunca aparecia, e toda venda saía em nome de quem estava no caixa | Porta nova do balcão: `GET /core/sellers`, alcançável pelos caixas, devolvendo **id, nome e ativo**. A rota de gestão continua de gestão — ela traz login, e-mail e último acesso, e login é metade de uma credencial |
| **O gerente da oficina abria o PDV e não vendia nada.** Todas as rotas de dinheiro do balcão nomeavam `gerente_loja` e esqueciam `gerente_oficina` — abrir caixa, sangrar, suprir, fechar, lançar pré-venda, faturar, vender. Em oficina pequena o gerente É quem fica no balcão: ele montava o carrinho com o cliente na frente e tomava 403 no Finalizar | A lista virou um nome, `BALCAO_E_GERENCIA`, como os caixas já tinham virado — com varredura cobrando que nenhuma rota de balcão cite `gerente_loja` sem a oficina junto |
| **A junção com a oficina não carregava a empresa.** `LEFT JOIN core_workshops w ON w.id = p.workshop_id`, sem dizer de qual empresa. Esse `workshop_name` é o texto que o PDV mostra ao bipar uma peça de bancada — e o mesmo JOIN estava copiado em oito lugares, inclusive no portal do cliente e na lista de equipe | Predicado de empresa nos oito, e varredura para o próximo que copiar. A lista de oficinas de um colega, na tela de Equipe, passa a ser só a desta empresa |
| **O cupom do cliente dizia GRUPO SAMPAIO em 13px e a loja em 10px**, sem endereço nem telefone. Quem quer trocar a peça na semana seguinte ficava com um papel que não diz para onde voltar | A loja é o título; o grupo, o sobrenome. CNPJ formatado, endereço e telefone vindos do cadastro fiscal quando existem — e o cupom continua saindo inteiro para a loja que ainda não emitiu nota |

---
## O pagamento dividido no teclado do balcão (rodada 66)

A conta do pagamento dividido estava certa — foi conferida na sua tela antes de
qualquer mudança: R$ 100,00 em dinheiro numa venda de R$ 246,75, "falta receber
R$ 146,75", PIX com o campo vazio (que significa "o resto"), "falta receber
R$ 0,00". O servidor também: o troco sai limitado ao dinheiro liquidado, e a
gaveta recebe o espécie MENOS o troco.

O que estava errado era o teclado em volta dela — e o diálogo que decide tudo
isso não era importado por **nenhum** teste do projeto. Agora tem 11.

| O defeito | O conserto |
| --- | --- |
| **F5 recarregava o navegador no meio do pagamento.** O `preventDefault` só acontecia quando o Finalizar já podia fechar — e em pagamento dividido ele fica desabilitado a montagem inteira, que é justamente quando o botão ao lado mandava usar essa tecla | Quem finaliza é **F10**, a mesma tecla que abriu o pagamento. F5 volta a ser do navegador — a mesma doutrina que o PDV já seguia, agora com varredura cobrindo os dois arquivos |
| **As teclas 1..5 nunca chegavam.** O ouvinte desistia quando o foco estava num INPUT, e o diálogo foca o campo de valor ao abrir e depois de cada lançamento. O dígito não escolhia meio nenhum: ia para o valor. Apertar "2" para escolher débito somava um 2 ao número em digitação | **Alt+1 a Alt+5**, o mesmo idioma do Alt+O da observação. Sem o Alt, o dígito é do campo, que é o dono legítimo dele. A ajuda do PDV foi corrigida junto |
| **O campo lia CENTAVOS enquanto o resto do PDV lê REAIS**: "50" virava R$ 0,50. No mesmo balcão, o campo de preço da linha lê "50" como R$ 50,00 | O campo passa a usar `parseReaisToCents`, como todo o resto |
| **Sair apagava os lançamentos sem perguntar.** A lista mora no estado do diálogo, e o PDV o monta sob `showPayment`: qualquer saída joga tudo fora | Com lançamento na lista, o Voltar pergunta antes. Sem nenhum, sai na hora — perguntar ali seria atrito puro |

### O que a auditoria levantou sobre a maquininha, e por que não entrou

Três achados sobre cartão foram **refutados na verificação**, e o motivo é o
mesmo nos três: a maquininha integrada não existe na entrega. O adaptador
devolve "autorizado" no modo simulado e "falhou" em qualquer provedor real, e
nenhuma tela envia o campo que produziria um estado indefinido. Cobrança dupla,
estorno perdido e travamento por timeout **não são alcançáveis** hoje. O cartão
é lançado à mão, conferindo o comprovante da maquininha avulsa — que é como as
seis operações trabalham.

---
## Todo dinheiro em espécie passa pela gaveta (rodada 65)

Três caminhos de dinheiro vivo estavam fora da gaveta. Nenhum era erro de
servidor: o servidor sabe fazer a coisa certa nos três, e esperava um campo que
a tela nunca mandava. É o defeito mais silencioso que existe numa loja — não dá
erro, não dá aviso, e aparece semanas depois como diferença de caixa que ninguém
consegue explicar.

| Onde | O que acontecia | O que passa a acontecer |
| --- | --- | --- |
| **Devolução em dinheiro** (`DevolucoesPage`) | A tela dizia "Sai da gaveta, se houver caixa aberto" e nunca mandava `cashSessionId` — nem chamava `getOpenCash`. O operador tirava as notas, devolvia ao cliente, e o fechamento dava FALTA do valor exato | A sessão aberta vai no corpo, lida na hora do envio. Sem caixa aberto, a devolução em dinheiro é recusada com a frase que diz o que fazer. Cartão e PIX seguem — voltam pela operadora |
| **Cancelamento de venda** (`SalesService.cancelSale`) | O débito ia para a sessão da VENDA, mesmo fechada. Cancelar hoje uma venda de ontem punha lançamento no turno de ontem — já contado, conferido e assinado | Turno ainda aberto: nele, como sempre. Turno fechado: na gaveta de HOJE, com nota dizendo de qual venda e turno veio. Nenhum caixa aberto: recusa dizendo quanto será devolvido em espécie |
| **Recebimento de OS** (`OrdemServicoPage`) | `cobrar()` postava só os pagamentos. A OS era paga em espécie no balcão da oficina, a venda nascia certa, e a gaveta não via nada | Manda a sessão, lida na hora. Sem caixa aberto, recusa; PIX e cartão passam |

Um detalhe de acessibilidade que apareceu no caminho: o campo de quantidade da
devolução não tinha nome nenhum — quem lê por leitor de tela ouvia "caixa de
rotação" sem saber de qual item. Agora ele se chama pelo produto.

---
## O caixa manda no PDV (rodada 64)

Você pediu três coisas antes da entrega: que cada loja tenha a SUA informação
no PDV, que a tela de abertura de caixa apareça sozinha quando o caixa estiver
fechado, e que o pagamento dividido esteja pronto. Medindo na sua tela, com o
banco real, o que existia era isto:

**O PDV vendia com o caixa fechado.** A faixa amarela dizia a verdade —
"Nenhum caixa aberto. A venda será registrada sem movimento de gaveta." —, e é
a verdade que denuncia o desenho: o dinheiro entrava sem gaveta nenhuma. No fim
do dia o operador conta as notas e o sistema não tem de onde tirar o confronto.

**Os seis PDVs eram idênticos.** "GRUPO SAMPAIO" em 26px no topo; o nome da
loja em 13px, sem negrito, na segunda faixa, depois do nome do operador. As
cinco paletas por marca já existiam em `tokens.css`, testadas, aplicadas só na
loja pública: o balcão nunca declarou `data-marca`.

**O pagamento dividido já funcionava** — e isso foi conferido na sua tela antes
de mexer em qualquer coisa: Gringa, jaqueta de R$ 246,75, R$ 100,00 em dinheiro
→ "falta receber R$ 146,75" → PIX com campo vazio (que significa "o resto") →
"falta receber R$ 0,00". A conta do misto está certa no servidor também: o troco
sai limitado ao dinheiro liquidado e a gaveta recebe o espécie MENOS o troco.

### O que mudou

| O defeito | O conserto |
| --- | --- |
| O PDV vendia sem gaveta | A venda é recusada no `finalize` — o único ponto por onde F8, F10 e a conversão de pré-venda passam. A faixa deixou de descrever o estrago e passou a dizer o que fazer |
| A abertura ficava escondida atrás de um botão | O diálogo sobe sozinho ao entrar sem caixa, uma vez, e fechá-lo continua sendo decisão do operador |
| Rede caída = caixa fechado | São coisas diferentes: a recusa só vale quando o sistema SABE que não há gaveta. Consulta falhou, o balcão continua vendendo — travar a loja por uma piscada de rede seria pior que o problema |
| A sessão de caixa era lida uma vez, na montagem | Relida quando a janela recupera o foco. O caixa é um por empresa: o gerente fechava o turno de outra máquina e esta tela achava a gaveta aberta o resto do dia |
| O grupo era a identidade; a loja, o rodapé | O nome da loja assume os 26px, o grupo vira sobrenome em 12px — e o balcão passa a declarar `data-marca`, então a paleta da marca chega ao PDV (Preço Justo verde, Gringa azul-marinho, Me Mimei rosa, PJ Motors grafite) |
| O diálogo do caixa não dizia de qual loja era a gaveta | Nomeia a loja e o operador no cabeçalho e no `aria-label`. Virou a PRIMEIRA tela do dia: pedia dinheiro sem dizer de quem |
| F8 fechava a venda POR BAIXO do diálogo do caixa | `showCaixa` entrou no guarda dos atalhos, onde os outros três modais já estavam |
| Depois de abrir o caixa, o modal ficava na tela | Fecha sozinho — e só quando a abertura passou de verdade. Ficava com o botão vermelho "Fechar caixa" exatamente onde o dedo acabara de clicar em "Abrir caixa" |
| Código de barras bipado virava fundo de troco | Teto de R$ 100.000,00 com recusa que explica. `parseReaisToCents` lê "7894561230012" como R$ 7.894.561.230,01, e o servidor só recusa negativo |
| A venda em espera era do GRUPO | `escopoDaEspera` leva a empresa junto. Sem caixa aberto, as seis gravavam na mesma chave do mesmo `localStorage` da mesma máquina — o carrinho da Gringa aparecia no PDV da Me Mimei. E "sem caixa" é como o dia começa |
| Uma situação fiscal desconhecida apagava o PDV inteiro | O selo tem alternativa. A tabela tem quatro chaves; uma quinta vinda do servidor deixava `undefined`, o componente quebrava no `.classe` e o React desmontava a árvore toda — tela branca no meio do atendimento |

### Conferido na sua tela, com o banco real

- PDV da **Gringa** (caixa aberto): "Gringa" 26px/700, "GRUPO SAMPAIO" 12px,
  `data-marca="gringa"`, gradiente azul-marinho. Sem diálogo, sem faixa.
- PDV da **Preço Justo** (caixa fechado): o diálogo **subiu sozinho**, com
  "Abrir caixa · Preço Justo · Op.: PDV Preço Justo" e `aria-label`
  "Caixa · Preço Justo"; gradiente verde, `data-marca="preco-justo"`.
- **A venda foi recusada de verdade**: item no carrinho, F10 apertado, o
  pagamento NÃO abriu, o diálogo do caixa voltou e a tela disse "abra o caixa
  antes de vender". Carrinho cancelado em seguida; nada foi gravado.

### Uma consequência que vale saber

A espera guardada pela versão anterior sem caixa aberto ficava sob a chave
literal `sem-caixa`; agora o escopo leva a empresa. Um carrinho parado nessa
situação no dia da atualização some da lista. Espera é do turno e do navegador —
não deveria atravessar o dia —, mas está dito aqui porque é mudança visível.

---
## O polimento profissional (rodada 57)

A última rodada do plano não desenha nada novo: ela pega a loja pública que as
rodadas 48–56 construíram e a termina — estados de carregando/vazio/erro em
todo fetch, celular e teclado de verdade, as palavras que o cliente lê, e a
loja pronta para o dia em que as fotos chegarem. O mapa veio de cinco lentes em
paralelo (estados, teclado, celular, tipo/espaçamento, fotos) mais a medição na
tela: **53 achados**, quase todos pequenos — e é disso que é feita a diferença
entre "funciona" e "profissional".

### Todo fetch responde às três perguntas

A vitrine de produtos tinha os três estados desde a rodada 56 — e o padrão
parou nela. O resto fundia "ainda não chegou", "chegou vazio" e "não deu" num
estado só, ou engolia a falha:

- **A cotação de frete do checkout falhando deixava o quadro "Como você quer
  receber" VAZIO** — sem opção, sem aviso, sem retry — no momento de maior
  intenção de compra. Agora fala e oferece "Tentar de novo".
- **O detalhe do pedido derrubava o PIX.** O refresh automático de 15s falhando
  substituía a página inteira — com o copia-e-cola que o cliente estava usando
  — por "Pedido não encontrado.", que era mentira: a rede piscou. Falha de
  atualização com o pedido na tela virou aviso discreto; "não encontrado" só
  quando o servidor disser.
- **`/loja/stores` falhando** deixava a home com "Nossas lojas" e nada
  embaixo; na página da marca, a busca nunca montava e o herói nunca aparecia
  — sem aviso, para sempre. Três estados e retry nos dois lugares.
- **Avaliações**: "ainda não foi avaliado" cobria carregando, erro e vazio — um
  produto cinco estrelas mostrava a frase a cada abertura da página. O vazio é
  uma afirmação; só a resposta dá o direito de fazê-la. O mesmo em Meus
  pedidos, Meus aparelhos e no perfil da conta (cujo catch vazio fazia o
  formulário "Meus dados" sumir sem uma palavra).

### O celular deixou de enterrar a loja

Medido em 375px: o cabeçalho ocupava **171px** (21% da tela) e o primeiro
produto ficava a ~2 telas de rolagem, atrás de herói + carrosséis + pílulas +
filtros. Agora: cabeçalho em **97px**, preço/ordenação atrás de um botão
"Filtrar e ordenar" com `aria-expanded` (recolhido por CSS — os valores
digitados sobrevivem; `order` continua banido, rodada 56 explica), pílulas de
departamento em faixa rolável, e a grade **entra na primeira tela**. Campos de
formulário no toque sobem para 16px — abaixo disso o iOS dá zoom no foco e o
checkout vira briga de pinça. A regra precisou ser `html input`: o tokens.css
é importado ANTES do preflight do Tailwind, que também declara font-size em
`input`, e na mesma especificidade a ordem entregava a vitória a ele — medido
na tela antes e depois.

### O teclado opera a loja inteira

O diálogo de cancelar pedido — a decisão sem volta — não movia o foco, não
fechava com Escape e largava o teclado no `<body>` ao fechar. Agora o foco
nasce em "Manter pedido" (Enter por reflexo mantém, não cancela), Tab circula
dentro, Escape fecha e o foco volta a quem abriu. Três pares input+botão
viviam em `<div>` e Enter não fazia nada: o CEP da simulação de frete, o
código de confirmação do e-mail e o código do balcão da oficina — os três
viraram `<form>`. As estrelas da avaliação eram um `<span>` com aria-label que
o leitor ignorava, soletrando "estrela preta" cinco vezes por avaliação —
viraram `role="img"` com "4 de 5". E a pílula de pagamento escondia o anel de
foco no rádio `sr-only` clipado a 1px — o rádio virou `peer` e a pílula
visível reage.

### As palavras que o cliente lê

- **"2 disponível(is)", "1 produto(s) online", "até 3 dia(s) útil(eis)",
  "avaliação(ões)"** — o "(s)" é a tela confessando que não decidiu o plural.
  `contar()` decide: "2 disponíveis", "1 dia útil". Sete pontos públicos; as
  telas internas do ERP ficaram para depois, por decisão de escopo.
- **"· UN" saiu da página do produto** — código de unidade é vocabulário do
  cadastro; quilo continua aparecendo, porque informa.
- **O aviso de entrega falava com a pessoa errada**: "o envio depende de dados
  de embalagem que ainda não foram cadastrados (peso, altura, largura,
  comprimento)" é diagnóstico para o dono — que já o recebe na Prontidão
  Online. O comprador lê o que interessa: "este produto é só retirada na loja,
  por enquanto". *(O teste antigo exigia o vazamento — foi revertido com a
  razão documentada.)*
- **O vazio da busca mandava "limpe os filtros" sem oferecer o botão** — a
  mesma família do hint do WhatsApp da rodada 56. Agora "Limpar a busca e os
  filtros" limpa busca, departamento, galho e faixa de preço num clique.
- **"Ver carrinho" jogava na home do GRUPO** — outra paleta, carrinho fechado,
  a Gringa para trás. Agora leva a `/{loja}?carrinho=1`, que abre o carrinho e
  limpa a URL.

### A loja pronta para as fotos

Zero produtos têm foto hoje; o lote vem. O dia em que chegar não pode quebrar:

- **`FotoDeProduto`** — uma moldura só (eram quatro cópias de par moldura+img)
  que carrega preguiçoso (`loading="lazy"`: o servidor serve o ORIGINAL sem
  redimensionar) e, se a imagem falha, volta sozinha ao LugarDaFoto na mesma
  proporção. Antes, URL morta era o ícone quebrado do navegador dentro da
  vitrine.
- **A galeria do detalhe descarta a foto morta** e segue com as vivas; a foto
  grande virou `object-contain` — `cover` na moldura quadrada cortava a parte
  de cima e a de baixo de roupa em retrato, o formato natural da Gringa.
- **A capa do herói ganhou altura reservada** (h-40/h-56): antes tinha altura
  zero até carregar e empurrava título, WhatsApp e selos. O card de loja sem
  capa ganhou o bloco tipográfico da inicial — no dia em que UMA loja tiver
  capa, as outras não ficam tortas na mesma linha.
- **A oferta seguia quadrada numa loja de retrato** — medido na tela: o mesmo
  produto em duas proporções, uma seção acima da outra. Os carrosséis seguem a
  proporção do arranjo.

### Tipo e espaçamento, afinados

O preço do produto — o número mais importante da página — estava em `32px`
cru, fora dos sete degraus; subiu ao topo da escala (36). O wordmark do
cabeçalho, em `26px` cru quase empatado com o h1 de 28, entrou na escala
(22/28 por breakpoint). Títulos de seção irmãos usavam degraus diferentes por
acidente (Ofertas em 18, Nossas lojas em 22) — todos em xl semibold. O preço
dos carrosséis empatava com o nome — subiu um degrau. A grade ganhou
`line-clamp-2` no nome, `gap-4` e raio 12 como os outros cards da mesma
página. E "Ver produto" quebrava em duas linhas no card de 152px do celular —
o rótulo encurta para "Ver" em base, com o nome por extenso no aria-label.

### O que a revisão adversária pegou

5 lentes, 30 agentes, 25 achados, 5 refutados, **20 confirmados** — 15
defeitos distintos depois de juntar o que duas lentes viram do mesmo jeito.
Quase todos da mesma família, e vale nomeá-la: **estado que sobrevive ao que o
criou**.

- **A foto escolhida deslizava.** `fotoAtiva` era um ÍNDICE numa lista que
  encolhe: galeria [A,B,C], o cliente clica em B, a miniatura de A falha
  depois (é lazy, chega tarde numa rede móvel), a lista vira [B,C] — e o
  índice 1 agora é C. A tela trocava sozinha a foto que ele pediu, com a
  miniatura errada marcada. A seleção passou a ser a URL, que não desliza.
- **As avaliações do produto anterior ficavam sob o produto novo.** A página
  do produto não desmonta ao navegar pela prateleira "Também em X" — só o
  parâmetro muda —, então a nota, a contagem e os comentários do item
  anterior seguiam na tela. E como o catch desta rodada preserva o dado em
  vez de apagá-lo, uma falha na troca deixaria as avaliações do outro produto
  ali em definitivo, com a mensagem de erro em cima.
- **Sair e outra pessoa entrar no mesmo navegador** — o computador de casa, o
  balcão — mantinha `pedidos` da conta anterior na tela enquanto a chamada da
  nova não voltava. Pedido de outra pessoa não é atraso, é vazamento.
- **O 401 do polling virava "Tentando de novo…" eterno.** O refresh de 15s
  roda justamente na tela do PIX, onde o cliente fica minutos — e a sessão do
  portal vence em uma hora, sem renovação. Tratar sessão vencida como rede
  piscando deixava a página martelando um 401 a cada 15 segundos, prometendo
  uma atualização que nunca vinha: quem pagou nunca veria o pedido virar
  "pago". Só rede e 5xx são transitórios agora.
- **O trap do diálogo desarmava** (o grave): preso ao `onKeyDown` do
  container, só funcionava com o foco já dentro — e o foco escapava, porque o
  botão que abriu desmonta quando o pedido deixa de ser cancelável. O Tab
  passeava pela página atrás do véu, invisível. Foi para o documento; o
  Escape passou a respeitar a requisição em voo; o erro do cancelamento, que
  morava na seção de baixo (coberta pelo véu), entrou no próprio diálogo; e o
  foco, ao fechar, vai para o título quando o abridor já não existe.
- **"Retire sem custo" era prometido sem perguntar se a loja faz retirada.**
  É o mesmo `pickup_enabled` que decide o selo "Retire na loja" — prometer no
  detalhe o que o selo não afirma é a tela garantindo o que o cadastro nega,
  e o cliente descobre no fim do checkout com o carrinho montado. O campo
  passou a vir no payload do produto.
- **O "Tentar de novo" da vitrine curava só a grade** — ofertas, destaques e
  departamentos somem em silêncio quando falham, e o botão os deixava para
  trás.
- **O QR reabria a ficha depois de fechada**: o efeito depende da lista, que
  recarrega a cada ação, então qualquer mexida ressuscitava o que o cliente
  acabou de fechar.
- **O piso de 16px do toque era derrotado no campo do PIX** — a classe `xs` é
  mais específica que a regra global, justamente onde o cliente toca para
  copiar.

Mais: `aria-label` dizia "Ver" num botão escrito "Escolher"; o anel de foco
das pílulas era decapitado pelo `overflow-x-auto`; a loja do produto só
existia dentro do quadro `aria-hidden` dos carrosséis (na home do grupo, quem
usa leitor ouvia "Jaqueta, R$ 246,75" sem saber de quem é); e falha de
atualização das avaliações apagava o resumo que já estava na tela — a mesma
regra do PIX, que a própria rodada tinha escrito e não aplicara ali.

Uma mudança de servidor entrou por causa da revisão: `pickupEnabled` no
payload do produto. Esquema segue 71, rotas seguem 348.

A rodada foi provada por **54 testes novos** em cinco arquivos (palavras,
estados, teclado, fotos, revisão), com a mordida registrada nos dois momentos:
42/43 vermelhos antes do conserto do polimento, e três guardas da revisão
quebrados de propósito derrubando exatamente os seus testes.

---

## "A comunicação com a SEFAZ funciona?" (rodada 58)

O dono subiu o certificado A1 da Preço Justo e fez a pergunta mais simples que
existe. **O sistema não sabia responder.**

`statusServico` existia nos dois adapters, falando SOAP de verdade contra
`nfe-homologacao.sefazrs.rs.gov.br` — e ninguém o chamava: nem rota, nem tela.
A tela do certificado mostrava `CERTIFICATE_LOADED · falta teste real contra a
SEFAZ`, cobrando um teste que ela mesma não oferecia. É a terceira vez que
esta base tem código nascido sem porta (o `PATCH /workshop/parts/:id` da
rodada 55 e o `POST /:provider/homologate` do Asaas, ainda sem tela, são os
outros dois).

Agora existe `POST /fiscal/sefaz/status` e um bloco na tela do certificado: o
dono digita a senha, e o sistema fala com o fisco do estado dele.

### Por que o status, e não uma nota de teste

`statusServico` é a única conversa com a SEFAZ que **não cria documento**. Ela
prova quatro coisas de uma vez — a senha abre o arquivo, o TLS fecha com a
chave, o webservice do estado está no ar, e a cadeia do certificado é aceita
por ele — sem gastar numeração e sem exigir produto classificado. Emitir para
testar exigiria CRT, série, NCM, CFOP e destinatário, e cada pendência de
**cadastro** esconderia a resposta sobre a **comunicação**, que é o que se
perguntou.

Duas decisões acompanham:

- **Sem simulador aqui.** Todas as outras rotas fiscais caem no
  `SefazTestAdapter` quando não há senha, fora de produção — é o caminho de
  desenvolvimento das telas. Esta não cai: uma tela que responde "SEFAZ de pé"
  sem ter falado com a SEFAZ é pior que tela nenhuma.
- **A senha continua não ficando.** Ela é pedida a cada teste, some do campo
  quando a resposta chega, e não entra na auditoria — que registra o
  resultado, porque é prova de diligência para o contador.

### O que a revisão adversária pegou

5 lentes, 29 agentes, 25 achados, **19 refutados**, 6 confirmados — 4 defeitos
distintos, e o primeiro era grave.

- **A tela pintava VERDE enquanto a SEFAZ dizia que estava parada.** `cStat
  108` é "Serviço Paralisado Momentaneamente", e o adapter real o tratava como
  no ar. Eram **três respostas para uma pergunta só**: a tabela canônica
  (`SERVICE_UP: ['107']`) e o adapter de teste diziam parado; só o adapter que
  fala com o fisco de verdade discordava. O dono leria "serviço em operação" e
  concluiria que podia emitir. A cicatriz é a mesma das três definições de
  "abaixo do mínimo" da rodada 55 — agora a tabela manda, e a diferença entre
  108 (momentâneo) e 109 (sem previsão) chega pelo `xMotivo`, com as palavras
  do fisco.
- **O ramo de timeout era código morto.** A checagem era `err.name ===
  'TimeoutError'` — idioma correto no `PaymentService`, onde o `fetch` usa
  `AbortSignal.timeout`. Aqui o transporte embrulha tudo em
  `TransportFailure`, então nenhum timeout casava: o caso mais comum de todos
  — fisco lento, justamente quando esperar resolve — caía no ramo genérico e
  mandava o dono caçar firewall e proxy. Passou a decidir pelo tipo.
- **O cofre que não abre acusava quem digitou.** `decryptFiscalSecret` estoura
  sem `code` quando a chave do cofre não confere — e ela **vai** mudar: o
  servidor recusa subir em produção com a chave padrão de desenvolvimento, que
  é a que cifrou o certificado de hoje. Na virada, a tela diria "a senha não
  abriu" com a senha certa, e nenhuma senha resolveria. Agora diz o conserto
  real: enviar o `.pfx` de novo.
- **UF sem endereço virava erro de rede** e **`unit-default` estava cravado** —
  os dois achei antes da revisão chegar. Só o **RS** tem endereço no adapter
  real: um dono de outro estado leria "confira a conexão e o proxy" por um
  problema do nosso cadastro de endereços. E cravar a unidade faria a rota
  dizer "esta operação não tem certificado" sobre um arquivo guardado sob
  outra.

Uma lição de teste veio junto: `vi.restoreAllMocks()` na última linha do caso
**não roda quando o `expect` falha antes** — e o mock vazado derruba os casos
seguintes por um motivo que não é o deles. Aconteceu nesta rodada, com dois
casos verdes quebrando junto. Foi para o `afterEach`.

19 testes, com a mordida provada em três levas. Contador de rotas 348 → 349.

---

## A cadeia do certificado nunca chegava à SEFAZ (rodada 59)

O dono apertou o botão da rodada 58 com o A1 real da Preço Justo e leu que **a
comunicação não foi permitida**. A rodada 59 é o conserto — e a lição de dois
erros meus.

### A rede estava limpa; o certificado é que ia pela metade

Medido antes de tocar em código: DNS resolvendo (`200.233.4.136`), porta 443
aberta, e o TLS do servidor da SEFAZ fechando — um GET sem certificado devolve
**403**, que é exatamente o que um servidor de TLS mútuo responde a quem não se
identifica. Não era conexão, proxy, firewall nem fisco fora do ar.

Um `.pfx` da ICP-Brasil carrega o certificado da empresa **mais** as
autoridades que provam que ele é legítimo até a raiz. `parseCertificateA1`
lia `certBag[0]` — a folha — e jogava o resto fora. No handshake, a SEFAZ
recebia uma identidade que não conseguia verificar e cortava a conversa antes
de qualquer XML.

O descarte foi provado antes do conserto: num `.pfx` montado com dois
certificados, extraíamos um e perdíamos a autoridade.

O tipo passou a ter dois campos, e a diferença entre eles é a diferença entre
duas perguntas:

- `certPem` — **só a folha**. Vai no `<X509Certificate>` da assinatura do XML,
  que leva o certificado de *quem assinou*, um só. Colocar a cadeia ali faria
  a SEFAZ rejeitar o documento.
- `chainPem` — **a cadeia inteira, folha primeiro**. Vai no TLS, que responde
  *por que confiar nele*.

### O mesmo defeito estava em dois lugares

`SefazRealAdapter` e `NfeSefazHomologationClient` mandavam a folha sozinha.
`cert: cert.certPem` lê como código certo — é o certificado, afinal — e a
diferença só aparece contra o fisco de verdade, quando já é tarde. Por isso o
guarda é uma **varredura**, não um teste de caminho: `cert: algo.certPem` num
`https.request` fica vermelho com o arquivo apontado pelo nome. Um teste de
caminho protegeria o caminho que eu lembrei; a varredura protege o que alguém
escrever depois.

### E a mensagem me mandou para o lugar errado

O transporte capturava o motivo exato do TLS e a rota da rodada 58 o
descartava para escrever "confira a conexão, o proxy e se a UF permite o
acesso" — a frase que fez o dono caçar firewall enquanto a rede estava limpa.
Agora a frase amigável vem na frente e o motivo técnico entre parênteses:
motivo técnico não é ruído, é a diferença entre consertar em um minuto e
procurar por uma tarde.

### O que o código não pode consertar, a tela avisa

Se o `.pfx` vier **sem** as autoridades — acontece, dependendo de como a
certificadora entrega —, a SEFAZ pode recusar por mais certo que o nosso lado
esteja, e o conserto é do lado de fora. O teste passou a informar quantos
certificados o arquivo trouxe, e a tela avisa quando é só um: sem esse número,
ninguém distingue "o sistema está errado" de "o arquivo está incompleto", e a
pessoa procura no lugar errado — que foi exatamente o que aconteceu.

### Por que os 19 testes da rodada 58 ficaram verdes

Porque todos geram `.pfx` com **um certificado só**, e o mundo real não tem
nenhum assim: certificado ICP-Brasil sempre vem com a AC que o emitiu. O teste
reproduzia um mundo mais simples que o do dono — e um mundo mais simples não
prova nada sobre o dele. Os testes novos montam o arquivo como ele é.

---

## O Node não conhecia a raiz do ICP-Brasil (rodada 60)

O dono testou de novo e leu, com todas as letras:

    unable to get local issuer certificate

**O erro não era do certificado dele — era do certificado que a SEFAZ
apresenta.** A cadeia do webservice do RS é

    *.sefazrs.rs.gov.br  ←  AC do SERPRO SSLv1  ←  AC Raiz Brasileira v10

e essa raiz é do ICP-Brasil. O Node embute a lista de autoridades da Mozilla,
que **não** inclui a Raiz Brasileira: ela vive no truststore do sistema
operacional, que é onde o navegador a encontra. Sem ela o Node não fecha a
cadeia e recusa a conexão antes de qualquer XML.

### O que enganou o diagnóstico anterior

O shell onde as primeiras medições rodaram tinha `NODE_USE_SYSTEM_CA=1` e a
conexão passava; o processo do servidor não tinha, e falhava. **Mesma máquina,
mesmo Node, truststores diferentes** — e a conclusão errada era a mais natural
do mundo: "aqui funciona". A rodada 59 apostou na cadeia incompleta do `.pfx`;
era um defeito real, e não era este. Quem corrigiu foi o dado: o motivo técnico
que a própria rodada 59 fez aparecer na tela.

Provado contra o servidor real, mesma conexão:

| | |
| --- | --- |
| Sem as CAs do repositório | `autorizado=false` · `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` |
| Com as CAs do repositório | `autorizado=true` · sem erro |

### Por que a raiz viaja com o código

`NODE_USE_SYSTEM_CA=1` resolveria em uma linha e quebraria na mudança de
servidor: num contêiner, num Linux de produção ou numa máquina nova a variável
não existe, e o sistema volta a falhar com uma mensagem que fala de
certificado quando o problema é de configuração de processo.

O arquivo é o certificado **público** da AC Raiz Brasileira v10 do ITI — o
mesmo que todo navegador carrega —, extraído do truststore do próprio sistema,
e o teste o fixa por titular, emissor e validade, para que uma troca
silenciosa apareça em vermelho. Um teste avisa um ano antes do vencimento
(2032), para a emissão não parar num dia de movimento.

**A validação continua ligada.** `rejectUnauthorized` segue `true`: o que muda
é que o servidor passa a *conhecer* a autoridade que assina os webservices do
fisco. Desligar faria a conexão aceitar qualquer servidor que se dissesse a
SEFAZ — e o que trafega ali são documentos assinados em nome da empresa.

### O defeito que teria nascido no primeiro dia de produção

A primeira versão guardava o certificado num `.pem` ao lado do código e o lia
com `readFileSync`. Funcionava no desenvolvimento e **morreria em produção**: o
servidor roda de `dist/`, e o `tsc` compila `.ts` — não copia `.pem`. A emissão
fiscal inteira cairia com "arquivo não encontrado", com esta suíte verde do
começo ao fim. O certificado virou constante compilada, e há teste que fica
vermelho se alguém voltar a ler do disco.

Como na rodada 59, o guarda é uma **varredura**: cliente TLS que fala com o
fisco sem declarar `ca` fica vermelho com o arquivo apontado pelo nome.

---

## O Asaas ganha as duas portas que faltavam (rodadas 61 e 62)

O dono cadastrou o webhook no Asaas, colou o token na tela, salvou — e o Asaas
levou **503**. Depois cumpriu todas as travas de produção que dependiam dele e
parou na última, sem botão que a abrisse. Duas rodadas, o mesmo diagnóstico:
**o motor existia e o caminho até ele, não.**

### O token estava salvo; o servidor olhava no lugar errado (61)

  - a **tela** grava com `upsertAsaasWebhookToken` → cofre, por empresa;
  - o **handler** lia `secretProvider.getAsaasWebhookToken()` → só o `.env`.

Duas fontes para a mesma pergunta. A tela dizia "Configurada", o Asaas dizia
503, e as duas afirmações eram verdadeiras sobre lugares diferentes — o dono
não tinha como descobrir. Terceira aparição dessa família nesta base (as três
definições de "abaixo do mínimo" da 55, o cStat 108 da 58).

O webhook é rota **pública**: quem chama é o provedor, não um usuário logado,
então não há `companyId` na requisição — foi por isso que o código caiu na
leitura global. A saída não é adivinhar a empresa: é procurar o token entre os
cadastrados. **Conhecer o token prova de quem é o evento**, que é exatamente
para isso que ele existe, e o handler ganha a empresa que lhe faltava. Cada uma
das seis operações pode ter o seu; quem usa `.env` continua funcionando.

Dois cuidados entraram junto: a comparação é em **tempo constante**
(`timingSafeEqual`) — o endereço é público e aceita tentativas infinitas, e sem
isso o tempo de resposta entrega quantos caracteres o atacante já acertou —, e
`503`/`401` passaram a dizer coisas diferentes: "não há token cadastrado" versus
"o token não confere". Trocar uma pela outra faz alguém salvar de novo o mesmo
valor errado.

Provado contra o Asaas de verdade, por um túnel público: `503` → `401` (o
servidor passou a enxergar o token) → **`200 · ok:true`** com o token do cofre.
O evento de prova gravado no banco foi apagado em seguida.

### A homologação não tinha porta nem chave (62)

A trava "a homologação em sandbox ainda não foi concluída" era a única que o
dono não podia abrir. O motor roda **dezesseis passos** contra o sandbox —
cliente, PIX, QR, boleto, linha digitável, checkout, idempotência, Contas a
Receber, conciliação, webhook. O que faltava:

  - a rota `POST /integrations/:provider/homologate` exige
    `integrations.homologate`, e a matriz declara
    `integrations: { ler: [], escrever: [] }` — **nenhum perfil a tem**;
  - nenhuma tela chamava qualquer uma das duas.

Código correto, inalcançável por qualquer pessoa. **Quarta vez** que esta base
entrega motor sem porta (o `statusServico` da 58 e o `PATCH /workshop/parts/:id`
da 55 são os outros).

A rota nova é do núcleo, com a empresa vindo do **token** — a antiga aceita
`companyId` no corpo, e abrir a permissão dela daria ao gerente de uma loja o
poder de homologar outra sabendo o id, sendo que homologação carimba o estado
que libera cobrança real. E devolve **200 mesmo com `status: 'failed'`**: a
homologação rodou, e o resultado é que não passou; devolver erro esconderia
qual dos dezesseis passos falhou, que é a única informação com a qual alguém
conserta.

### O erro que quase virou dinheiro

Ao verificar a tela, interceptei as respostas no navegador para exercitar
sucesso e falha sem gastar chamadas no Asaas — **e não recarreguei a página
depois**. O dono clicou no botão e leu "Homologação concluída" de uma
simulação minha. O servidor dizia `sandboxHomologated: false`.

Três sinais denunciavam, e viraram o que se confere daqui em diante: **3 passos
em vez de 16**, o selo "Homologação pendente" no topo, e "última homologação:
nunca" — com a própria trava ainda listada acima do botão. A tela se
contradizia inteira.

A lição não é sobre interceptar: é sobre **desfazer a encenação antes de
devolver a tela**. Verificação que sobrevive à verificação vira mentira na mão
de quem confia nela.

---

## A peça é prometida antes de ser baixada (rodada 55)

Quinta rodada do arco da oficina: o **estoque da bancada** como no sistema
anterior — e com as duas metades que lá faltavam.

### A peça saía da gaveta para montar um orçamento que o cliente podia recusar

`addPart` baixava do estoque **no lançamento**. Só que o lançamento acontece
antes da decisão do cliente: a própria oficina exige peça ou mão de obra
lançada para poder *pedir* a aprovação ("Lance mão de obra ou peças antes de
pedir a aprovação"). A corrente era esta:

1. o mecânico monta o orçamento lançando as peças → a gaveta esvazia
2. o cliente olha o valor e diz **não**
3. a peça continua fora do estoque, para sempre

A volta existia — devolver peça, rodada 52 —, mas dependia de alguém lembrar.
Ninguém lembra de desfazer um orçamento recusado.

**A regra desta rodada, em uma frase:** a peça lançada na OS **promete**; a
promessa vira baixa quando o serviço é autorizado a acontecer — na aprovação do
cliente ou na conclusão técnica —, e volta sozinha para a gaveta quando o
cliente recusa.

Promessa não mente sobre a prateleira: `quantity` fica como está e o que muda é
`reserved`. A peça **está** na gaveta, com dono. É exatamente a verdade física
entre orçar e consertar, e é o que impede o balcão de vender o que a bancada
está contando para terminar um serviço. Esperar o pagamento para baixar seria
pior: a moto sai pronta e o sistema segue dizendo que a peça está na prateleira,
com a contagem de inventário acusando uma diferença que não existe.

**O sistema anterior tinha o desenho certo e a metade errada.** Lá o lançamento
chamava `reservarPeca` — com o comentário "o estoque só é baixado quando a OS é
paga no caixa" —, e **nenhum caminho de pagamento consumia a reserva**: não
existe `processOsPayment` no código de lá. Cada OS paga corroía o disponível
para sempre, porque `quantidadeReservada` só subia. Aqui a reserva tem os dois
lados, e os dois são medidos.

**Devolver passou a ter dois tempos**, porque são dois fatos diferentes: peça
ainda prometida nunca deixou a prateleira, e dar entrada nela **inventaria
mercadoria** — o que cai é a promessa. Peça já consumida volta como entrada de
verdade.

### O alarme que dispararia sozinho

A conciliação de estoque compara `core_stock.reserved` com as origens abertas e
grita `STOCK_RESERVATION_WITHOUT_SOURCE` — o alarme mais grave do relatório. O
comentário dizia "pedido online **e pré-venda**"; a consulta só tinha
`core_orders`. Pré-venda e locação **já reservavam e já eram acusadas** sem ter
feito nada de errado, e a oficina seria a quarta. As quatro origens entram
agora, e a definição de "promessa aberta da oficina" mora num lugar só,
interpolada onde é usada.

### A gaveta ganhou entrada

A tela de peças tinha 193 linhas e **nenhum POST**: listava e procurava, e era
só. Cadastrar, repor, dizer o mínimo e dizer em que prateleira a peça mora eram
todos atos do cadastro de PRODUTO — tela de gestão, fechada para o mecânico.
Consequência medida: peça criada por entrada de nota nasce com **mínimo zero**
(a importação não passa `minStock`), e o aviso de "está acabando" exige mínimo
maior que zero — então ele **nunca disparava** para a peça que entra pelo
caminho principal.

O gesto é o do sistema anterior, e é bom porque descreve o que a pessoa está
fazendo: **bipar e resolver**. Código existe → reposição. Não existe → cadastro
com o código já preenchido. Documento de origem obrigatório nas duas portas, e
ele vai para o razão (`document_number`, `unit_cost_cents`, tipo
`MANUAL_ENTRY` — o rótulo honesto: alguém declarou que a mercadoria chegou).
Não substitui a entrada por XML, que continua sendo a porta principal e a única
que gera contas a pagar; esta é a peça comprada na esquina para terminar um
conserto hoje.

**O preço deriva do custo, e a conta já existia.** `Pricing.precoPorMarkup` é
idêntica ao `calcularPrecoVenda` do anterior: custo × (1 + percentual/100). Lá
o campo se chamava "margem" e a fórmula é **markup** — o nome errado é como se
perde dinheiro achando que se está ganhando; aqui os dois já eram distintos. O
percentual **não é guardado**, por doutrina antiga: markup e margem derivam de
custo e preço, e uma cópia gravada divergiria no primeiro reajuste. E o custo
novo **não repreça sozinho**: preço que muda em silêncio é preço que ninguém
decidiu.

**A localização física** voltou como no anterior — texto livre, "Prateleira A3 -
Caixa 2" — e com o que lá faltava: ela é **procurável**. "O que tem na F1?" era
pergunta sem resposta. É endereço de *cadastro*, não dimensão do razão: o
`location_id` do movimento continua onde estava, e a porta de preenchê-lo por
padrão continua fechada de propósito.

### Três defeitos de família que a rodada encontrou de passagem

- **"Abaixo do mínimo" tinha TRÊS respostas.** As peças da bancada olhavam o
  disponível com `<` e exigiam mínimo > 0; o filtro da posição de estoque
  olhava o saldo **bruto** com `<=` — então produto sem mínimo declarado e sem
  saldo entrava na lista de "está acabando", porque 0 <= 0; e o selo da tela de
  estoque fazia a terceira conta. Quem abria a tela para saber o que comprar
  recebia o catálogo inteiro de itens zerados. Agora é uma definição só, no
  servidor, e nenhuma tela recalcula.
- **O recorte de bancada valia na OS e não valia na lista.** O subtítulo da tela
  sempre disse "a de celulares não enxerga a de mobilidade", e a lista mostrava
  as duas. `addPart` recusava a peça da outra bancada — então a separação
  existia onde dá erro e não onde se procura: o mecânico via a peça, escolhia,
  e levava 403.
- **Custo de R$ 1.500,00 virava ZERO.** O formulário de produto tinha um parser
  local que trocava só a primeira vírgula: `"1.500,00"` → `"1.500.00"` →
  `NaN` → 0. É a forma que um brasileiro digita, e o produto mais caro do
  catálogo era o mais provável de ser gravado com custo zero — estragando
  margem, markup, relatório de lucro e o preço derivado desta rodada. O
  interpretador da casa já existia no mesmo módulo de onde o arquivo importava
  `formatCents`.

E uma reserva repetida estourava **500 cru**: `applyMovement` sempre teve
pré-cheque de idempotência, `reserveStock` não tinha — a UNIQUE do razão pegava
o caso como violação de constraint, num caminho em que o certo é não fazer nada.

### O que a revisão adversária pegou — e os dois que a própria rodada criou

4 lentes, 31 agentes, 27 achados, 16 refutados, **11 confirmados e
consertados**. Os dois críticos eram do estado novo:

- **Depois do "não" do cliente a peça ficava morta.** A recusa solta a promessa
  e deixa a linha na conta. O cliente muda de ideia — é o caso normal, a recusa
  existe justamente para reorçar —, o serviço acontece, e os três consumidores
  pulavam a linha por ela não estar mais "prometida". A OS finalizava cobrando
  a peça, com ela dentro da moto e o estoque contando na prateleira. Nenhum
  alarme disparava: a conciliação exclui a linha pelo próprio `release`. Um
  agente reproduziu de ponta a ponta antes de eu consertar.
- **Devolver peça de orçamento recusado inventava estoque.** O ramo de entrada
  assumia que "não é prometida" significa "já saiu" — e `estadoDaPeca` tem
  QUATRO valores. Devolver uma linha `solta` somava mercadoria que nunca deixou
  a prateleira, com um movimento no razão que parece perfeitamente legítimo.
  Saldo inventado não dói na hora: dói na contagem, meses depois.

Os outros nove: a reposição reprecificava sempre (o percentual nascia com 40 de
fábrica); o formulário vazava de um bipe para o outro; o campo do leitor não
esvaziava e o segundo bipe concatenava no primeiro; a mão de obra da OS lia
`12.50` como R$ 1.250,00; o aviso de "está acabando" sumia ao procurar outra
coisa; limpar o endereço gravava o texto `null`; `ajustarPeca` aceitava custo
negativo; a tolerância de ponto flutuante faltava num guarda de peça por metro;
e **a rota de ajuste nasceu sem tela** — o defeito que este repositório mais
encontra, cometido pela própria rodada.

E um em que os revisores discordaram entre si, medido à mão para decidir: **a
rota nomeava `estoquista` e depois o barrava com 403.** A bancada era resolvida
pela filiação a `core_workshop_members`, onde só os mecânicos têm linha. Rota
que convida e depois barra é pior que rota fechada: a pessoa lê o próprio
perfil na lista de quem pode, clica, e conclui que o sistema está quebrado. A
filiação existe para o mecânico, que só pode tocar na própria bancada — e
mecânico não alcança esta rota; para quem dá entrada, a régua é a empresa.

Esquema 69 → 70. Quatro rotas novas: contador 344 → 348.

---

## A ordem de serviço em papel (rodada 54)

Quarta rodada do arco da oficina, e a única coisa que **nenhum dos dois
sistemas tinha**: o papel que o cliente leva para casa.

**O documento já existia — e ninguém conseguia chegar nele.**
`renderWorkshopOrder` estava no catálogo de tipos desde a rodada da fila de
impressão, tinha teste de fumaça, e **nenhuma tela jamais o chamou**: escrito,
registrado e inalcançável. Pior, o desenho estava errado em silêncio — lia
`parts_total_cents` e `labor_total_cents`, colunas que não existem (são
`parts_cents` e `labor_cents`). `Number(undefined) > 0` é falso, então as
linhas de peças e de mão de obra **nunca eram impressas**: o papel mostrava só
o total, sem dizer quanto foi peça e quanto foi serviço, que é a primeira
pergunta de quem paga.

**Quem assina o papel virou dado.** `core_workshops.brand_company_id`: a
bancada de mobilidade pertence à Oficina — a operação interna do grupo —, mas
quem o cliente conhece, quem vendeu a moto e quem responde pela garantia é a
**PJ Motors**, e é o nome dela que sai no cabeçalho. A de celulares assina em
nome próprio, porque já é da Preço Justo. Papel entregue com o nome errado no
cabeçalho não serve para reclamar depois.

**O cabeçalho junta três cadastros**, porque é onde a identidade mora:
`core_companies` (nome e CNPJ), `core_fiscal_configs` (endereço e telefone — o
único cadastro que alguém preenche de verdade, porque a NF-e exige) e
`core_storefront_settings` (a logo, rodada 40). O que faltar não é impresso:
"CNPJ null" no papel é pior que cabeçalho curto.

**O papel serve desde a abertura.** Não são dois documentos: na entrada ele sai
com a conferência de entrada preenchida e a assinatura de recebimento; na
entrega, com diagnóstico, peças e valores. Dois modelos divergiriam no primeiro
campo que alguém mudasse num só — e é exatamente o que a fila de impressão e a
tela agora evitam, entregando o **mesmo** render.

O que o papel passou a mostrar e o anterior ignorava: a conferência de entrada
item a item (rodada 52), prioridade e prazo prometido (rodada 51), a bancada e
o responsável, a plaquinha e o chassi, o **QR de acompanhamento** (só onde a
plaquinha existe — a regra de ouro da 53 vale aqui também), o motivo quando o
serviço é **sem custo** (garantia, cortesia, retrabalho), as condições de
retirada e **duas assinaturas**.

Ainda: o estado da OS saía como código do banco ("Situação: em_andamento") num
documento de cliente — ganhou mapa de rótulos ao lado da lista de estados que
ele traduz. E o mecânico, que é quem está com a máquina na mão, **não conseguia
imprimir**: a fila de impressão não aceita o perfil `mecanico` nem declara o
ambiente `bancada`. A rota nova tem o mesmo alcance da leitura da OS — quem
abre a ordem imprime.

**Um ciclo de importação nasceu e foi cortado**: o renderizador passou a
importar o documento, e o documento precisava do endereço público que morava no
renderizador. Em ESM o ciclo não estoura na hora — deixa uma constante do outro
lado vazia, e o erro aparece longe (um teste de e-mail acusando
`ORDER_STATUSES_ON_BENCH is not iterable`). O endereço público virou módulo
folha, que ninguém consegue ciclar.

**O que a revisão adversária acrescentou** (4 lentes, 29 agentes; 25 achados,
19 refutados, 6 confirmados e consertados):

- **a coluna do papel não fechava com o subtotal** — o documento multiplicava
  em ponto flutuante e deixava o `Intl` arredondar na hora de escrever, e o
  servidor soma `ROUND(unitário × quantidade)` **linha a linha**. Com três
  peças de 0,7 × R$ 0,85, a coluna somava R$ 1,80 e o bloco de valores logo
  abaixo dizia R$ 1,77: o papel que o cliente usa para conferir a conta não
  fechava consigo mesmo;
- **a quantidade saía com lixo de ponto flutuante**: peça vendida por metro,
  com devolução parcial, imprimia `0.19999999999999998` — e com ponto, num
  documento em português onde todo o resto usa vírgula;
- **a logo apontava para a origem errada**: `/uploads` é servido pela API e o
  endereço público é o do site. Num ambiente sem a variável preenchida, a
  janela de impressão pediria a marca ao domínio de produção. A logo passou a
  viajar embutida no papel, que agora imprime sem rede;
- **o teste da fronteira de bancada passava com o guarda removido** — o
  mecânico usado era de outra EMPRESA, então o 404 vinha do `company_id` e
  nunca do escopo de bancada. Refeito com duas bancadas na mesma empresa, e
  conferido vermelho com o guarda apagado;
- **o download do pop-up bloqueado não baixava nada** e a tela dizia que sim: a
  âncora não entrava no documento e o endereço era revogado na linha seguinte
  ao clique — os dois defeitos que `salvarArquivo` já documentava no próprio
  repositório;
- e um **comentário meu estava errado**: afirmava que o Express engoliria a
  rota nova se declarada depois de `/workshop/orders/:id`. Não engole — `:id`
  não atravessa a barra, e `/photos` e `/checklist` convivem com ela há
  rodadas. Regra falsa gravada em comentário faz alguém "consertar" o que está
  certo.

Esquema 68 → **69**. Uma rota nova — contador 343 → **344**. Verificado **na
tela contra o banco real**: a OS #2 da bancada de mobilidade saiu com **PJ
Motors** no cabeçalho, QR de acompanhamento, plaquinha `#0001`, chassi, a peça
de R$ 1.800,00 e a linha de peças que antes nunca aparecia.

**A sua parte, para o papel ficar completo**: o cabeçalho monta o que existe no
cadastro, e hoje só a Preço Justo tem bloco fiscal. Para a OS da oficina sair
com CNPJ, endereço, telefone e logo da **PJ Motors**, faltam o cadastro fiscal
dela e a logo na tela da loja.

---

## A plaquinha existe antes da máquina (rodada 53)

Terceira rodada do arco da oficina, e ela inverte uma ordem. Até aqui a
plaquinha nascia junto do equipamento: `createEquipment` sorteava o número e o
adesivo só podia ser impresso depois que a moto já estava cadastrada. A oficina
trabalha ao contrário — manda imprimir uma folha de adesivos, cola nas máquinas
do pátio, e só então senta para cadastrar cada uma **com o número que já está
colado nela**. Esse caminho não existia.

**O pool** (`core_equipment_tags`) é o registro de todos os números do grupo,
com os quatro estados do sistema anterior:

| estado | o que significa |
| --- | --- |
| `gerada` | o número foi reservado; o papel ainda não existe |
| `disponivel` | a folha **foi exportada**; o adesivo existe e pode ser colado |
| `associada` | já está numa máquina — e isso não se desfaz |
| `danificada` | o adesivo se perdeu, e o número morre com ele |

**`printed_at` é o que separa gerada de disponível.** Só a rota da folha o
grava, e liberar recusa quem não foi ao papel: número liberado sem adesivo é
número que o cadastro aceita e que não existe colado em lugar nenhum. No
sistema anterior "liberar" era qualquer um dos três botões do editor terminar
sem exceção — inclusive o que só gravava um PDF no navegador.

**A numeração é UMA.** Os dois caminhos — lote e cadastro sem plaquinha
escolhida — saem da mesma sequência do grupo, e o pool registra os dois. Duas
numerações vivas dariam dois adesivos com o mesmo número em duas motos, que é o
erro que não tem conserto depois de colado. A migração carrega o pool com todo
equipamento existente e **empurra a sequência** para além do maior número em
uso.

**Trocar o adesivo de uma máquina** é coisa que o sistema anterior não tinha, e
a falta era um beco: o adesivo descascava no sol e a moto ficava sem
identificação para sempre, porque a associação era permanente e marcar
danificada não dava outra à máquina. Aqui a substituição é um fato só — a
máquina adota o número e o token novos, a velha é aposentada guardando de qual
máquina era, e o histórico registra a troca com o motivo (obrigatório).

**O layout é da empresa, não do navegador.** Logo, cores, cantos e milímetros
ficam em `core_equipment_tag_layouts`, com os padrões verbatim do antigo
(100 × 40 mm, margem 4, `#ffffff` / `#1a1a1a`, logo 8/4 de 28 × 20). No sistema
anterior isso vivia no `localStorage` de quem editou: dois gerentes da mesma
oficina imprimiam plaquinhas diferentes, e o backup do sistema nem exportava a
chave. A **geometria** da folha continua no catálogo de formatos, que sabe fazer
a conta do módulo do QR — a divisão que o antigo não fazia, e por isso lá o QR
ia a 28 mm por gosto, sem ninguém saber se dava para ler.

**A REGRA DE OURO do dono virou dado.** `core_companies.uses_equipment_tags`
nasce em 1 para a Oficina e a PJ Motors, e em 0 para todas as outras — plaquinha
com QR e número é das duas operações que lidam com a máquina física; loja de
roupa e de maquiagem identifica mercadoria por etiqueta comercial. Fica no
cadastro, e não numa lista de slugs no código, porque slug se renomeia e empresa
nova nasce toda semana; o padrão zero é o lado seguro.

**Os três buracos que a regra fechou** — nenhum deles tinha guarda antes:

1. **a fila de impressão** (`EQUIPMENT_QR_TAG`) era o único gerador de
   plaquinha **sem gate nenhum**: aceitava perfis de loja e não passava nem
   pela regra da bancada que a rodada 18 escreveu;
2. **a adoção pela loja** — `plaquinhasVinculaveis` filtrava a ORIGEM do
   equipamento e nunca QUEM estava adotando: qualquer das quatro lojas via a
   plaquinha da Oficina e podia adotá-la para uma unidade sua;
3. **o gate de tela** era `company.kind === 'workshop'`, que negava a aba
   justamente à PJ Motors — a empresa que a regra de ouro quer **incluir**.

Ainda: `formatPublicId` existia em **três cópias** (serviço, view pública e
impressão), e as três viraram uma — o número da plaquinha é conceito do pool.

**O que a revisão adversária acrescentou** (5 lentes, 52 agentes; 47 achados,
27 refutados, 20 confirmados e consertados):

- **a credencial vazava em lote** — `GET /equipment-tags` devolvia o
  `public_token` de cada plaquinha, aos perfis mais largos da rodada. Ele abre
  a página pública do equipamento sem sessão, não expira e não se revoga; nas
  plaquinhas associadas é o token da própria máquina. As três rotas irmãs de
  equipamento já podavam o campo há rodadas;
- **um lote cheio ficava preso para sempre** — a folha resolvia a seleção
  filtrando uma lista ordenada pelo número mais NOVO, com teto de mil: num lote
  de 1.000, a plaquinha mais velha saía da janela assim que outra nascia. O que
  a folha não desenha não recebe `printed_at`, e sem papel não há liberação. A
  folha passou a buscar por id — ou pelo lote inteiro — e diz quais ids não
  achou, em vez de deixá-los sumir calados;
- **a logo entrava uma vez por plaquinha**: uma marca de 500 KB viraria 10 MB
  de HTML numa folha de 21, dentro de um JSON. Agora ela é uma regra de CSS,
  declarada uma vez;
- **as duas geometrias brigavam** — o editor prometia 100 × 40 mm e o papel
  saía com os 63 × 33 do formato escolhido. O tamanho do editor virou um
  formato de verdade, com colunas calculadas e a mesma conta de módulo do QR;
- **a prévia desfazia o formulário**: ver a prévia relia a tela, o layout
  gravado voltava por cima do que estava sendo editado, e "Salvar" gravava os
  valores velhos dizendo "Layout salvo";
- **a tela não avisava o que decide gastar adesivo** — módulo abaixo do piso e
  endereço público não configurado, os dois avisos que a tela de Etiquetas já
  dava. E pop-up bloqueado passava em silêncio, com as plaquinhas já contando
  como impressas;
- **a folha da tela de Equipamentos saía sem a identidade visual**, enquanto a
  do pool saía com ela: a mesma plaquinha com duas caras;
- **"não consegui ler" virava "não há plaquinha"**, e o caminho seguinte é
  gerar um lote que talvez já exista;
- o QR era codificado **duas vezes por plaquinha** (2.000 num lote de mil) para
  chegar sempre ao mesmo número; "Liberar" acendia para o mecânico, que a rota
  recusa; a logo grande morria no parser de 1 MB virando "Erro interno"; e os
  botões repetidos da tabela não tinham nome distinguível para leitor de tela,
  com o painel de dano sem foco nem Escape.

Esquema 67 → **68** (duas tabelas novas e a coluna da regra de ouro, com carga
do pool a partir dos equipamentos existentes e a sequência do grupo empurrada
para além do maior número em uso). Nove rotas novas — contador 334 → **343**. Tela nova (Plaquinhas) no menu da Oficina, e o cadastro de
equipamento ganhou o seletor da plaquinha já colada. Servidor +34 testes,
navegador +17. Verificado **na tela contra o banco real**: a migração carregou
a `#0001` como associada sem mexer na sequência; um lote de três nasceu
`#0005`–`#0007`, a folha saiu com módulo de 0,87 mm (piso é 0,5) e a liberação
só passou depois do papel — as três foram **removidas do banco** ao fim, com a
sequência de volta a 4. Depois dos consertos da revisão, conferido de novo
contra a API real que a lista não devolve mais o token do QR.

---

## A máquina ganha ficha, conferência e fotos (rodada 52)

Segunda rodada do arco da oficina. A 51 arrumou o **quadro**; esta arruma o que
o quadro move: o equipamento deixa de ser um nome numa linha e passa a ter
ficha, garantia, conferência de entrada e foto.

**A garantia é DERIVADA, nunca guardada.** O sistema anterior gravava um
`warrantyStatus` no cadastro e nunca o recalculava: máquina vendida em janeiro
com 3 meses seguia "em garantia" no dia de São Nunca, porque ninguém rodava
nada para virar o campo. Aqui o banco guarda só os **meses combinados**, e o
status sai da conta na hora da leitura — sem garantia, vigente, **vence em
breve** (30 dias) ou vencida. A conta anda por mês de calendário em UTC: 31 de
janeiro + 1 mês é 28 de fevereiro, não 3 de março.

**O que a ficha da máquina mostra** (`/sistema/equipamentos/:id`, tela nova):

- identificação inteira — categoria, ano, versão, cor, série, chassi, motor,
  bateria e série da bateria;
- garantia com a data-base (venda, ou entrada quando não houve venda);
- **quem montou e quando** — o mecânico da montagem sai da equipe da oficina,
  e o servidor recusa mecânico de outra empresa;
- as ordens de serviço pelas quais a máquina já passou, com número e valor;
- **o histórico append-only**, que existia no banco desde a rodada da
  plaquinha e **nunca fora lido por tela nenhuma**: `core_equipment_events`
  era escrita pura. A auditoria apontava isso; agora cadastro, venda, abertura
  e conclusão de OS aparecem em ordem, com a OS e o nome de quem fez.

**A conferência de entrada** — que o sistema anterior **não tinha** — nasce
junto com a OS, com molde por bancada: 9 itens na mobilidade (chave,
carregador, bateria e trava, retrovisores, luzes, pneus e freios, riscos,
bagageiro, documento) e 8 nos celulares (chip, cartão, capa e película,
carregador, liga, tela, água ou queda, senha). Item sem resposta **segura a
conclusão técnica** (409), com saída de emergência registrada: "Concluir assim
mesmo" existe porque cliente no balcão não pode ficar preso por um retrovisor
não conferido. OS antiga, sem conferência, não trava nada.

**As fotos vão para o disco**, no caminho das fotos de produto da rodada 45 —
arquivo em `server/data/uploads/os`, nome em UUID, 3 MB por foto e 20 por OS.
O navegador reduz para 1600px antes de enviar. No sistema anterior a foto ia
em base64 para o `localStorage`: **duas fotos derrubavam a persistência de
TODAS as ordens** — esse defeito ficou lá.

**O que a conferência na tela achou** — três defeitos que teste nenhum pegava:

1. **o realce apontava para o desfazer**: como item novo nasce `pendente` e o
   desenho pintava de primário "a resposta atual", quem gritava na linha era o
   "Limpar", com "Veio" e "Não veio" em cinza sem contorno. Agora as duas
   escolhas são botões visíveis e o "Limpar" só existe depois que há resposta
   para desfazer;
2. **a ficha recuava um dia**: informei montagem em 01/08 e a tela mostrou
   31/07; a entrada era 12/08 e virou 11/08. `new Date('2026-08-12')` é
   meia-noite **UTC**, e o Brasil é UTC−3 — o navegador imprimia o dia
   anterior. Dia de calendário agora se imprime como foi escrito, e o
   **instante** do histórico continua no fuso de quem lê, que é o certo para
   ele. O servidor passou a devolver vencimento e data-base como `AAAA-MM-DD`,
   não como instante: um ISO à meia-noite é um convite ao mesmo erro;
3. **a garantia tinha duas contas** — a lista refazia no navegador o que o
   servidor já derivava, "para não pedir mais um campo". As duas divergiram no
   primeiro caso de borda, exatamente como na rodada 51. A lista passou a ler
   `warrantyOf` do servidor, e um teste compara lista e ficha campo a campo.

**O que a revisão adversária acrescentou** (6 lentes, 46 agentes; 40 achados,
20 refutados, 20 confirmados e consertados):

- **a foto nunca aparecia** — o banco guarda `/uploads/os/<uuid>.jpg`, caminho
  relativo à **API**, e a tela o escrevia cru no `src`: o navegador o resolvia
  contra a origem da SPA, que não serve aquilo. O recurso inteiro era
  invisível, e a suíte ficava verde porque nenhum teste lia o endereço. A
  galeria de produto já sabia disso (`coreApi.imageUrl`) desde a rodada 45;
- **a recusa apagava a OS da tela** — `erro` era o canal FATAL: subir a 21ª
  foto trocava a página inteira por "Ordem de serviço não encontrada — Esta OS
  já tem 20 fotos", levando junto peças, mão de obra, conferência e histórico.
  Agora `erro` é só "não consegui abrir a OS", e cada recusa aparece ao lado do
  que foi clicado;
- **falha ao ler as FOTOS zerava a conferência** — as duas leituras dividiam um
  `Promise.all` com um `catch` só. Checklist vazio virava "não há pendência", a
  tela liberava "Confirmar conclusão" e a pessoa ia direto ao 409. "Não sei"
  agora trava a conclusão e mostra o caminho de forçar;
- **o cadastro não fazia as perguntas que a ficha fazia** — o PATCH conferia
  montador e a venda conferia dono; o POST recebia os dois campos e gravava sem
  olhar. As chaves estrangeiras são globais: quem tem vínculo em duas empresas
  cadastrava a moto da oficina "montada" por gente da loja. E a leitura da
  ficha resolvia os nomes sem `company_id`, então dado torto antigo continuaria
  aparecendo;
- **o caixa da oficina virava montador** — a única pergunta era de empresa. "Montada
  por: PDV Oficina" é afirmação falsa sobre trabalho de bancada, no lugar onde
  ninguém a confere depois;
- **quem recebe a moto no balcão não podia fotografar** — o card das fotos
  nasceu com a régua das PEÇAS (mecânico e gerente), copiada por proximidade; a
  rota aceita os quatro perfis que atendem a OS. O atendente é justamente quem
  está lá na hora da entrada, que é a foto que mais importa;
- **garantia sem data-base** ficava possível com um backspace, e a ficha dizia
  as duas coisas ao mesmo tempo ("Sem garantia" e "12 meses · vence em —");
- **OS finalizada não recebia foto, mas perdia** — o DELETE não olhava o
  status, e a foto de entrada é a prova que resolve discussão depois;
- **o PATCH devolvia o `public_token`** da plaquinha, que as duas rotas irmãs
  projetam fora com todo cuidado;
- **o seletor de montador mentia** — a rota da equipe é de gestão e o mecânico
  leva 403 nela; o `catch` engolia e o campo abria em "Não informado" mesmo com
  montador gravado. Salvar a garantia apagaria quem montou;
- **cada resposta da conferência recarregava a tela** e jogava a pessoa ao topo
  — nove rolagens para nove itens, no celular da bancada;
- **"Adicionar foto" não existia para o teclado** (um `<label>` sobre input
  escondido), e a **foto ampliada não fechava** sem mouse;
- **"Cadastrar equipamento"** era oferecido a gerente de loja e estoquista, que
  levavam 403 com o formulário — agora quatro campos mais longo — preenchido;
- **a suíte sujava a pasta de produção**: o banco de teste é temporário, mas os
  arquivos iam para `server/data/uploads/os` e ficavam. Cada rodada deixava 21
  imagens órfãs. A pasta virou redirecionável (`DEVORA_UPLOADS_DIR`), como o
  banco já era.

Ficou registrado para depois: o pipeline de imagem enviada está **copiado em
três serviços** (produto, loja e OS) e as cópias já divergiram — o SVG só é
aceito numa delas. Unificar é tarefa própria, fora desta rodada.

Esquema 66 → **67** (garantia em meses, mecânico e data de montagem no
equipamento; `entered_at`, que era coluna morta, virou a data de entrada
informável, com backfill pelo `created_at`) mais duas tabelas novas
(conferência e fotos da OS). Sete rotas novas — contador 327 → **334**.
Verificado **na tela contra o banco real**: a lista trouxe a coluna Garantia,
a plaquinha `#0001` abriu a ficha da PJ Motors Sport 3000 com dono, venda,
OS #2 e as quatro marcas do histórico; "Completar ficha" gravou 6 meses e o
montador, e lista e ficha passaram a dizer o mesmo dia (12/02/2027); a
conferência de entrada nasceu com os 9 itens da bancada de mobilidade e o
contador andou ao responder. **Tudo o que a conferência escreveu saiu do banco
depois**: as duas OS de teste inteiras (ordem, 9 itens e evento cada) e a
ficha da máquina de volta ao que era. A foto subiu pela tela, apareceu na
miniatura, abriu ampliada, fechou com Escape e foi apagada pelo botão — banco
e disco conferidos vazios depois.
Servidor +32 testes, navegador +24 (a ficha e a conferência **nasceram sem
teste de tela** — os dois arquivos são desta rodada).

---

## O quadro da oficina ganha prioridade e SLA (rodada 51)

A primeira rodada do arco da oficina: a lógica de kanban do sistema anterior
(MotoElétrica Pro) portada para o nosso motor — **as regras, não o código**.
Lá tudo vivia em `localStorage` e mocks; aqui vive no banco, com escopo por
empresa e bancada, e o servidor impõe o que antes era boa vontade da tela.

**O que o quadro ganhou:**

- **prioridade** (urgente/alta/média/baixa, nascendo média): ordena os cards
  dentro da coluna — urgente em cima, e a OS mais antiga desempata;
- **prazo prometido** ao cliente, com badge que fala em dias e vira vermelho
  no atraso — é promessa de gente, não derivado do SLA;
- **a coluna "Parada no setor"**, que faltava, na ordem exata do quadro
  antigo: Aberto → Em andamento → Manutenção externa → Parada no setor →
  Aguardando peça;
- **o SLA**: a régua de reação por coluna × prioridade, com os **valores
  verbatim do sistema anterior** (4/8/16/24 em andamento; 24/48/72/96
  manutenção externa; 8/16/24/48 parada no setor; 48/72/96/120 aguardando
  peça). O card acende âmbar em 75% e vermelho em 100%. O gestor edita a
  régua na própria tela do quadro (1 a 720 horas), e **a régua é da EMPRESA**
  — no antigo ela morava no localStorage de cada navegador, e o quadro
  discordava de si mesmo entre máquinas;
- **observação obrigatória em TODO movimento** — o card só anda depois que
  alguém escreve o porquê, e a regra é do servidor (400), não da tela;
- **largar a OS**: o inverso do assumir, com justificativa obrigatória; a OS
  volta ao quadro sem responsável e o próximo técnico assume. O gerente larga
  OS de qualquer um (remanejamento).

**Dois defeitos do sistema antigo ficaram lá, de propósito:**

1. **o relógio que se curava sozinho** — lá o SLA contava do `updatedAt`, que
   reiniciava a cada comentário ou foto: bastava tocar na OS para o atraso
   sumir. Aqui existe `status_changed_at`, e só a MUDANÇA DE COLUNA reinicia o
   relógio (provado por teste dos dois lados);
2. **a régua por navegador** — virou configuração por empresa, no banco.

E duas travas novas que o antigo não tinha: a fila do caixa não se entra por
arrasto (só pela conclusão técnica, que confere custo e diagnóstico), e sair
dela é ação do gerente — o caixa pode estar com o cliente na frente.

**O que a revisão adversária da rodada acrescentou** (5 lentes, 34 agentes —
a maior desta série; achados confirmados consertados):

- **a coluna nova furava quatro regras** — este foi o defeito de família da
  rodada. Quatro lugares perguntavam "a OS está viva na bancada?" com a
  lista dos status escrita **por complemento**, e nenhum soube de
  `parada_setor`: a moto parada no setor **virava vendível** (a trava que
  impede vender moto desmontada não a conhecia), o dono perdia o botão de
  chamado no portal, o orçamento dela levava 409, e a tela da OS escondia
  peça/mão de obra/conclusão. Agora a pergunta tem **uma fonte só**
  (`ORDER_STATUSES_ON_BENCH`), e cada leitor importa a resposta;
- **a bancada virou fronteira também na escrita** — `resolveWorkshop(req,
  false)` devolve `null` para quem atende MAIS DE UMA bancada, e `null`, no
  serviço, é "sem filtro de oficina": o quadro escondia a OS da bancada
  alheia e a escrita passava. Assumir, mover, largar e replanejar agora usam
  o mesmo escopo em lista da leitura (provado com mecânico de duas bancadas
  levando 404 na terceira);
- **o prazo virou data de calendário** — `new Date` aceita "2026-02-31" e
  rola para 2 de março: prometer ao cliente uma data que ninguém combinou.
  Agora só AAAA-MM-DD válida passa;
- **o card parou de mentir à noite** — o chip do prazo comparava meia-noite
  UTC com a hora local, e das 21h em diante "hoje" virava "1d atraso";
- **o arrasto ganhou a régua do seletor** — soltar em "Finalizada" abria o
  bloco de observação, a pessoa escrevia o porquê e só então levava 409;
- **"Parada no setor" não vaza para o cliente**: no portal do dono e na
  plaquinha ele lê "Em serviço".

Esquema 65 → **66** (priority, due_date, status_changed_at + a tabela do SLA,
com **backfill** do relógio pelo `updated_at`: sem ele o quadro acordaria
inteiro estourado). Quatro rotas novas (largar, replanejar, ler e gravar a
régua) — contador 323 → 327. Verificado **na tela contra o banco real**: a OS
#1 da Oficina apareceu com chip "Média" e alerta `⏱ 116h/16h` (parada há
dias), o bloco de observação abriu sem mover o card, e a régua na tela trouxe
os números do antigo. Servidor +26 testes, navegador +14 (o kanban **nunca
tivera** teste de tela); 9 mordidas provadas.

---

## O e-mail prova dono (rodada 50)

O cadastro rápido por e-mail já existia (rodada 38) e o carteiro passou a
entregar (rodada 49). O que faltava era a PROVA — e ela veio com um dente.

**O buraco fechado**: o registro com co-prova (e-mail + documento no mesmo
cadastro) vinculava os pedidos NA HORA. Mas conhecer os dois dados não é
ser dono da caixa de entrada — o e-mail é público e o CPF é semi-público.
Com os dois de OUTRA pessoa, a conta nascia lendo o histórico de compras
dela: pedidos, endereços, equipamentos.

**Como funciona agora**:

- registrar envia um **código de 6 dígitos** (CSPRNG, SHA-256 no banco,
  1 hora de validade) — e o vínculo da co-prova ESPERA o código voltar;
- a tela "Minha conta" mostra o banner "Confirme seu e-mail" com o campo
  do código e o reenviar (teto de 3 códigos por hora; código errado conta
  no MESMO lockout do login; o reenvio CARREGA a co-prova pendente);
- `vincularPorDocumento` (puxar compras pelo CPF depois) exige e-mail
  verificado — a mesma regra na outra porta;
- o convite do balcão continua vinculando na hora (o papel é a prova) e o
  código sai mesmo assim; usar o link de **redefinição de senha** também
  verifica (o link foi para a caixa e voltou) e destrava a co-prova;
- o código nunca aparece no payload da fila — a tela do gestor vê que
  houve pedido, não o código (mesmo molde do link de reset).

Verificado de ponta a ponta NO NAVEGADOR contra o banco real: conta de
teste criada, banner na tela, código lido da fila do gestor (o caminho de
hoje, sem SMTP), digitado, banner some — e os artefatos removidos
integralmente do banco (0 órfãos, conferido).

Esquema 64 → **65** (`email_verified_at` + `core_customer_email_verifications`,
com o snapshot pré-migração de sempre — visto no banco real). Duas rotas
novas no portal (`verificar-email`, `reenviar-verificacao`).

**O que a revisão adversária da rodada acrescentou** (4 caçadores → céticos;
vários achados, os de segurança consertados, o resto documentado):

- **a "outra porta" fechada** — o login recalculava vínculos pelo ramo do
  E-MAIL, e o checkout de visitante sem CPF cria cadastros com e-mail e
  histórico real: quem registrasse com o e-mail de outra pessoa (sem conta
  no portal) herdava as compras dela no primeiro login. O ramo do e-mail em
  `syncLinks` agora exige e-mail PROVADO; o do documento (cliente de balcão)
  segue valendo sempre. A dona legítima recupera as compras de visitante
  depois de verificar;
- **força bruta do código encarecida** — o atacante é o dono da conta e roda
  de IP, então o teto por par (5/origem) não mordia e o de 50/15min sozinho
  deixava ~200 palpites/hora contra até 3 códigos válidos. Agora: só UM
  código válido por vez (o reenvio invalida o anterior) e um teto próprio e
  baixo POR CONTA (8);
- **colisão de dedupe** — dois códigos de 6 dígitos de contas diferentes
  podiam colidir e a UNIQUE global de `dedupe_key` faria o segundo e-mail
  não sair; o dedupe passou a incluir o `account_id`;
- **banner honesto** para a conta antiga (que loga sem código pendente): o
  texto não afirma mais "enviamos", e o botão "Enviar código" gera o
  primeiro;
- endurecimentos de teste: escopo do código por conta (código de uma não
  confirma outra), migração 65 num banco v64 real, os 8 helpers de portal
  deixaram de engolir código ausente em silêncio.

Documentado sem conserto: **sem SMTP, o código não chega** — logo, hoje o
cliente novo não verifica o e-mail sozinho e o cadastro rápido só fecha o
ciclo quando o Gmail entrar (rodada 49). É a mesma honestidade
READY_FOR_CREDENTIAL do resto; o preço da segurança é essa dependência.

Servidor +14 testes (`cadastro-por-email.test.ts`; 6 mordidas provadas),
navegador +3; oito arquivos de portal mudaram de contrato junto (o registro
deles agora prova a caixa, como o cliente faria).

---

## O carteiro existe (rodada 49)

A fila de e-mail estava pronta desde a rodada 38 — montagem no instante do
fato, dedupe, tela de gestão — e `flushEmailQueue` era um esboço honesto:
`sent: 0` sempre, nenhum transporte, nenhum UPDATE. O cliente confirmava a
conta, pagava, trocava a senha, e nada chegava na caixa de entrada.

**O que a rodada ligou:**

- **transporte SMTP real** (nodemailer, carregado sob demanda como o
  `imapflow` da caixa de entrada): o flush entrega pendente por pendente,
  marca `sent` com hora, conta tentativa em falha e guarda o motivo **sem a
  senha** (o `last_error` aparece na tela do gestor, e tela vaza em print —
  provado com um erro de AUTH que ecoa a credencial); na quinta falha o
  e-mail vira `failed` e o flush para de insistir no morto;
- **worker de fundo** no molde do `startSyncWorker`: só liga com credencial
  (`CARTEIRO_SAIDA_STARTED`/`IDLE` no boot — visto no boot real), roda já na
  subida e a cada minuto; sem credencial a fila acumula, que é o certo;
  *(molde revogado nas rodadas seguintes: o carteiro e o trabalhador da
  central sobem SEMPRE — `server/src/index.ts` —, e sem credencial cada
  batida devolve `READY_FOR_CREDENTIAL` sem tocar a rede, com a fila
  acumulando. O `if` só criava dependência de ordem: quem preenchia a
  credencial com a API no ar não ligava nada. GAP-PRD-139)*
- **dois avisos que nem enfileiravam**: `conta_criada` (nos DOIS caminhos —
  registro aberto e convite do balcão) e `senha_alterada` (nos DOIS — troca
  logada e redefinição pelo link). Nenhum corpo carrega senha, hash ou
  token; pedir a recuperação NÃO dispara "senha alterada", porque nada
  mudou ainda.

A regra de sempre continua: **não existe "fingir que mandou"** — sem
credencial nada é marcado como enviado; nos testes o carteiro é injetado
(dublado), nunca simulado por uma flag de produção.

**O que a revisão adversária da rodada acrescentou** (4 caçadores → céticos;
10 achados confirmados, todos tratados ou documentados):

- **um flush por vez, de verdade**: o worker de 60 s, um tick sobreposto
  (SMTP lento) e o clique do gerente viviam no mesmo processo e reliam os
  MESMOS pendentes durante o `await` do SMTP — o cliente receberia o aviso
  em dobro, inclusive o de "senha alterada". Quem chega durante um flush
  agora RECEBE o resultado do flush em voo (promessa compartilhada; provado
  com dois flushes sobrepostos entregando UMA vez);
- **`requireTLS` fora da porta 465**: o STARTTLS do nodemailer é oportunista
  — um servidor (ou um homem-no-meio) sem STARTTLS deixaria a senha de app
  sair em base64 reversível no fio. Downgrade agora é erro duro, nunca
  credencial em claro;
- **o nodemailer entrou na mira dos testes** (dublado no import): host,
  porta, secure, requireTLS, auth e o shape do sendMail deixaram de ter
  cobertura zero; o tick sobrevive a transporte que nem constrói; o worker
  entrega já na subida e para quando mandam parar;
- **fixtures endurecidas**: o aviso do convite é assinado pela empresa DO
  CONVITE (provado com duas empresas no banco — antes o fallback mascarava);
  e-mail sem domínio cria a conta SEM aviso e sem derrubar a transação.

Documentado sem conserto, de propósito: o botão "Processar fila" da tela
espera o envio real terminar (até 25 mensagens em série — segundos, não
milissegundos, com SMTP lento); o caminho normal é o worker, o botão é o
manual. E o envio duplicado entre PROCESSOS não existe porque o servidor é
um processo só — a mesma premissa do banco.

**A sua parte** (quando quiser ligar): um Gmail do grupo com **senha de
aplicativo** (myaccount.google.com › Segurança › Verificação em duas
etapas › Senhas de app) e as seis linhas `EMAIL_*` no `.env` — o bloco já
está lá esperando, com host e porta do Gmail preenchidos. `EMAIL_ENABLED=true`
+ remetente + usuário + senha de app, reinicie o servidor, e a fila anda
sozinha. O primeiro teste: crie uma conta no site com o SEU e-mail e veja o
aviso chegar.

Servidor +18 testes (`carteiro-existe.test.ts`; 5 mordidas provadas), 1
dependência nova (`nodemailer`). Sem rota nova, sem migração — a rota
`POST /core/emails/enviar` agora entrega de verdade.

---

## Cada adm preso à sua loja (rodada 48)

O dono relatou: "um adm da Conceito consegue acesso ao painel de qualquer
outra loja". A troca de empresa já era validada por vínculo no servidor
(`assertMembership`); o que atravessava era o PERFIL usado como procuração
do grupo. Quatro superfícies decidiam alcance por string
(`admin_geral`/`gestor`) e passaram a decidir por VÍNCULO:

- **`GET /core/companies`** devolve só as empresas dos próprios vínculos —
  o adm de uma loja não vê mais as operações e os CNPJs das outras cinco;
- **`POST /core/companies`** exige `respondePeloGrupo` — vínculo de gestão
  em TODAS as ativas, a mesma definição operacional que `listGroupAdminIds`
  já usava. Perfil certo com alcance de uma loja recebe 403
  (`CORE_GROUP_SCOPE_REQUIRED`);
- **a auditoria de sistema** atravessa empresa só com vínculo de gestão NA
  empresa pedida — e o gestor do grupo GANHOU a travessia que antes era só
  do `admin_geral`, porque o vínculo dele diz isso (decisão do dono);
- **`resolveIntegrationCompanyId`** — o mais grave dos quatro: certificado,
  chave Asaas e configuração fiscal de OUTRA empresa por `?companyId=` —
  agora exige vínculo de gestão na empresa alvo.

E o defeito do navegador que produzia o sintoma na tela: a troca de
operação guardava o token novo com o `profileCode` VELHO — menus e guardas
liam o perfil da empresa anterior. A troca agora adota o perfil do vínculo
de destino (caso em `activeScope.test.ts`; `menuPorPerfil.test.tsx` já
provava que o menu segue a sessão — o elo que faltava era este).

De quebra: a empresa nova de `POST /companies` passa a arrastar também os
GESTORES do grupo (antes, só os `admin_geral`). Sem isso, o CARLOSGERENTE
perdia o título de gestor do grupo no instante em que a sétima loja
nascesse — sem erro nenhum, só uma loja que ele não alcança (provado por
teste: o gestor continua abrindo a oitava depois da sétima).

**O que a revisão adversária da rodada acrescentou** (4 caçadores → cada
achado grave enfrentou um cético; 3 alegações caíram na contraprova):

- **o criador que é gestor do grupo entra na empresa nova como `gestor`** —
  gravado como `admin_geral` fixo (o código anterior), ele virava perfil
  misto, caía das duas listas de derivação e perdia o grupo em silêncio na
  criação seguinte; a cadeia oitava→nona→décima está medida em teste;
- **dois primos do mesmo vazamento fora do núcleo**, achados pela lente de
  segurança e confirmados: `PATCH /crm/opportunities/:id` escrevia em
  oportunidade de OUTRA empresa pelo `:id` adivinhável (`opp-<timestamp>`),
  e `GET /logistics/quotes/:quoteId` lia cotação alheia (CEPs, valor
  declarado) pelo mesmo padrão. O escopo da sessão entrou no predicado dos
  dois; empresa errada responde igual a id inexistente;
- três endurecimentos de teste: a escrita de integrações cross-company
  provada pela ROTA (chave Asaas alheia não nasce, cofre conferido), a
  travessia de auditoria conferindo DE QUEM é o que volta, e a troca com
  perfis DIFERENTES por empresa (gestor lá, gerente cá).

Dois achados ficaram documentados sem conserto, de propósito: o menu
"Empresas do grupo" é filtrado por PERFIL no navegador (um `admin_geral` de
loja única veria a tela — mas esse usuário não existe em nenhum estado que o
produto produz: a tela de Equipe não entrega `admin_geral`, e quem cria
empresa hoje responde pelo grupo); e a troca de empresa não revoga o refresh
token anterior (as duas sessões são do MESMO usuário em empresas onde ele
tem vínculo — mesmo acesso de dois logins; a troca de senha revoga todas,
como sempre).

ADMIN (`admin_geral` nas 6) e CARLOSGERENTE (`gestor` nas 6) continuam
enxergando tudo — o vínculo deles já diz isso. Servidor +17 testes
(`adm-preso-a-sua-loja.test.ts`), navegador +1; dois arquivos mudaram de
contrato junto (`empresa-nasce-inteira`, `prompt15-integrations`). Sem rota
nova, sem migração.

**A sua parte — criar o gerente de cada loja**: entre como ADMIN ou
CARLOSGERENTE, troque para a loja no seletor do topo, abra **Usuários e
equipe** no menu e crie o usuário com perfil **Gerente de loja** (na
Oficina, **Gerente de oficina**). O vínculo nasce só naquela loja: esse
gerente não troca para as outras, não lista o grupo, não alcança auditoria
nem integrações alheias — e o servidor é quem garante, não a tela.

---

## Cópia remota do banco — Supabase (rodada 47)

A rodada 35 deu o backup diário automático, mas a cópia continuou no MESMO
computador — o log avisa isso a cada boot desde então. Agora o diário sobe
a cópia para um bucket do **Supabase Storage** (upsert: o diário do dia
substitui, não acumula), em MELHOR ESFORÇO: falha remota nunca derruba o
backup local (provado quebrando de propósito), e a CHAVE não aparece em
motivo de falha nem em log (provado vasculhando o texto). Sem configuração,
o diário passa a AVISAR todo dia — silêncio seria o dono achando que tem
cópia remota quando não tem (visto no boot real).

**A parte do dono** (a mesma divisão do Asaas — a chave nunca no chat):
criar o projeto no Supabase, criar um bucket privado chamado `backups`, e
pôr no ambiente do servidor: `DEVORA_SUPABASE_URL` (a URL do projeto),
`DEVORA_SUPABASE_SERVICE_KEY` (a service role key, em Settings › API) e,
se o bucket tiver outro nome, `DEVORA_SUPABASE_BUCKET`.

Servidor +6 testes (1 arquivo). Sem rota nova, sem migração.

---
## O adapter SEFAZ real (rodada 46)

**O simulador saiu do slot real.** A auditoria mediu (rodada 36) que o
"adapter real" de `fiscalAdapter()` era o provider de teste — preencher
endereços não transmitia nada. Agora existe o `SefazRealAdapter`: cliente
SOAP 1.2 com TLS mútuo pelo A1 do cofre, cobrindo TODOS os serviços —
status, autorização síncrona (indSinc=1, declaração `<?xml?>` do documento
removida do envelope, provado por mordida), consulta por chave,
cancelamento e carta de correção (eventos ASSINADOS via `signXmlElement`,
o motor do XMLDSig generalizado para `infEvento`/`infInut`), inutilização
com o Id do layout, e os dois serviços do Ambiente Nacional que a rodada 44
deixou em 501: **Distribuição DF-e** (docZip gzip+base64 descomprimido de
verdade, com `maxOutputLength` contra bomba) e **manifestação do
destinatário** (órgão 91).

As regras que os testes travam (21, transporte dublado): a decisão é SEMPRE
pelo cStat, nunca pelo HTTP; falha de transporte lança `TransportFailure` —
a MESMA classe que a fila reconhece por `instanceof` para consultar a chave
antes de reenviar; e a resposta de EVENTO é lida do bloco `infEvento` — o
cStat 128 do lote não vence o desfecho (provado por mordida: sem o recorte,
três casos ficam vermelhos). Endereços: RS homologação E produção (NF-e nos
hosts nfe*.sefazrs, NFC-e nos nfce*, e a fila agora passa o MODELO para o
host certo); UF fora da tabela é 501 explicado.

**A ligação**: com `certificatePassword` no corpo, o slot real É o cliente
SOAP (a fábrica abre o A1 do cofre por requisição — a senha nunca fica
guardada); sem senha, fora de produção, o simulador segue sendo o caminho
de dev (nada regrediu para as telas); em produção sem senha, o erro diz o
que falta. A EMISSÃO ganhou transmissão real INTERATIVA: a mesma senha que
assina também transmite, na mesma requisição — worker de fundo não existe
de propósito, porque ato fiscal real tem alguém presente. O slot é
PREGUIÇOSO: com developmentMode, o real nem é construído (senha errada no
corpo não derruba o fluxo de teste — provado).

**Revisão desta rodada**: a revisão multi-agente caiu três vezes seguidas
por indisponibilidade da API (529) e NÃO rodou — fica o registro honesto,
com o script salvo para re-rodar. No lugar, uma passada crítica manual
sobre as mesmas suspeitas achou e corrigiu 3 defeitos com teste: o slot
real avaliado ansiosamente, a resposta HTTP sem teto (10 MB agora) e o
gunzip sem `maxOutputLength`.

**O que falta para a primeira nota de verdade** (parte do dono, guiada pela
página "Até a primeira nota"): certificado A1 real no cofre, cadastro
fiscal por empresa, série/CSC, e a homologação — os bytes na SEFAZ são o
juiz final dos envelopes e das URLs (padrão SVRS publicado).

Rotas: 323 (nenhuma nova — a senha viaja nos corpos existentes). Esquema
64. Servidor +22 testes (1 arquivo).

---
## Fotos em lote e conformidade (rodada 45)

**Fotos em lote** — o dono fotografa tudo de uma vez e nomeia cada arquivo
com o código de barras ou o código interno (`7891234567895.jpg`). A tela
nova (E-commerce › Fotos em lote) resolve os nomes NO SERVIDOR antes de
subir qualquer byte (`POST /products/fotos-em-lote/resolver`, até 500 por
lote, corte por empresa provado por teste), mostra o casamento — casado,
sem produto, já-tem-foto — e sobe foto a foto pela rota que sempre existiu
(um único escritor de imagem). A mesma tela lista **o que falta
fotografar** (publicados sem foto, da prontidão online), e a Administração
da loja ganhou o aviso com atalho. Verificado contra o banco real: a Gringa
tem 2 publicados sem foto e a tela os nomeia com o código para o arquivo.
**As fotos em si são a parte do dono** — a ferramenta está pronta.

**Conformidade (LGPD/CDC/Decreto 7.962)** — nada disso existia: zero
páginas, zero colunas, zero menções. Agora: três páginas públicas com texto
de gente (Política de Privacidade; Termos de Uso; Trocas e Devoluções com o
arrependimento de 7 dias do art. 49 e os prazos do art. 26), rodapé com os
links e a **identificação legal do fornecedor** — razão social, CNPJ e
endereço via `GET /loja/identificacao`, que copia campo a campo do cadastro
fiscal e NUNCA vaza IE/IM/CRT/ambiente (provado por teste que vasculha o
JSON); na página de uma marca o rodapé identifica a empresa DAQUELA loja. O
cadastro do portal passou a EXIGIR o aceite (`PORTAL_TERMS_REQUIRED`; só o
booleano true — string, 1 e objeto são recusados) e grava
`accepted_terms_at` (migração 64) no nascimento da conta; conta antiga fica
NULL, aceite não se inventa retroativamente. Checkbox obrigatório na tela
de cadastro; o checkout avisa o contrato de adesão com links antes do
botão. Preencher o cadastro fiscal de cada empresa (CNPJ/endereço) continua
sendo parte do dono — o rodapé mostra sozinho quando existir.

**A revisão adversarial mordeu de novo antes do commit** — 9 agentes, 6
achados confirmados (0 refutados), todos corrigidos com teste: a caixa
EXATA decide o casamento quando dois códigos internos diferem só na caixa
(o NOCASE sozinho vestia a foto no produto errado, em silêncio); reenviar o
lote pulava a duplicação — o segundo clique agora é retry SÓ das pendentes,
e o botão desarma zerado; a tela e o menu ganharam o mesmo guarda de perfil
do servidor (atendente não vê o que responderia 403); erro ao medir a
prontidão deixou de aparecer como "tudo fotografado"; e a página legal
disparava DUAS buscas de identificação — a promessa em voo agora é
compartilhada.

Rotas do núcleo: 323 (+1; a identificação é pública e mora no storefront).
Esquema 64. Servidor +15 testes (2 arquivos); navegador +10.

---
## Notas do fornecedor (rodada 44)

**A conferência volta para a tela** — a auditoria mediu três mentiras:
`received_quantity` era gravado e NUNCA devolvido (a coluna "Diferença"
mostrava "—" para sempre e reabrir a nota apagava, na tela, a contagem
recém-feita); `divergence_note` era coluna morta dos dois lados; e
`matchedBy` era FABRICADO na leitura — "código de barras" para todo item
vinculado, mesmo casado por código interno, descrição ou mão. Agora: a
leitura devolve os três; o motivo da divergência tem campo na tela (avaria,
falta) e viaja preservado quando só a quantidade muda; o método de
casamento é GRAVADO (`matched_by`, migração 63 — `manual` para vínculo
humano; item antigo fica NULL, não se inventa história retroativa) e a tela
mostra "por código interno" em vez de mentir. Provado por sabotagem: voltar
o map fabricado deixa três casos vermelhos.

**Distribuição DF-e + manifestação do destinatário** — a fonte OFICIAL: a
SEFAZ entrega o que foi emitido contra o CNPJ do grupo, antes de o caminhão
chegar. Consulta por NSU com cursor em MAX(nsu) e UNIQUE (empresa, NSU) —
reconsultar devolve 0 novos sem duplicar. Manifestação nos quatro eventos
(ciência 210210, confirmação 210200, desconhecimento 210220, não realizada
210240 — esta exige justificativa de 15+ caracteres, como a SEFAZ): pedido
e desfecho em `core_fiscal_events` append-only, estado SÓ muda com
protocolo aceito (provado: rejeição simulada não grava nada), definitivas
não voltam atrás pelo botão. **Ciência libera o download**: aceita, o
serviço baixa o procNFe na mesma conversa e só ELE entra no funil de
conferência — resumo não tem item. Card "Notas contra o seu CNPJ (SEFAZ)"
na Entrada de Notas; manifestar é só gerência (estoquista vê o estado).
HONESTIDADE: o adapter de hoje é o simulador — o SOAP real
(NFeDistribuicaoDFe/RecepcaoEvento4, Ambiente Nacional) é a rodada 46, e o
método ausente responde 501, o mesmo contrato que a CC-e usou. Verificado
na tela contra o banco real pelo caminho do guarda: empresa sem CNPJ fiscal
recebe a recusa explicada, sem gravar nada.

**CT-e** — o documento do transporte (modelo 57) não existia: o parser
recusava tudo que não fosse NF-e e o frete ficava órfão. Agora: parser
próprio (`infCte`; NF-e aqui é recusa clara), `core_cte_documents` com
UNIQUE por chave, e o vínculo com as NF-e transportadas é DERIVADO — o CT-e
guarda as chaves referenciadas e o join resolve na leitura ("1 de 2 no
funil"). Entra por upload no card "Fretes (CT-e)" e pelo E-MAIL: anexo que
não é NF-e tenta CT-e antes de ser declarado inválido.

**A revisão adversarial mordeu antes do commit** — 15 agentes (3 dimensões +
cético por achado) sobre o diff: 7 defeitos confirmados e corrigidos com
teste, 3 refutados na contraprova. Os que valeram a rodada: a validação do
tipo de manifestação aceitava chave herdada do prototype ('toString'
gravaria estado fiscal lixo com protocolo aceito); o rastro fiscal não dizia
QUAL nota foi manifestada (pedido e rejeição órfãos — a chNFe agora vai no
campo do XML do evento); CT-e duplicado por e-mail contava como novidade e
e-mail só de frete anunciava "nota em conferência" que não existe (situação
própria 'frete'); anexo de e-mail sem teto de tamanho (2 MB por arquivo); e
a key da tabela de conferência reaproveitava input não-controlado entre
notas do mesmo produto — a contagem digitada numa nota aparecia e ERA
GRAVADA na outra (o conserto do teste revelou um segundo defeito da mesma
família: a tabela velha renderizava sob o noteId novo; trocar de nota agora
limpa a conferência até os itens chegarem). Auditoria dupla da manifestação
virou uma linha só.

Rotas do núcleo: 322 (+6). Esquema 63. Servidor +27 testes (3 arquivos);
navegador +10.

---
## PJ Motors e a oficina (rodada 43)

**Orçamento com aprovação do cliente** — `approved_at` nasceu na DDL e ficou
morta por 42 rodadas: zero leitores, zero escritores; o "aprovou" acontecia
por telefone, sem registro. O desenho é de **dois tempos**: a oficina PEDE
(`POST /core/workshop/orders/:id/pedir-aprovacao`, coluna nova
`approval_requested_at` na migração 61 — exige OS viva e valor na conta) e o
CLIENTE decide **no portal dele** (`POST /loja/portal/ordens/:id/aprovar` ou
`recusar`, com posse conferida por `customer_id` da sessão: quem não é dono
recebe 404 e nem descobre que a OS existe — provado quebrando o corte de
posse, o teste do intruso fica vermelho). Recusa limpa o pedido; pedir de
novo **apaga a aprovação anterior** (o "sim" antigo valia para outro valor).
A decisão entra na linha do tempo da OS como fala do **proprietário**, e a
tela da oficina mostra o selo — aguardando ou aprovado, com data.

**Migração 62, nascida da verificação em tela**: a OS #1 real apareceu com
"orçamento aprovado pelo cliente" sem cliente algum ter aprovado. Um fluxo
removido em 12/08 gravava `approved_at` como "aprovada para execução" — outro
significado. O passo 62 zera o resquício (nenhum valor anterior à rodada foi
escrito pelo portal); provado por teste que planta o lixo e reaplica o passo.

**Fechar e cobrar a OS pela tela** — as cinco rotas órfãs da auditoria
(`labor`, `complete`, `comments`, `pending-payment`, `checkout`) ganharam a
tela no card **"Serviço e conta"** da OS: mão de obra em reais (vira centavos
no envio — provado sabotando a conversão), conclusão técnica **só de quem
assumiu** (com cobrança → caixa; sem custo → motivo obrigatório: garantia,
cortesia autorizada ou retrabalho), e o **recebimento pelo caixa da oficina**
(dinheiro/PIX/débito/crédito), que cria a venda e finaliza a OS — idempotente
pela chave `os-<id>`. Caixa de comentário no fio da história; a fala vinda do
portal aparece rotulada "Fala do cliente". O card some quando não tem nada a
oferecer (visto vazio na OS #2 finalizada, corrigido).

**Ano de fabricação e os campos sem tela** — `core_equipment.year` (migração
61; 1950 até ano seguinte, resto é 400) e o formulário ganhou Ano, Versão,
Número do motor, Bateria e Série da bateria — existiam no serviço desde o
início e morriam no caminho.

**O elo do QR** — o botão da plaquinha pública agora leva a
`/minha-conta/equipamentos?equipamento=#0001`, e a ficha daquele aparelho
**abre sozinha** ao entrar. Verificado na tela contra o equipamento real
#0001 (e no celular).

Rotas do núcleo: 316. Navegador: +16 testes (fechamento da OS e aprovação no
portal, com rede dublada que mexe no estado).

---
## Cartão, conferência de valor e devolução (rodada 42)

**Cartão de crédito na loja** — com a decisão combinada: **sem salvar cartão**.
A arquitetura entrega mais do que isso: o número **nunca passa pelo ERP**. A
cobrança nasce como `CREDIT_CARD` no provedor e o cliente digita o cartão na
página do provedor (`invoiceUrl`) — recusa, retry e antifraude são de lá; aqui
não existe campo de cartão para salvar, vazar ou entrar em escopo PCI. O
checkout oferece PIX, Boleto e Cartão; mostrar o link **não é receber** — o
pedido segue aguardando até o webhook.

**Conferência de valor no webhook** — a auditoria mediu: ninguém comparava o
valor pago com o do pedido, então um webhook legítimo de R$ 1,00 marcava pago
um pedido de R$ 200,00 (bastava criar uma cobrança avulsa na mesma conta).
Agora o valor do evento é conferido; **divergiu, não vira pago**: a intenção é
marcada `amount_mismatch` e o fato fica na linha do tempo do pedido, esperando
quem controla o caixa. Evento sem campo de valor segue o caminho antigo — não
se inventa divergência por formato de payload. Provado quebrando a comparação:
o caso fica vermelho.

**Devolução de pedido pago** — não existia caminho nenhum: nem estorno, nem
estoque de volta. Agora `POST /core/orders/:id/devolver` (só gerência): estorno
solicitado ao provedor (**melhor esforço** — falha não trava a devolução, fica
registrada para regularizar), estoque de volta pelo razão (**idempotente**:
devolver duas vezes não dobra o saldo — provado), pedido `reembolsado`. Antes
do pagamento o caminho continua sendo cancelar. Botão "Devolver" na tela de
pedidos, com confirmação que mostra número e valor.

Rotas do núcleo: 315. Verificado na tela: as três formas no checkout, o aviso
do cartão ao selecioná-lo, e o botão mudando para "Finalizar pedido (Cartão)".

---

## A home do Grupo (rodada 41)

A entrada da loja virou um **portal**, e tudo o que ele mostra vem do que o
gestor já controla — a home só reflete, sem lista própria para divergir:

- **Nossas lojas**: as cinco lojas viraram **cartões** com capa, logo e chamada
  (do painel de identidade da rodada 40). Sem capa, o cartão fica tipográfico —
  nada de buraco cinza. O clique navega para a página da marca.
- **Ofertas**: seção nova com o que está **em promoção vigente** entre as
  lojas, preço riscado ao lado do valor com desconto. Alimentada pela tela de
  promoções; promoção vencida ou futura **não entra** (provado por teste). Sem
  oferta, a seção nem aparece. Verificada na tela com a promoção real da
  Jaqueta Corta-Vento (R$ 329,00 → R$ 246,75).
- **Destaques** (rodada 39) continua no topo.

Servidor: `GET /loja/ofertas` e a opção `onlyOnSale` em
`listStorefrontProducts` — o filtro roda depois do `decorate`, porque promoção
é calculada com vigência, não coluna. Conferido no celular: cartões empilham em
coluna única.

---

## A cara de cada marca (rodada 40)

Cada loja ganhou **endereço próprio** — `/preco-justo`, `/me-mimei`,
`/conceito`, `/pj-motors`, `/gringa` — com a identidade da marca. Como as
páginas da loja já consumiam só tokens (zero cor literal, medido na rodada 36),
a identidade é um **escopo de token** (`data-marca="slug"` na casca), não
reescrita de tela: paleta inteira troca, nenhum componente muda.

As paletas saem dos logos que o dono enviou, com o combinado:

| Marca | Paleta |
| --- | --- |
| Preço Justo | preto do círculo + verde do cifrão + branco |
| Me Mimei | preto + rosa neon do letreiro |
| Conceito | preto e branco, monocromático |
| PJ Motors | grafite + prata + verde elétrico |
| Gringa | **provisória** (azul-marinho neutro) até o dono mandar o logo |

Na página da marca: o cabeçalho é a loja (logo ou nome), com "Grupo Sampaio"
discreto ao lado voltando ao grupo; o herói mostra capa, chamada e faixa; e a
vitrine, os destaques e os departamentos ficam travados naquela loja. A página
do produto **herda** a marca da loja dona. Slug desconhecido diz "esta loja
não existe" com caminho de volta. Na home do grupo, as lojas viraram **links**
que navegam — e a linha "Serviços e assistência: Oficina" saiu da vitrine
(decisão do dono: Oficina é só sistema).

**O que o gestor controla pelo painel** (`/sistema/loja/administracao`, seção
"Identidade da marca"): o **logo** e a **capa** — imagem sobe em base64, vai
para `data/uploads/lojas`, o banco guarda a URL, trocar substitui e apaga o
arquivo antigo (provado por teste). A **paleta é código** aprovado pelo dono,
de propósito: cor da marca não é campo livre.

Migração 60: `logo_url` e `cover_url` em `core_storefront_settings`. Aplicada
no banco real (versão conferida: 60).

---

## Vitrine robusta (rodada 39)

Quatro defeitos medidos pela auditoria, e o conserto de cada um provado
quebrando-o de propósito:

- **O "Destacar" do gestor passou a valer.** O campo era gravado e a vitrine
  nunca o lia. Agora a ordenação padrão põe destaque primeiro, há a faixa
  **"Destaques"** no topo da vitrine (rolagem horizontal, só na primeira página
  e sem busca ativa), e `GET /loja/destaques` serve o carrossel. Verificado
  ponta a ponta na tela: marcado pelo botão do gestor, apareceu na vitrine,
  desmarcado ao final — o banco voltou ao estado original.
- **Grade num card só.** Um produto-modelo com P/M/G virava quatro cards e o
  do modelo dizia "Indisponível" (o estoque mora nas variantes). A vitrine
  agora lista só modelos e produtos soltos; o card agrega o disponível (soma
  das variantes), mostra **"a partir de"** o menor preço, e o botão vira
  "Escolher" — grade não entra direto no carrinho, porque falta o tamanho.
- **Busca sem acento.** "acucar" não achava "Açúcar". A busca saiu do LIKE do
  SQL e roda em memória com dobra de acento (NFD), onde preço e ordenação já
  rodavam. "eletrico" acha "Elétrico" — provado no servidor real.
- **Paginação com total.** A vitrine cortava em 60 sem próxima página. Agora
  `{ items, total }` com `limit`/`offset`; a tela pagina de 12 em 12 com
  "1–12 de N" e some com a navegação quando não precisa.

E mais dois que estavam juntos: **departamentos** — o endpoint
`GET /loja/categories` existia e nenhuma tela o chamava; virou a barra de
categorias da vitrine — e **estados separados**: "carregando", "erro com
tentar de novo" e "nada encontrado com esses filtros" deixaram de ser a mesma
tela de "nenhum produto publicado".

---

## Conta do cliente completa (rodada 38)

O cadastro EXIGIA uma compra anterior — e-mail e documento no mesmo cadastro —
e o banco tinha **0 contas e 1 cliente elegível**: o portal nascia quase
inacessível. Esta rodada abre o cadastro **sem afrouxar a segurança** que
impede uma conta de adotar os pedidos de outra pessoa.

**Cadastro aberto.** Criar a conta pede só e-mail e senha. O documento virou
opcional. O que NÃO mudou é a regra que puxa os pedidos de alguém: `syncLinks`
só roda com a **co-prova** — um cadastro com ESTE e-mail E ESTE documento
juntos. Saber só o CPF (semi-público) não basta. Provado quebrando de
propósito: trocar a co-prova pelo furo clássico `email = ? OR document = ?`
deixa os dois casos ANTI-ROUBO vermelhos.

**Vincular depois (claim).** Quem criou a conta aberta e depois quer trazer os
pedidos informa o documento — mesma co-prova. `POST /portal/vincular`.

**Recuperar senha.** Não existia: esquecer a senha era perder a conta.
`POST /portal/recuperar-senha` gera um token de uso único e uma hora, guarda só
o SHA-256, e **enfileira o e-mail** com o link. A entrega fica
`READY_FOR_CREDENTIAL` até haver SMTP — o mesmo padrão honesto do fiscal e do
Asaas. O token vai só no corpo do e-mail, nunca no `payload` que o gestor lê na
tela da fila: um link de recuperação é credencial, e a tela do gestor não pode
virar um sequestro. `POST /portal/redefinir-senha` valida, troca a senha e
**derruba todas as sessões** — se a senha vazou, as sessões antigas não podem
continuar. Nunca revela se o e-mail existe (sem enumeração).

**Dados cadastrais editáveis.** Nome e telefone, na conta, refletindo em todos
os cadastros vinculados (a mesma pessoa em cada loja). O e-mail é o login e não
muda por aqui.

**Sair dos outros dispositivos.** `POST /portal/sair-outros` — para quem entrou
num computador público e esqueceu de sair, sem precisar trocar a senha. A
sessão atual continua.

Verificado na tela sem escrever no banco operacional (0 contas antes e depois):
o campo de CPF virou opcional; a recuperação de e-mail inexistente responde 200
sem vazar token e sem gravar; a tela de redefinir recusa token inválido com
frase clara.

Tabela nova: `core_customer_password_resets` (guarda o hash do token). Sem
migração — entra pela DDL canônica.

---

## A casca da loja — a porta que faltava (rodada 37)

O portal do cliente existia inteiro — pedidos com status e prazo, endereços,
troca de senha, "Meus equipamentos" com histórico e abertura de chamado — e
**não tinha uma única porta**. Busca por `minha-conta` em `src/`: 8 ocorrências,
todas de dentro do próprio portal. O cabeçalho da loja tinha dois elementos: a
marca e o "Carrinho". A página do produto dizia *"Entre na sua conta para
avaliar"* num `<p>` que não era link. Quem não soubesse digitar a URL não
chegava.

**Uma casca única, `CascaDaLoja`,** passou a servir LojaPage, ProdutoLojaPage,
MinhaContaPage e MeusEquipamentosPage — que antes redeclaravam cada uma a
própria `Moldura`. O cabeçalho sempre oferece a conta:

- deslogado, **"Entre ou cadastre-se"** → `/minha-conta`;
- logado, **"Olá, {e-mail}"** com botão de sair.

A troca acontece **na hora do login, sem recarregar** — a casca ouve um evento
(`PORTAL_EVENT`) que a gravação da sessão dispara. Verificado na tela: injetada
a sessão, o cabeçalho vira "Olá" e o "Entre" some, sem reload.

**A sessão do portal num lugar só.** `src/lib/portalSession.ts` reúne a chave
`gs.portal`, a leitura com conferência de validade, o `comTokenPortal` e o
`guardarSessaoPortal`. Três arquivos tinham cópias da mesma regra — três
lugares para uma divergir. Agora importam do módulo.

**Os becos viraram caminho**, cada um verificado:

- a frase da avaliação — o "Entre na sua conta" agora é `<Link>` para
  `/minha-conta`;
- **a página que o QR da plaquinha abre** ganhou o botão **"Entrar na minha
  conta"** → `/minha-conta/equipamentos`, que é onde o dono da moto abre
  chamado. Confere o fluxo inteiro que o dono pediu: QR na moto → conta →
  chamado → kanban da oficina;
- o hub da conta ganhou **"Meus equipamentos e chamados da oficina"** —
  a tela `MeusEquipamentosPage` era órfã absoluta, sem nenhum link em todo o
  `src/`;
- pós-checkout, **"Acompanhe seus pedidos na sua conta"** — quem fechava a aba
  depois de pagar perdia o PIX sem caminho de volta.

O rodapé passou a nomear as cinco lojas (Preço Justo, Gringa, Me Mimei,
Conceito, PJ Motors) — **a Oficina não entra na vitrine**, decisão do dono; a
assistência da moto vive no portal. Conferido no celular: o cabeçalho quebra em
duas linhas e continua legível.

---

## Limpar o terreno (rodada 36)

A auditoria mediu **dois sistemas de tabela** convivendo: 101 relacionais
(`core_*`, com dado) e 213 do repositório-documento JSON antigo, das quais
**138 sem nenhum uso**. E rotas: 606 registradas, ~275 que nenhuma tela chama.
A rodada 36 tirou o que não tinha chamador **nem** linha, em três frentes
paralelas (worktrees isoladas), com cada agente conferindo zero-chamador e
zero-linha antes de apagar.

**Saiu:**

- **A loja fantasma** (`routes/v1/storefronts.ts`, plural): 22 rotas, um
  segundo e-commerce que grava em documentos JSON. Ficou o que ainda tem
  leitor vivo — `services/ecommerce/` é consumido pelo painel de integrações
  e pela prontidão de homologação —, mas 15 das 23 tabelas `ecommerce_*` e 4
  funções órfãs (`createCart`, `createOrder`, `markOrderPaid`,
  `getStorefrontBySlug`, homônimas das vivas) saíram.
- **O segundo motor de promoções** (`routes/v1/promotions.ts` + 9 tabelas
  `promotion*`): 12 rotas que nunca precificaram nada. Quem desconta é
  `core_promotions`, via `/core/promotions`, e continua.
- **OMS, oficina e locação LEGADOS** (`routes/v1/{oms,workshop,rentals}.ts` +
  57 tabelas): 25 rotas sobre JSON vazio. Os homônimos do núcleo — o
  fulfillment, as 20 rotas `/core/workshop*`, a locação em `core.ts` — não
  foram tocados. Dois módulos com o mesmo nome, um vazio, era a pior
  documentação que existia.
- **O lixo do projeto anterior** ("MotoElétrica Pro"): o `canonical` que
  mandava o Google tratar o site como cópia de outro domínio, as metas
  `og:/twitter:/keywords` da marca errada, **três folhas externas** (Font
  Awesome, RemixIcon, Pacifico) baixadas em toda visita e usadas em lugar
  nenhum, os dois relatórios de auditoria antigos servidos em `public/`, e o
  rodapé de impressão. O `favicon` apontava para um `/vite.svg` que **não
  existia** (404 a cada visita) — agora há um provisório. `system:
  "MotoElétrica Pro"` na função Supabase de health também caiu.

**Cinco defeitos removidos no total: loja fantasma, promoções mortas, OMS,
workshop legado, rentals** — 19 roteadores viraram 14. Os módulos de permissão
`ecommerce`, `promotion`, `oms`, `workshop`, `rentals` saíram da matriz (nenhuma
rota viva os pedia; a matriz falha fechada, então prometer alcance que ninguém
confere é dívida). `robots.txt` e `sitemap` do projeto antigo deram lugar a um
`robots.txt` honesto (painel `Disallow`, loja `Allow`). `data/uploads/` e
`.claude/worktrees/` entraram no `.gitignore`.

**A conferência na tela:** `/loja` responde 200 com 5 produtos; as cinco rotas
apagadas respondem 404; a suíte inteira verde.

### O que ficou "com servidor e sem tela" — a sua decisão

Não apaguei, porque a escolha entre **construir a tela** ou **remover** é sua,
não minha. Cada um destes tem rotas no servidor e nenhuma tela do frontend as
chama (o número de linhas é do banco real):

| Módulo | Rotas | Tabelas · linhas | O que seria a tela |
| --- | --- | --- | --- |
| CRM (roteador `/crm`) | 17 | 12 · 0 | O CRM que a empresa usa hoje é o de `core.ts` (leads, oportunidades, fidelidade), com tela. Este `/crm` é um segundo, vazio. |
| BI (`/bi`) | 22 | 0 · 0 | Idem: a tela de BI usa `coreApi.insights*`. O `/bi` é paralelo. |
| Automações (`/automations`) | 15 | 14 · 0 | O único item de menu "em breve". Nunca teve tela. |
| Maquininha/TEF (`/payment-terminals`) | 29 | 14 · **3** | Tem 3 linhas de dado. Precisa de hardware (PinPad) para valer — é `READY_FOR_HARDWARE`. |
| Admin do sistema (`/system`) | 13 | 4 · 0 | Homologação/prontidão de release. |
| Integrações (`/integrations`) | 8 | 3 · **1** | Alimenta o painel de integrações (Asaas, e-commerce, logística). Tem uso vivo — provavelmente FICA. |
| NF-e emissão legada (`/fiscal/nfe`) | 24 | 16 · 0 | Emissão modelo 55 antiga. A emissão de verdade será o adapter SEFAZ da rodada 46. |

Minha recomendação, quando você quiser decidir: **CRM/`/crm`, `/bi` e
`/automations`** são candidatos a remover (paralelos vazios dos que têm tela);
**`/payment-terminals`** espera hardware; **`/integrations`** fica. Mas nada
disso é urgente — não custa dinheiro nem trava a loja.

---

## O que a varredura da rodada 28 encontrou

A última rodada autônoma procurou um tipo específico de dívida: **coisa que
existe e não alcança nada, e coisa que diz o que não faz**. As duas custam o
mesmo — quem lê acredita.

### Consertado nesta rodada

**O mesmo produto em duas linhas sumia, em dois lugares.** `applyMovement` é
idempotente por (empresa, referência, id da referência, produto, tipo), e essa
chave é UNIQUE no banco. Onde o código aplicava um movimento POR LINHA usando
uma referência única por documento, a segunda linha do mesmo produto voltava
como repetida e a quantidade dela era descartada — sem erro e sem aviso.

- **Entrada de NF-e.** Nota com a mesma peça em dois `<det>` (dois lotes, dois
  preços) entrava com 4 no lugar de 10. E havia a face barulhenta: quando o
  produto ainda não existia, a segunda linha tentava cadastrar o mesmo código de
  barras e a nota INTEIRA era recusada com "este código de barras já pertence a
  outro produto" — mensagem que não diz nada a quem está na doca.
- **Devolução de venda, e aqui sai DINHEIRO.** O total é calculado sobre as duas
  linhas e devolvido ao cliente; só o estoque ficava com uma. Medido: voltavam 8
  de 10, com o cliente pago pelos 10.

Os dois agora somam por produto antes de mover o saldo, que é o mesmo desenho
que a importação de planilha já usava.

**Um teste de segurança que não conseguia falhar.** O caso `cross-tenant
requireCompanyScope 403` afirmava `expect([200, 403]).toContain(res.status)`:
passava com o vazamento aberto E com ele fechado. Medido, a rota devolve 403 —
agora é isso que o teste cobra.

**O rascunho de importação de outro arquivo ficava preso.** Reenviar substitui o
rascunho só do arquivo IDÊNTICO; quem corrige a planilha e sobe a versão nova
deixava o velho em conferência para sempre, sem ação na tela. A rota de descarte
já existia — faltava o botão.

### Dívida medida — o que a rodada 32 pagou, e o que ficou

Está aqui porque medida e escrita é dívida; medida e calada é armadilha. A
rodada 32 re-mediu a lista inteira (as rodadas 29-31 mudaram o terreno) e
pagou item a item, com a evidência ao lado.

**PAGO na rodada 32:**

| O que era | O que foi feito | Prova |
| --- | --- | --- |
| A auditoria não podia ser lida (128 escritores, um leitor sem tela) | `GET /core/audit` ganhou paginação, filtro por ação e busca NO SERVIDOR (`limit`/`offset`/`action`/`q`), o `total` para numerar páginas, o nome de quem fez (JOIN com `core_users`) e a lista de ações existentes para o seletor. Nada foi reescrito: a trilha continua append-only. Alcance: só `admin_geral`/`gestor` — a auditoria expõe ações de todo mundo, inclusive dos gerentes, e o vigiado não lê o próprio diário de vigilância. **E ganhou a TELA**: `/sistema/relatorios/auditoria` (menu Relatórios), com filtro, busca e páginas que viajam na consulta — o alcance declarado três vezes com a mesma lista (`DONOS_DO_GRUPO` na rota, no menu e no atalho do servidor) | `tests/auditoria-tem-leitor.test.ts` (7 casos; o guarda afrouxado de propósito derrubou o caso do 403 com `expected 200 to be 403`) + `auditoriaPage.test.tsx` no navegador (7 casos; tirado `DONOS_DO_GRUPO` da rota de propósito, `menu-e-rotas.test.tsx` caiu com "item restrito por perfil aponta para rota igualmente restrita") |
| O item fixado da tabela de preço não tinha escritor pela tela | As rotas `PUT/DELETE .../items/:productId` ganharam o leitor que faltava (`GET /catalog/price-tables/:id/items`, com produto pelo nome) e passaram a devolver a lista atualizada. De passagem: o `?? 0` do PUT fixava produto em R$ 0,00 quando o corpo vinha sem preço — agora é 400 nomeado, zero incluído. **E ganhou o GESTO na tela** de Auxiliares › Tabelas de preço: buscar produto, fixar em reais (o mesmo `parseReaisToCents` do PDV), listar o combinado com o de/por do cadastro, remover. Fixar é só de gerente (o guarda do PUT/DELETE); o estoquista LÊ a lista sem ganhar formulário que responderia 403 | `tests/preco-fixado-na-tabela.test.ts` prova a promessa INTEIRA por rota: fixado em R$ 120,00 vence os 15% da tabela na VENDA; removido, o percentual volta. No navegador, `precoFixadoNaTabela.test.tsx` (6 casos; alargado o `podeFixar` para estoquista de propósito, o caso do recorte caiu) |
| `core_terminals` era bomba (vazia, três FKs apontando, `PRAGMA foreign_keys = ON`) | `assertTerminalRegistered` (novo `TerminalRegistry.ts`) recusa `terminalId` desconhecido com `CORE_TERMINAL_NOT_REGISTERED` 400 e instrução ("o cadastro de terminais ainda não existe; deixe o campo vazio") — nos DOIS pontos de entrada: `openSession` (cobre corpo E fallback `req.auth.storeId`) e `POST /auth/device/enroll`. NÃO é o CRUD de terminal, que segue sendo módulo próprio | `tests/terminal-sem-cadastro.test.ts`; com o guarda comentado, os dois casos caíram com `expected 500 to be 400` e o log mostrou o `FOREIGN KEY constraint failed` cru — o defeito exato |
| Seis rotas sem chamador | Uma a uma: `GET /audit` e `PUT/DELETE` de itens de tabela GANHARAM leitor (acima). `GET /cash/sessions` LIGADA — histórico de turnos com quem abriu/fechou PELO NOME e diferença por turno; sem ela o dono não responde "de quem era o caixa que fechou faltando?". `POST /pdv/terminal/:id/confirmar-teste` DECLARADA com teste que percorre o caminho do mock pela rota. `GET /orders/:id` e `POST /orders/:id/cancel` LIGADAS — o cancel foi re-medido: só cancela pedido aguardando pagamento, devolve a reserva, é idempotente e recusa pedido pago (409 apontando para devolução); sem ele, pedido desistido segura reserva para sempre. **ATENÇÃO à metade de tela**: o servidor destas duas e do `/cash/sessions` está pronto e testado por rota, mas nenhuma tela os chama ainda — a metade que falta está declarada na tabela de dívida abaixo. `GET /core/logistics/shipments` APAGADA — duplicava o módulo `/api/v1/logistics` (que fica, com rodada própria) lendo a camada JSON legada. `GET /workshop/pending-payment` FICA declarada: é a metade de LER do checkout da OS, coberta pelo teste de fluxo | `tests/rodada-32-rotas-religadas.test.ts` (inclui a prova de que a rota apagada devolve 404 e a do módulo continua no ar) |
| Dezenove funções exportadas sem chamador | Re-medidas TODAS por varredura própria (server/src, src, server/tests): 16 funções continuavam com zero chamadores e SAÍRAM, cada uma com nota do porquê no lugar — `listBackups`, `hasAnyRate` (o comentário dizia "a tela usa"; mentia), `listClosings`, `recentFailuresFor`, `getEquipmentByToken` + `getEquipmentDetail` (o par da rota pública de QR removida rodadas atrás), `signWithCompanyCertificate`, `terminalIdempotencyKey` + `newTerminalKey`, `assertFiscalDocumentAllowed` (a trava que ele prometia JÁ roda em `renderDanfce`/`renderDanfe`, por onde todo caminho de impressão passa — o que saiu foi a cópia que nunca rodou, com o comentário mentiroso), `upsertFiscalCertificateReference`, `resetEcommerceConnectionState`, `upsertLogisticsCarrierCredentials`, `simulateBackendQuote` (cotação com peso INVENTADO — o default silencioso que o caminho vivo recusa), `pruneSentEmails`, `createPaymentTerminalTransactionBackend`. A varredura também achou 4 constantes mortas (`CORE_SCHEMA_VERSION = 1` congelada e errada, `TP_EMIS_NORMAL`, `CARD_ONLINE_STATUS`, `ECOMMERCE_READINESS_KEYS`) — saíram junto. Nenhuma tinha teste, então nenhum teste-fantasma ficou órfão | a varredura incluiu comentários: nenhum arquivo cita as funções removidas |
| Colunas escritas que nenhuma tela nomeia | `counted_by` → o detalhe da contagem devolve `counted_by_name`; `received_by` → a lista de Entrada de notas devolve `received_by_name` + `received_at`; `matched_by` (conciliação) → `listLines` devolve `matched_by_name` — todos por JOIN com `core_users`, porque id não responde a quem investiga. O autor de comentário de OS JÁ viajava (`author_name` é coluna gravada na escrita) e ganhou teste para não regredir. **E as duas mais caras ganharam LEITOR na tela**: Ajustes/inventário tem a coluna "Contado por" (travessão para item pendente — pendente não tem contador, e isso é informação), e a Entrada de notas mostra "por Fulano em data" sob o selo Recebida (nota antiga, confirmada antes de a coluna ser gravada, fica só com o selo — sem autor inventado) | `tests/quem-contou-quem-recebeu.test.ts` no servidor + `quemContouQuemRecebeu.test.tsx` no navegador |
| Cinco testes aceitavam mais de um status | Cada um foi RODADO e afirma só o status real, com o porquê escrito: `pdv-pix-maquininha` 401 (sem token, o middleware recusa antes de qualquer perfil); `prompt15-integrations-asaas` 403 (`resolveIntegrationCompanyId` recusa tenant alheio antes de validar corpo); `prompt19` 200 (o provedor 'ecommerce' é do catálogo fixo; o status vem no corpo); `prompt29` 200 (a rota de homologações existe e o admin passa pela permissão); `session-switch` 409 + `CORE_FISCAL_NOT_AUTHORIZED` (o gestor PASSA pela permissão; quem recusa é o serviço — o comentário antigo dizia "barra na permissão (403)" e nunca foi verdade para esse perfil) | os cinco arquivos, cada um com a medição no comentário |

**Dívida que FICA (medida e escrita):**

| O que | Onde | Custo |
| --- | --- | --- |
| **A tabela de preço nunca foi vista rodando no navegador de verdade** | rodada 30 inteira | Os quatro portões estão verdes e as telas são montadas em jsdom, mas ninguém vinculou um cliente a "Atacado -15%" e vendeu no PDV contra o servidor real. A memória deste projeto registra quatro falhas que a suíte verde escondeu e que só apareceram na tela. O caminho que fecha: vincular, vender, e ver o cupom sair por R$ 170,00 sem pedir gestor |
| **`GET /workshop/pending-payment` segue sem tela** | `core.ts` | A rota é a fila do balcão da oficina e o fluxo de checkout está vivo e testado no servidor — mas o quadro da oficina mostra a coluna "aguardando pagamento" sem oferecer o gesto de cobrar. Quando o balcão da oficina ganhar esse gesto, é esta fila que ele lista |
| **O cadastro de terminais não existe** | `core_terminals` | A bomba foi desarmada (o 500 de FK virou 400 nomeado nos dois pontos de entrada), mas PDV com duas gavetas continua impossível até o módulo de terminais nascer — com escritor, tela e alcance próprios |
| **O histórico de turnos não tem tela** | `GET /core/cash/sessions` | O servidor devolve abertura, fechamento, diferença e QUEM abriu/fechou pelo nome, testado por rota — mas nenhuma tela o chama. Sem a metade de tela, "de quem era o caixa que fechou faltando 40?" continua sem resposta na gestão. É a tela de caixa da gestão que deve listá-lo |
| **O detalhe e o cancelamento de pedido não têm tela** | `GET /core/orders/:id`, `POST /core/orders/:id/cancel` | A tela de pedidos lista e usa `/fulfillment` e `/pay`, sem detalhe nem botão de cancelar com confirmação (o 409 `CORE_ORDER_ALREADY_PAID` deve virar a frase "use devolução"). Enquanto a tela não nascer, pedido desistido segura reserva até alguém cancelar por rota |

---

## A matriz de permissões, e a regra que a mantém

### Os números, contados por AST

Contagem por regex já errou duas vezes aqui — uma varredura contou 55 rotas
caladas onde havia 52, porque exigia `requireProfile(req` na mesma linha e o
formatador quebra várias chamadas em duas; outra contou 63, porque onze rotas
põem o corpo dentro de uma IIFE assíncrona e o regex não sabia descer nela. Os
números abaixo saem do mesmo detector de AST que a regra de lint usa, então
documento e portão não têm como divergir.

| Medida | Número |
| --- | --- |
| Rotas em `core.ts` | 297 |
| Declaram por `requireProfile` (perfis nomeados um a um) | 245 |
| Declaram por `abertaAo` (por ambiente) | 52 |
| Chamadas de `requirePermission` em `core.ts` | **0** |
| Rotas caladas em `core.ts` | **0** |
| Rotas nos outros **19** arquivos de `src/routes/v1` | **303** |
| Delas, guardadas por `requirePermission` como middleware | 222 |
| Delas, sem guarda (públicas por desenho, ver abaixo) | 64 |
| Não classificadas: `index.ts`, que a primeira contagem esqueceu | 17 |

O total do servidor é **600 rotas em 20 arquivos**. A primeira contagem desta
rodada dizia 583 em 19 porque deixou `src/routes/v1/index.ts` de fora — 17
rotas, 12 guardadas por `requirePermission` na posição de middleware e 5
públicas. Os números 286/222/64 estavam certos para os arquivos contados e
errados como inventário do que fica fora da regra, que é como o texto os
apresentava.

`requirePermission` é **zero** em `core.ts`, e vale dizer por quê: uma premissa
antiga afirmava "uma chamada". As duas ocorrências que o grep acha estão dentro
de um comentário que explica por que aquele roteador não usa esse mecanismo.
Comentário não é código, e um número que vem de `grep -c` conta os dois.

As 64 sem guarda: `auth.ts` inteiro (10 — login, refresh, troca de empresa), a
vitrine e o portal do cliente em `storefront.ts` (32), nove públicas de
`storefronts.ts` (`/public/:slug/*` e `/health`), duas de carrinho e pedido que
exigem sessão mas não perfil, e onze `/health`, um por roteador. Quando são
chamadas, não existe perfil ainda.

### As três listas de ambiente

`abertaAo(req, ...)` é implementado POR CIMA de `requireProfile`, e não ao lado:
o atalho de `admin_geral` e `gestor` continua com uma implementação só.

| Ambiente | Perfis |
| --- | --- |
| `balcao` | `operador_caixa`, `operador_caixa_loja`, `operador_caixa_oficina` |
| `bancada` | `mecanico` |
| `escritorio` | `gerente_loja`, `gerente_oficina`, `estoquista`, `atendente` |

Como as 52 ficaram: 23 só `escritorio`, 19 `balcao`+`escritorio`, 2
`bancada`+`escritorio`, 8 abertas aos três.

### Por que "aberta aos três" não é o mesmo que rota calada

É a crítica que essa rodada teve de responder: se `abertaAo(req, 'balcao',
'bancada', 'escritorio')` deixa todo mundo passar, escrever isso oito vezes é
carimbo. A diferença é o perfil que **não existe ainda**:

- **Sem guarda**, um perfil desconhecido passa. Falha ABERTA. No dia em que
  nascer o nono perfil, ele entra em todas as rotas caladas sem ninguém tocar
  numa linha.
- **Com `abertaAo`**, um perfil que não pertence a ambiente nenhum recebe 403.
  Falha FECHADA. Ele só entra quando alguém o colocar numa das três listas —
  que é o momento em que a decisão deve ser tomada por gente.

`tests/rotas-abertura-declarada.test.ts` prova os dois lados com um perfil
inventado, e o caso declarado que ele testa é justamente uma rota aberta aos
três — a linha que o crítico chamou de carimbo. Ela recusa mesmo assim.

### A regra que impede a rota 298 de nascer calada

Fechar 52 rotas conserta hoje. O que fazia a conta subir uma rodada por vez era
o silêncio ser indistinguível de "aberta de propósito": as duas coisas têm a
mesma cara no código, e ninguém revisa o que não tem cara de nada.

`server/eslint-rules/rota-declara-alcance.js` recusa rota nova sem declaração.
Ela lê a árvore de sintaxe, e o critério é POSICIONAL: só vale a chamada cuja
execução é **incondicional** — statement de primeiro nível do corpo do handler,
do `try` de primeiro nível, ou da IIFE assíncrona de primeiro nível. Declaração
dentro de `if`, de laço ou de callback adiado é recusada com mensagem própria
("guarda que talvez não rode"), porque um guarda que talvez rode não é guarda.
Handler que não é função escrita ali também é recusado: regra que se cala
diante do que não entende é uma porta.

A regra começou ligada **só em `core.ts`**, e a restrição era decisão medida,
não preguiça: os outros roteadores guardam por MIDDLEWARE (`router.get(path,
authMiddleware, requirePermission('x.view'), handler)`), que é outro idioma, e
ligada sem entendê-lo ela acusaria centenas de rotas corretas — regra que dá
falso positivo é desligada na semana seguinte. A rodada 31 ensinou o segundo
idioma (a chamada de guarda como argumento da rota conta como declaração,
porque o Express a executa incondicionalmente antes do handler;
`authMiddleware` sozinho NÃO conta — autenticar diz quem você é, não o que
pode) e criou `rotaPublica('motivo')` em `server/src/middleware/auth.ts`: um
no-op que declara "aberta de propósito" com o porquê escrito na linha da rota.
Motivo vazio ou guardado em variável é recusado com mensagem própria. Desde
então a config (`server/eslint.config.js`) lista os dezenove roteadores de
`src/routes/v1`, nome por nome — e o teste da regra confere essa lista contra
os `export const *Router` do código, para roteador novo não nascer invisível.

### Como se sabe que a regra ainda morde

`tests/regra-rota-declara-alcance.test.ts` **não** usa o `RuleTester` do eslint.
Duas razões: `eslint` não é dependência declarada de `server/package.json` (está
lá como par de `typescript-eslint`), e o `RuleTester` traz o próprio arranjo de
testes, que disputa com o do vitest. Mas a razão que decide é outra, e é a lição
da rodada 22: o `RuleTester` alimenta a função da regra à mão, então passaria
mesmo com a regra **desligada** em `eslint.config.js` — provaria que ela
funciona, não que ela protege.

O teste roda o eslint **como processo**, do jeito que o portão o roda, sobre dois
arquivos de exemplo em `server/eslint-rules/__fixtures__/`, e lê a saída em JSON:
o exemplo bom (oito formatos de rota que declaram, contando os três do idioma de
middleware da rodada 31) tem de dar zero erros, e o exemplo ruim tem de dar
sete, cada um com o tipo certo. O quarto teste pergunta ao eslint qual
configuração ele resolve **para `core.ts`** e exige a regra em `error` — é o que
quebra se alguém apagar o bloco da config. O quinto faz o mesmo para os outros
roteadores e confere a lista da config contra os exports reais de
`src/routes/v1`.

A prova foi conferida quebrando a regra de propósito, três vezes, e as três
ficaram vermelhas: trocar a busca posicional por "qualquer profundidade" (as duas
rotas de guarda condicional somem: 4 erros viram 2), deixar handler não-inline
passar (4 viram 3), e desligar a regra na config (o quarto teste cai). E,
acrescentando uma rota calada ao fim de uma cópia do `core.ts` real, o eslint
aponta **essa uma** entre as 298.

---

## O que foi apagado

O sistema antigo — 1.774 arquivos, 80.800 linhas, 350 rotas — foi removido na
rodada 19. Não era código "que talvez alguém use": ele guardava a sessão no
navegador, e o login atual autentica no servidor, então **toda** rota antiga
terminava num salto para a tela de senha. Isso foi verificado no navegador antes
da remoção.

Junto saíram 12 dependências que só ele carregava: firebase, o SDK Supabase do
navegador, recharts, zustand, Stripe, jspdf, html2canvas, html5-qrcode,
lucide-react e os três pacotes do dnd-kit.

---

## Como conferir que isto é verdade

```bash
npm run lint && npm run type-check && npm run test && npm run build
```

E, no navegador, o caminho que mais ensina: abrir o PDV, vender, e ver a venda
aparecer no painel, no estoque e no financeiro. Suíte verde já escondeu defeito
neste projeto — um webhook aceitava pagamento sem autenticação com todos os
testes passando, e o furo só apareceu quando alguém bateu no endereço de
verdade.
