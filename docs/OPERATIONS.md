# Operações — Grupo Sampaio ERP 1.0.0

Rotinas do dia a dia. **Toda tela e todo comando citado aqui existe** — este
arquivo mandava para uma "Administração" com status, saúde, prontidão e
recovery, e para um comando de verificação de restore, que nunca existiram
(GAP-PRD-064). `server/tests/os-documentos-apontam-para-o-que-existe.test.ts`
confere cada tela e cada comando citado; se um deles mudar de lugar, o teste
cobra este arquivo.

## Primeiro acesso (administrador)

1. Entrar como `admin`, com a senha de `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` (a
   primeira subida criou a conta, provisória): o primeiro login abre a troca
   obrigatória. Trocada a senha, apagar a variável do `.env`.
2. **Pessoas › Usuários e equipe** (`/sistema/usuarios`) — cadastrar gerentes,
   PDVs e mecânicos, com vínculos e perfis. Cada conta nasce com senha
   provisória e só entra trocando a senha: o primeiro login abre a troca
   obrigatória e a API recusa o resto até lá.
3. **Configurações › Empresas do grupo** (`/sistema/empresas`) — em cada
   operação, o link **Checklist** abre a implantação dela: o que está pronto,
   pendente, por confirmar, dispensado (com motivo) ou esperando alguém de
   fora, item por item, com a tela que resolve e quem resolve.
4. Configurações → Caixas e terminais — cadastrar um caixa por ponto de venda (cada um com a sua gaveta) e, se quiser, registrar o computador de cada caixa para entrar sem senha
5. Cadastrar produtos (Produtos) e lançar o estoque inicial por inventário
   (Estoque › Ajustes e inventário).
6. Um caixa completo de teste: abrir → vender → fechar (Caixa).
7. Integrações **somente quando** houver credencial/homologação — o checklist
   da empresa diz qual falta e de quem.

## Contas iniciais

A primeira subida — ou o bootstrap a frio (`npm run db:bootstrap --prefix server`,
o mesmo `npm run db:seed --prefix server`; no servidor
`node server/dist/db/bootstrap-cli.js`) — cria as seis operações e **uma**
conta: `admin`, administrador em todas elas, com a senha de
`DEVORA_BOOTSTRAP_ADMIN_PASSWORD`. Nenhuma conta de demonstração.

- Nasce com senha provisória: o primeiro login abre a troca obrigatória, e a API não responde a mais nada até ela  
- Só é criada quando não há administrador do grupo nem conta `admin`; o bootstrap nunca altera conta existente (rodar de novo não reseta a senha trocada)  
- Depois da troca, apagar `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` do `.env`: Configurações › Implantação fica em atenção enquanto ela estiver lá  
- Sem a variável e sem administrador, ninguém entra: a conferência da implantação bloqueia em "Administrador inicial" e diz o que fazer  
- As demais contas o admin cadastra em Pessoas › Usuários e equipe (`/sistema/usuarios`)  
- Não publicar hashes  
- O checklist de cada empresa (Pessoas e acessos) lista as contas ainda marcadas como provisórias.

## Abrir / fechar caixa

1. Login PDV da operação  
2. Se a operação tem caixas cadastrados, escolher **qual caixa é este computador** (a escolha fica guardada na máquina; o computador registrado por token já vem com o caixa dele)  
3. Informar valor inicial (parser BRL) → Abrir Caixa  
4. Vender / receber — a venda entra na gaveta do caixa deste computador  
5. Informar contado → **Fechar caixa**  
6. Nova sessão = novo ID (histórico preservado)  

Gaveta aberta de outro dia: o PDV e o Painel avisam com a data. Conte e feche antes de vender — em Vendas → Caixa, o card "Gavetas abertas nesta operação" fecha qualquer gaveta aberta da operação, de qualquer caixa.

Sem nenhum caixa cadastrado a operação trabalha com a gaveta única (um caixa aberto por vez), como antes.

## Servidor da loja fora do ar (a venda guardada)

