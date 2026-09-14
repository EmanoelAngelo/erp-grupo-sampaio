/**
 * O WEBHOOK DO ASAAS, DITO NA TELA (GAP-PRD-002).
 *
 * A tela de Integrações tinha o campo do token e nenhuma URL. O dono cadastrou
 * no painel do Asaas o endereço que o papel anunciava — e aquele endereço
 * gravava o aviso sem baixar nada. Este card diz as três coisas que faltavam:
 *
 *   1. QUAL URL colar no painel do Asaas desta operação (com botão de copiar);
 *   2. se o endereço é alcançável de fora — `localhost` não é, e o card diz o
 *      que configurar no servidor;
 *   3. se o aviso ESTÁ CHEGANDO: o último recebido, e quantos no mês. Token
 *      "Configurado" sem nenhum aviso é a pista de que a URL ou o token do
 *      painel não batem com os daqui.
 *
 * O endereço antigo aparece também, porque quem já o cadastrou não precisa
 * trocar: ele passa pelo mesmo processamento, com a operação pelo token.
 */
import { useState } from 'react';
import { Badge, Card } from '@/components/gs/ui';
import type { AsaasWebhookInfo } from '@/lib/api/asaasWebhook';
import { dataHoraBR } from '@/lib/datas';

export function WebhookAsaasCard({
  webhook,
  tokenConfigurado,
  tokenDoAmbiente,
}: {
  webhook: AsaasWebhookInfo;
  /** O token desta operação está salvo (cofre, ou ambiente fora de produção). */
  tokenConfigurado: boolean;
  /** O token em uso é o do AMBIENTE — atalho de desenvolvimento. */
  tokenDoAmbiente: boolean;
}) {
  const [copiado, setCopiado] = useState(false);
  const ultimo = webhook.lastEvent;

  return (
    <Card
      title="Webhook — o aviso de pagamento"
      subtitle="É por este endereço que o Asaas avisa que um pagamento caiu. Sem ele, nada é baixado sozinho."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-muted)]">
            URL a cadastrar no painel do Asaas desta operação
          </span>
          <div className="flex flex-wrap gap-2 items-center">
            <code
              data-testid="webhook-url"
              className="flex-1 min-w-[260px] px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                font-mono text-[length:var(--gs-text-sm)] break-all bg-[var(--gs-surface)]"
            >
              {webhook.url}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(webhook.url)
                  .then(() => setCopiado(true), () => setCopiado(false));
              }}
              className="bg-[var(--gs-purple-700)] hover:bg-[var(--gs-purple-800)] text-white
                border-0 rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer font-semibold"
            >
              {copiado ? 'Copiada' : 'Copiar URL'}
            </button>
          </div>
        </div>

        {webhook.warning && (
          <p
            role="alert"
            className="px-3 py-2 m-0 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]"
          >
            {webhook.warning}
          </p>
        )}

        <ol className="m-0 pl-5 flex flex-col gap-1 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          <li>No painel do Asaas desta operação: Integrações › Webhooks › Adicionar.</li>
          <li>Cole a URL acima e, em &quot;Token de autenticação&quot;, o MESMO token guardado no card de credenciais.</li>
          <li>Marque os eventos de cobrança (PAYMENT_*) e salve com a fila ativa.</li>
        </ol>

        {!tokenConfigurado && (
          <p
            role="status"
            className="px-3 py-2 m-0 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]"
          >
            Sem token guardado, o servidor recusa todo aviso (503) — de propósito: aviso sem
            conferência é porta aberta para marcar pedido como pago.
          </p>
        )}
        {tokenDoAmbiente && (
          <p
            role="status"
            className="px-3 py-2 m-0 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]"
          >
            O token em uso é o do AMBIENTE do servidor, não um desta operação. Serve para
            desenvolvimento; em produção o servidor o recusa, e ele não vale para operação que tem o
            próprio token. Guarde o token desta operação.
          </p>
        )}

        <div className="flex flex-wrap gap-3 items-center" data-testid="webhook-ultimo-aviso">
          {ultimo ? (
            <>
              <Badge tone={ultimo.processed ? 'success' : 'danger'}>
                {ultimo.processed ? 'Último aviso processado' : 'Último aviso com erro'}
              </Badge>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                {ultimo.eventType || 'evento'} em {dataHoraBR(ultimo.receivedAt)}
                {ultimo.error ? ` — ${ultimo.error}` : ''}
              </span>
            </>
          ) : (
            <Badge tone="neutral">Nenhum aviso do Asaas chegou para esta operação ainda</Badge>
          )}
          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            {webhook.eventsLast30Days} aviso(s) nos últimos 30 dias
            {webhook.pendingWithError > 0
              ? ` · ${webhook.pendingWithError} esperando o reenvio do Asaas`
              : ''}
          </span>
        </div>

        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
          Já cadastrou o endereço antigo (<code className="break-all">{webhook.legacyUrl}</code>)? Não
          precisa trocar: ele passa pelo mesmo processamento, e a operação é reconhecida pelo token.
        </p>
      </div>
    </Card>
  );
}
