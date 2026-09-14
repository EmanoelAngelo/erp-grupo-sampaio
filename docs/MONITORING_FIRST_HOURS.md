# Monitoramento — primeiras horas pós Go-Live

## Onde olhar

| Área | O que monitorar | Onde |
|------|-----------------|------|
| API | 5xx, latência | log do dia; Configurações › Sistema › Últimos erros |
| Banco | versão do núcleo, banco abre | `GET /api/v1/readiness`, `node server/dist/db/status.js` |
| Login | falhas, bloqueios | log, Relatórios › Auditoria |
| PDV | vendas finalizadas, erros de caixa | Caixa, Relatórios |
| Estoque | divergência de inventário | Estoque › Ajustes e inventário |
| Caixa | diferença no fechamento | Caixa › Fechamento, Financeiro › Conciliação |
| Maquininha | cobranças sem resposta | `/sistema/conferencia-maquininha` |
| Asaas | pagamento sem baixa | Integrações › Asaas › Conciliação |
| Sync | fila, eventos parados | Integrações › Banco central |
| E-mail | fila, falhas | Loja › E-mails |
| Backup | última cópia, bucket, fotos | Configurações › Backup |
| Disco | espaço | sistema operacional |

## Alertas sugeridos

- 5xx acima de 1% por 5 minutos
- Latência da API acima de 2 s sustentada
- Evento parado na fila da central, ou e-mail falho
- Pico de falhas de login (acima de 3x o normal)
- Divergência de estoque ou de caixa num fechamento

## Logs

- Log estruturado, uma linha JSON por evento, no nível de `LOG_LEVEL`
- Conferir ausência de segredo, PAN, CVV e certificado
- Todo erro tem `requestId`: a tela mostra o começo dele na frase do erro 5xx e
  o código inteiro em Configurações › Sistema; procure-o no log do dia

## Não monitorar como bloqueio inicial

Integrações externas desligadas (Asaas, SEFAZ, transportadoras, TEF, vitrine
pública) — esperado até a homologação de cada uma; o checklist de cada empresa
as mostra como BLOQUEADO EXTERNAMENTE.