- O PDV continua vendendo: a venda fica guardada **neste navegador**, com a
  chave dela. A barra do topo diz se o problema é a rede deste computador
  ("sem rede") ou o servidor da loja ("o servidor da loja não responde").
- Não precisa clicar: enquanto houver venda guardada, a barra tenta de novo
  sozinha (5 s, 10 s, 20 s e daí a cada 30 s). Fechar e reabrir o navegador não
  perde a fila. "Enviar agora" continua lá para quem não quer esperar.
- **Não feche a gaveta com venda guardada**: o botão "Fechar caixa" espera a
  fila deste computador esvaziar.
- Se o servidor **recusar** a venda (a gaveta daquele turno foi fechada, o
  estoque acabou), ela vai sozinha para **Regularizar** — link na barra, visível
  em todos os caixas e para o gestor:
  - **Relançar na gaveta aberta**: usa a mesma chave, então não vende duas vezes;
  - sem estoque: lance a entrada em Estoque › Movimentações (motivo "venda feita
    sem servidor") e relance;
  - **Descartar** (gerência, com motivo): a venda não vai existir.
  Venda recusada de uma gaveta ainda aberta aparece no fechamento dela, e fechar
  exige declarar ciência com motivo.
- Com o servidor fora param: consulta atualizada, abrir/fechar caixa, OS,
  cobranças, NFC-e e maquininha integrada. A proteção é **nobreak no servidor**
  e o backup diário — ver `docs/ESTADO-ATUAL.md`, "Servidor da loja: ponto único".

## Maquininha integrada (PinPad pelo agente local)

Sem maquininha integrada, o cartão é lançado à mão contra o comprovante da maquininha avulsa — nada muda.

Para integrar o PinPad de um caixa (Configurações → Maquininhas):

1. **Pré-requisito externo**: o PinPad ligado ao computador do caixa e o **gerenciador TEF da adquirente/TEF house** instalado nele, homologado e configurado no modo de **troca de arquivos** (pastas `REQ` e `RESP`; padrão `C:\TEF_DIAL\REQ` e `C:\TEF_DIAL\RESP`).
2. **Nova maquininha**: adquirente, nome ("PinPad do Caixa 1"), identificador do aparelho e o caixa. Ela nasce **desligada**. O caminho "pela nuvem da adquirente" (maquininha smart) não está disponível — a tela mostra o motivo.
3. **Gerar código de pareamento** para o caixa (vale 10 minutos, uma vez só).
4. No computador do caixa, com Node 22+ e a pasta `server/dist` desta versão: `node dist/local-agent/main.js parear --servidor https://<endereço-da-api>/api/v1 --codigo <código> [--req C:\TEF_DIAL\REQ] [--resp C:\TEF_DIAL\RESP]`. Grava `devora-agente.json` com o segredo do agente — não copiar para outro computador. O proxy na frente da API precisa preservar o caminho `/api/v1/...` (a assinatura do agente cobre o caminho).
5. `node dist/local-agent/main.js saude` confere o gerenciador TEF (operação ATV). Depois deixe `node dist/local-agent/main.js rodar` como serviço do Windows (NSSM ou Agendador de Tarefas "ao iniciar o computador").
6. Com o agente **online** e o **cliente TEF ok** na tela, **Ligar** a maquininha (com motivo). A partir daí o cartão daquele caixa só entra na venda com a cobrança aprovada no PinPad.
7. **Homologação**: faça no balcão as operações da lista (crédito, débito, uma recusa, um cancelamento, o comprovante, uma venda paga com a cobrança). Cada item fica verde pela operação real — nenhum botão declara.

Agente fora do ar: o PDV avisa antes de cobrar e a cobrança é recusada sem nada ser feito. Para voltar ao cartão manual, o gerente **desliga** a maquininha (com motivo). Cobrança que o agente pegou e não respondeu vira **não confirmada** em Vendas → Conferência de maquininha ("Consultar no aparelho" em Configurações → Maquininhas, ou conferir no extrato). Computador trocado: **Revogar** o agente e parear o novo.

## Impressora térmica e gaveta pelo agente local (cupom sem diálogo)

O cupom sai sozinho na térmica e a gaveta abre no Finalizar **pelo mesmo agente
local da maquininha**, rodando no computador do caixa. Sem ele, nada muda: o
cupom sai pela caixa de diálogo do navegador e a gaveta abre pela chave.

1. **Parear o agente** do caixa em Configurações › Maquininhas › Agente local
   (código de 10 minutos). No computador do caixa:
   `node dist/local-agent/main.js parear --servidor https://<api>/api/v1 --codigo <código>`
   — acrescente `--sem-tef` se o caixa não tiver PinPad integrado (o agente só
   imprime). Depois deixe `node dist/local-agent/main.js rodar` como serviço
   (NSSM ou Agendador "ao iniciar"): ele cuida do PinPad e da impressora juntos.
2. **Cadastrar a impressora** em Configurações › Impressoras: finalidade Cupom,
   "Agente local", o **caixa** e o **endereço** dela naquele computador:
   - impressora de rede: `tcp:192.168.0.50:9100`;
   - USB compartilhada no Windows (fila "Genérico / Somente texto"):
     `\\CAIXA1\CUPOM`;
   - serial `COM3`, paralela `LPT1`.
   Largura do papel 58 mm = 32 colunas; 80 mm = 48.
3. **Imprimir teste** na mesma tela (gerente). Só com a página de teste
   confirmada pelo agente a prontidão diz `AGENT_READY`.
4. No PDV: com a térmica do caixa e o agente no ar, o Finalizar manda o cupom
   ao agente, com o pulso da gaveta quando entrou dinheiro. A segunda via não
   abre gaveta. No diálogo do caixa (F3), **Abrir gaveta** (troco, conferência)
   aparece só com o agente no ar e pede o motivo — pedido e abertura ficam na
   Auditoria. O pulso que o agente não retira em 1 minuto nunca abre depois.
5. Se o agente cair, o PDV não trava: o cupom sai pelo navegador e a tela diz
   por quê. Cupom retirado e não confirmado em 2 minutos vira falha com a
   frase para conferir a impressora (papel, tampa, cabo).

## Criar usuário

Pessoas › Usuários e equipe → Novo usuário → perfil.

- Gerente de loja não cria administrador do grupo
- Gerente de oficina cria os perfis de oficina permitidos

## Nova empresa

Configurações › Empresas do grupo → **Abrir nova operação**: cria a empresa, o
primeiro gerente (com a senha provisória mostrada uma vez) e, se for oficina, a
primeira bancada — tudo ou nada. Depois, **Checklist** na linha da empresa
nova: é o roteiro da implantação dela.

Depois, crie os caixas da operação em Configurações › Caixas e terminais (opcional com um caixa só).

Sem filiais automáticas fictícias.

## Integrações

Credencial de terceiro entra pela TELA, que a guarda no cofre:

- Cobrança online: Integrações › Asaas (`/sistema/integracoes/asaas`)
- Certificado A1: Fiscal › Certificado (`/sistema/fiscal/certificado`)
- CSC, série e emitente: Fiscal › Configuração (`/sistema/fiscal/configuracao`)
- Transportadoras: Loja › Logística (`/sistema/loja/logistica`)

SMTP (`EMAIL_*`) e banco central (`DEVORA_SUPABASE_*`) vêm do `.env` do
servidor: depois de editar, **reinicie a API** — o `.env` só é lido ao subir.

**A exceção, dita pelo nome (GAP-PRD-130):** a conta de envio de e-mail
(`EMAIL_*`) e a sincronização com a central (`DEVORA_SUPABASE_*`) são do
servidor, valem para as seis empresas e entram pelo `.env` — uma vez, na
implantação ou quando a senha de app for trocada. O servidor relê essas chaves
sem reiniciar (ver `DEPLOY.md`). Todo o resto das comunicações é por tela, por
empresa:

- **Sistema › Loja › E-mails** — o cartão "O que falta para os e-mails desta
  empresa saírem" lista o que está faltando (SMTP, fila, remetente,
  destinatário e agenda do contador, usuário do contador, caixa de NF-e), quem
  fornece e onde se resolve;
