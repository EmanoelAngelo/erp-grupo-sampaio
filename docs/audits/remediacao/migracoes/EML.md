# Frente EML — o que o integrador leva para o passo de consolidação

Regra da remediação (REGRAS.md, seção 5): nada de passo numerado nem mudança de
`CORE_TARGET_VERSION` dentro da frente. O que é DDL canônica já está em
`server/src/db/schema.ts` e o boot aplica sozinho; o que está aqui é o que o
boot **não** pode fazer — índice sobre coluna nova de tabela existente e
correção de dado — com o SQL exato e o motivo.

## Lote M1

### O que já entra pela DDL canônica (nenhuma ação do integrador)

| Mudança | Onde | Como chega ao banco existente |
|---|---|---|
| `core_email_queue.next_attempt_at TEXT` (nullable) | DDL de `core_email_queue` | `reconcileCoreSchema` acrescenta a coluna (nullable, sem DEFAULT). Linha antiga fica `NULL` = "já pode sair", que é o comportamento de antes. — GAP-PRD-038 |
| Tabela nova `core_email_segredos` | DDL canônica, logo depois de `core_email_queue` | `CREATE TABLE IF NOT EXISTS` no boot. Entrou também em `CORE_TABLES_IN_DELETE_ORDER` (antes de `core_email_queue`) e no inventário do cofre (`secretsInventory.ts`, tipo `email_conteudo_protegido`). — GAP-PRD-007 |

### M1-1 · Índice da próxima tentativa (opcional, desempenho)

```sql
CREATE INDEX IF NOT EXISTS ix_email_queue_proxima_tentativa
  ON core_email_queue (status, next_attempt_at);
```

**Motivo.** O carteiro agora seleciona `status = 'pending' AND (next_attempt_at
IS NULL OR next_attempt_at <= ?)`. O índice existente `ix_email_queue_pending
(status, created_at)` já restringe a `pending`, e a fila da loja é de dezenas
de linhas — por isso é **opcional**. Fica descrito porque é índice sobre coluna
nova de tabela existente, que a regra manda para o passo de consolidação.

### M1-2 · Mascarar o link e o código que ficaram EM CLARO nas linhas antigas (correção de dado)

**Motivo (GAP-PRD-007).** Antes do conserto, `queuePasswordResetEmail` e
`queueVerificacaoEmail` gravavam o link de recuperação (com `token=`) e o código
de verificação no `body_text` da fila — e a linha da fila nunca é podada. O
código novo já protege a tela (`listEmailQueue` passa todo corpo desses dois
modelos por `mascararConteudoProtegidoLegado`) e mascara o corpo de cada linha
antiga que terminar pelo carteiro. Mas as linhas antigas **já entregues ou já
desistidas** continuam com o segredo em claro no arquivo do banco (e em todo
backup dele) até alguém rodar isto. O token vencido não abre conta nenhuma,
mas revela o padrão do link e não tem por que existir.

O que o SQL faz: reescreve o corpo das linhas antigas desses dois modelos com o
corpo de hoje (o mesmo texto, com o marcador no lugar do segredo). Deixa de fora,
de propósito, a pendente com menos de 1 hora — ela ainda vale e o carteiro a
entrega do jeito antigo (e mascara o corpo depois). A pendente antiga (mais de
1 hora, link já vencido) passa a ter marcador sem segredo, e o carteiro a
encerra como `failed` dizendo que o cliente precisa pedir outro — que é a
verdade sobre um link vencido.

Idempotente: o filtro `instr(body_text, '[protegido: só o cliente recebe]') = 0`
só toca linha que ainda não foi mascarada. O texto do marcador é o de
`MARCA_DO_CONTEUDO_PROTEGIDO` em `EmailService.ts` — os dois precisam ser
iguais.

```sql
UPDATE core_email_queue
   SET body_text =
         'Você pediu para redefinir a senha da sua conta no Grupo Sampaio.' || char(10) || char(10)
      || 'Abra este link para escolher uma nova senha (vale por 1 hora):' || char(10)
      || '[protegido: só o cliente recebe]' || char(10) || char(10)
      || 'Se não foi você, ignore este e-mail: sua senha continua a mesma.' || char(10) || char(10)
      || 'Grupo Sampaio'
 WHERE template = 'recuperacao_senha'
   AND instr(body_text, '[protegido: só o cliente recebe]') = 0
   AND NOT (status = 'pending'
            AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'));

UPDATE core_email_queue
   SET body_text =
         'Olá!' || char(10) || char(10)
      || 'Seu código de confirmação no Grupo Sampaio é: [protegido: só o cliente recebe]'
      || char(10) || char(10)
      || 'Digite-o na página "Minha conta" para provar que este e-mail é seu.' || char(10)
      || 'Ele vale por 1 hora. Se não foi você, ignore esta mensagem.' || char(10) || char(10)
      || 'Grupo Sampaio'
 WHERE template = 'verificacao_email'
   AND instr(body_text, '[protegido: só o cliente recebe]') = 0
   AND NOT (status = 'pending'
            AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'));
```

Conferido pela frente num banco em memória com cinco linhas (reset entregue,
reset pendente de agora, reset pendente de 3 h atrás, verificação desistida e um
aviso de pedido com seis dígitos no corpo): mascarou o entregue, o pendente
antigo e a verificação; deixou intactos o pendente de agora e o aviso de pedido.
O banco operacional **não** foi consultado nem alterado pela frente.