- **Fiscal › Fechamento do contador** — quem recebe o pacote e o dia do envio
  automático;
- **Usuários e equipe** — o acesso do escritório de contabilidade (perfil "Escritório de
  contabilidade (externo)");
- **Compras › NF-e por e-mail** — a caixa que recebe as notas, a senha de
  aplicativo (com "Testar conexão") e o que fazer com a mensagem depois de lida.

## Backup

```powershell
npm run backup              # copia agora e confere
npm run backup:verify       # confere o último (integrity_check)
npm run db:backups          # lista
npm run db:restore <backup> <destino-novo.db>
npm run db:restaurar-do-bucket <pasta-nova>   # disco morto: banco + fotos do bucket
```

No servidor, as versões compiladas: `node server/dist/scripts/backup-agora.js`,
`verificar-backup.js`, `listar-backups.js`, `restaurar-backup.js` e
`restaurar-do-bucket.js` (roteiro completo em `docs/DEPLOY.md`).

Restaurar é sempre para um caminho **novo** — o comando recusa destino que já
existe, e a base ativa nunca é tocada. Para **ensaiar a volta**, restaure numa
pasta de teste e abra. O estado (última cópia, bucket, fotos, falhas) está em
**Configurações › Backup**.

## Conferências (o que este arquivo chamava de "Recovery / Reconciliação")

Não existe auto-fix global: cada tela relata a divergência, e corrigir é
decisão de quem responde por aquele dinheiro ou estoque.

- Conciliação bancária — Financeiro › Conciliação (`/sistema/financeiro/conciliacao`)
- Conciliação do Asaas — `/sistema/integracoes/asaas/conciliacao`
- Cobranças de maquininha sem resposta — `/sistema/conferencia-maquininha`
- Conciliação de recebimento (compras) — `/sistema/compras/conciliacao`
- Fila da central (eventos parados, reativar) — Integrações › Banco central
  (`/sistema/integracoes/central`)
- Fila de e-mail (enviados, falhos e o motivo) — Loja › E-mails (`/sistema/loja/emails`)
- Quem fez o quê — Relatórios › Auditoria (`/sistema/relatorios/auditoria`)

## Monitoramento

- **Configurações › Sistema** (`/sistema/configuracoes/sistema`): versão, banco
  (núcleo contra o alvo desta build), estado do cofre e os últimos erros da aba
  com o código do log
- **Configurações › Implantação** (`/sistema/configuracoes/implantacao`): como a
  instalação está publicada (HTTPS, serviço, chaves, dados)
- **Configurações › Backup** (`/sistema/configuracoes/backup`)
- **Empresas do grupo › Checklist** de cada empresa
- Sondas públicas: `GET /api/v1/health` (vivo), `GET /api/v1/readiness` (o banco
  abre; 503 se não), `GET /api/v1/version` (versão e `databaseVersion` do núcleo)
- Versão do banco por comando: `node server/dist/db/status.js` (`EM_DIA` sai com 0)

## Incidentes (básico)

1. Anote a hora e o **código do erro**: toda falha do servidor sai com
   "Código para o suporte: xxxxxxxx", e Configurações › Sistema › Últimos erros
   desta aba mostra o código inteiro. É o `requestId` que o log grava.
2. Procure o código no log do dia (`server/data/logs/api-AAAA-MM-DD.log` com o
   supervisor no Windows; o journal do serviço no Linux).
3. Relatórios › Auditoria para quem fez o quê, e a conferência do domínio
   (lista acima).
4. Backup antes de qualquer ação destrutiva (`npm run backup`).
5. Rollback de aplicação só se a falha for sistêmica no núcleo (não por um
   provedor externo opcional).

Ver `docs/GO_LIVE_ROLLBACK.md`.