**Depois de aplicar**, recomenda-se o `VACUUM` que o passo de consolidação já
fizer (se fizer): o texto antigo pode sobreviver em página livre do arquivo
SQLite até lá.

## Lote M2

### O que já entra pela DDL canônica (nenhuma ação do integrador)

| Mudança | Onde | Como chega ao banco existente |
|---|---|---|
| Tabela nova `core_email_identidade` (PK `company_id`, `modo` com CHECK `grupo`/`empresa`, DEFAULT `grupo`) | DDL canônica, logo depois de `core_email_segredos` | `CREATE TABLE IF NOT EXISTS` no boot. Entrou em `CORE_TABLES_IN_DELETE_ORDER` (antes de `core_email_queue`). Empresa sem linha = modo `grupo` = o comportamento de antes (remetente do ambiente, sem Reply-To, assinatura "<loja> — Grupo Sampaio"). Não guarda segredo: fora do inventário do cofre de propósito. — GAP-PRD-198 |

Nenhuma coluna nova em tabela existente, nenhuma constraint trocada. Os modelos
novos da fila (`os_orcamento_disponivel`, `os_pronta`, `os_concluida`,
`pedido_cancelado`, `pedido_reembolsado`, `pagamento_apos_cancelamento`,
`pedido_entregue`, `nota_disponivel`) cabem em `core_email_queue.template`, que é
`TEXT` sem CHECK — nada a migrar.

### M2-1 · Nenhuma correção de dado

Os pedidos cancelados, reembolsados e entregues ANTES desta mudança não
recebem aviso retroativo, de propósito: mandar hoje "seu pedido foi cancelado"
sobre um cancelamento de semanas atrás confundiria o cliente. O mesmo vale para
OS já concluídas e notas já autorizadas. Nada a aplicar.

### M2-2 · Índice (opcional, desempenho) — não recomendado agora

A rota `GET /core/workshop/orders/:id/avisos` e o controle de "mesmo orçamento
pedido de novo" leem `core_email_queue` por `company_id` e prefixo de
`dedupe_key` (`substr(dedupe_key, 1, n) = ?`), que não usa o índice UNIQUE de
`dedupe_key`. A fila da loja é de dezenas a poucas centenas de linhas por
empresa; um índice `(company_id, created_at)` só se justificaria se a fila
crescer para dezenas de milhares. Fica registrado, sem SQL a aplicar.

## Lote M3

### O que já entra pela DDL canônica (nenhuma ação do integrador)

| Mudança | Onde | Como chega ao banco existente |
|---|---|---|
| `core_mail_inboxes.imap_uid_validity TEXT`, `imap_last_uid INTEGER`, `imap_pending INTEGER` (nullable) | DDL de `core_mail_inboxes` | `reconcileCoreSchema` acrescenta. `NULL` = "sem cursor": a primeira leitura depois da mudança busca as não lidas (o comportamento de antes) e a partir dela o sistema lembra o último UID processado. — GAP-PRD-035 |
| `core_mail_inboxes.after_read TEXT NOT NULL DEFAULT 'lida'`, `processed_folder TEXT` | DDL de `core_mail_inboxes` | `reconcileCoreSchema` acrescenta com o DEFAULT: caixa existente passa a marcar como lida o que processa (a correção recomendada pela auditoria). O dono troca na tela para "mover" ou "não mexer". Sem CHECK na coluna (o `ADD COLUMN` não levaria a constraint a banco existente); o serviço valida os três valores. — GAP-PRD-035 |
| `core_mail_inboxes.last_error_kind TEXT`, `last_ok_at TEXT` (nullable) | DDL de `core_mail_inboxes` | `reconcileCoreSchema` acrescenta. Linha antiga fica com `last_error_kind = NULL`: o serviço deduz o tipo do texto de `last_error` enquanto a coluna estiver vazia (`tipoDaUltimaFalha`), então a caixa da Preço Justo ("Command failed" de 13/08) já aparece como `CREDENTIAL_REJECTED` sem correção de dado. — GAP-PRD-128 |

Nenhum índice novo, nenhuma constraint trocada, nenhuma tabela nova.

### M3-1 · Chave da mensagem lida: conversão preguiçosa, sem SQL do integrador

`core_mail_messages.provider_uid` passa de `'<UID>'` para
`'<UIDVALIDITY>:<UID>@<pasta>'` (o UID sozinho só identifica a mensagem dentro de
uma validade de uma pasta). O UIDVALIDITY só é conhecido **ao conectar na caixa**,
então a conversão não cabe num passo de migração: ela acontece dentro de
`cursorDaCaixa` (MailInboxService), na primeira leitura de cada caixa que ainda
não tem cursor — reescreve as linhas daquela caixa cujo `provider_uid` é só
dígitos, com a validade e a pasta de agora. É por caixa, na leitura (nunca no
boot), idempotente (o filtro `NOT GLOB '*[^0-9]*'` só pega o formato antigo) e
provada em `imap-leitura-que-nao-satura.test.ts` ("a caixa antiga (UID sem
validade) não reprocessa o que já tinha visto").

No banco operacional, `core_mail_messages` está vazia (a única caixa, da Preço
Justo, nunca importou nada): a conversão não terá o que reescrever.
