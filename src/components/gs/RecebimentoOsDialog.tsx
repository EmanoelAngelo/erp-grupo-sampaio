/**
 * RECEBER A OS COM A CESTA DO PDV — GAP-PRD-104 (e o balcão do GAP-PRD-042).
 *
 * ## O que havia
 *
 * Um `<select>` com quatro meios e um botão: uma forma só, valor cheio, sem
 * desconto, sem troco, sem maquininha, sem fiado. O balcão real — metade no
 * PIX, metade em dinheiro, cartão passado na maquininha — não cabia no botão,
 * e a OS era cobrada "em dinheiro" para ser conciliada por fora.
 *
 * ## O que é agora
 *
 * O MESMO fechamento do PDV, e não uma cópia dele:
 *
 *   - `PagamentoDialog` divide o valor, calcula o troco, cobra na maquininha
 *     (a linha só entra com a transação aprovada), oferece o crédito de loja
 *     do cliente e o acréscimo;
 *   - o desconto é digitado aqui (R$ ou %) e passa pela MESMA alçada do
 *     balcão no servidor — acima do limite, o `AutorizacaoGerenteDialog` pede
 *     a senha do gestor e o recebimento sai de novo com a liberação;
 *   - faturar a prazo aparece só quando o dono ligou e a OS tem cliente do
 *     cadastro, que é quando o servidor aceita.
 *
 * ## A chave
 *
 * Uma por diálogo, a mesma em toda nova tentativa. Se a rede cair depois de o
 * servidor gravar, o reenvio devolve o recebimento que já aconteceu
 * (GAP-PRD-209) — o caixa não cobra duas vezes por ter clicado de novo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { Button } from './ui';
import { formatCents } from './format';
import { AutorizacaoGerenteDialog, PagamentoDialog, type PaymentLine } from './PagamentoDialog';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi } from '@/lib/api/core';
import {
  oficinaCaixaApi,
  type CorpoDoRecebimento,
  type RecebimentoDaOs,
} from '@/lib/api/oficinaCaixa';
import { descontoDoRodapeCents } from '@/pages/gs/pdvConcessao';
import { uuid } from '@/lib/uuid';
import { TentativaJaRegistrada } from './TentativaJaRegistrada';
import { ehTentativaJaRegistrada } from '@/lib/api/tentativaJaRegistrada';

/** O mínimo da OS que o recebimento precisa mostrar e cobrar. */
export interface OsParaReceber {
  id: string;
  number: number;
  customer_id: string | null;
  customer_display: string | null;
  equipment_display: string | null;
  labor_cents: number;
  parts_cents: number;
  total_cents: number;
}

export function RecebimentoOsDialog({
  os,
  cashSessionId,
  faturamentoAPrazo,
  onRecebido,
  onCancel,
}: {
  os: OsParaReceber;
  /**
   * A gaveta aberta. `undefined` = o diálogo pergunta ao servidor (a ficha da
   * OS não tem o caixa na mão); `null` = quem chamou sabe que não há gaveta.
   */
  cashSessionId?: string | null;
  /** A política do fiado da OS, como a fila do caixa a devolve. */
  faturamentoAPrazo?: { habilitado: boolean; prazoDias: number } | null;
  onRecebido: (r: RecebimentoDaOs) => void;
  onCancel: () => void;
}) {
  const chave = useRef(`os-recebimento-${uuid()}`);
  const [descontoTexto, setDescontoTexto] = useState('');
  const [etapa, setEtapa] = useState<'resumo' | 'pagamento'>('resumo');
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  /** O corpo que esperou o gestor — sai de novo, idêntico, com a liberação. */
  const [pedindoGestor, setPedindoGestor] = useState<{
    corpo: CorpoDoRecebimento;
    motivo: string;
    concedidoCents?: number;
    brutoCents?: number;
  } | null>(null);
  const [erroGestor, setErroGestor] = useState<string | null>(null);
  /**
   * O servidor recusou a chave por já ter recebido a OS com OUTRO pagamento
   * (422, R2-IDEM). A OS está paga — ver o aviso lá embaixo.
   */
  const [jaRecebida, setJaRecebida] = useState<{ saleNumber: number | null } | null>(null);

  const [gaveta, setGaveta] = useState<string | null | undefined>(cashSessionId);
  useEffect(() => {
    if (cashSessionId !== undefined) {
      setGaveta(cashSessionId);
      return;
    }
    let vivo = true;
    void coreApi
      .getOpenCash()
      .then((r) => {
        if (vivo) setGaveta(r.session?.id ?? null);
      })
      // Consulta falhou: o diálogo não inventa gaveta. Dinheiro fica recusado
      // até se saber; PIX e cartão não passam pela gaveta.
      .catch(() => {
        if (vivo) setGaveta(null);
      });
    return () => {
      vivo = false;
    };
  }, [cashSessionId]);

  const desconto = descontoDoRodapeCents(descontoTexto, os.total_cents);
  const aReceber = Math.max(0, os.total_cents - desconto);
  const podeFaturar = Boolean(faturamentoAPrazo?.habilitado && os.customer_id);

  // Esc no resumo volta a quem chamou; no pagamento, o PagamentoDialog cuida.
  useEffect(() => {
    if (etapa !== 'resumo' || pedindoGestor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [etapa, pedindoGestor, onCancel]);

  const enviar = useCallback(
    async (corpo: CorpoDoRecebimento) => {
      /*
        DINHEIRO SÓ COM GAVETA ABERTA — a regra que a ficha da OS já tinha.

        Sem a sessão, a OS sairia finalizada e as notas ficariam fora de
        qualquer fechamento. PIX e cartão não passam pela gaveta e seguem.
      */
      const temDinheiro = corpo.payments.some((p) => p.method === 'dinheiro');
      if (temDinheiro && !gaveta) {
        setErro(
          'Não há caixa aberto — o dinheiro entraria sem gaveta e o fechamento do dia daria sobra '
            + 'sem explicação. Abra o caixa, ou receba por outra forma.',
        );
        return;
      }
      setOcupado(true);
      setErro(null);
      try {
        // A gaveta aberta vai junto como no PDV: é ela que o fechamento do
        // turno confere. Sem gaveta (PIX/cartão com o caixa fechado), nulo.
        const r = await oficinaCaixaApi.receber(
          os.id,
          { ...corpo, cashSessionId: gaveta ?? null },
          chave.current,
        );
        setPedindoGestor(null);
        onRecebido(r);
      } catch (err) {
        const api = err instanceof ApiRequestError ? err : null;
        if (api?.code === 'CORE_DISCOUNT_NEEDS_AUTHORIZATION') {
          const d = (api.details ?? {}) as { concedidoCents?: number; brutoCents?: number };
          setErroGestor(null);
          setPedindoGestor({
            corpo,
            motivo: api.message,
            concedidoCents: d.concedidoCents,
            brutoCents: d.brutoCents,
          });
          return;
        }
        if (ehTentativaJaRegistrada(err)) {
          const d = err.details as { saleNumber?: unknown } | undefined;
          setJaRecebida({ saleNumber: typeof d?.saleNumber === 'number' ? d.saleNumber : null });
          return;
        }
        setErro(
          api
            ? api.message
            : 'Sem resposta do servidor. Tente de novo: este mesmo recebimento será reconhecido, '
              + 'sem cobrar duas vezes.',
        );
      } finally {
        setOcupado(false);
      }
    },
    [gaveta, os.id, onRecebido],
  );

  const autorizar = useCallback(
    async (login: string, password: string, justificativa?: string) => {
      if (!pedindoGestor) return;
      setOcupado(true);
      setErroGestor(null);
      try {
        const bilhete = await coreApi.authorize({
          action: 'desconto_acima_limite',
          login,
          password,
          concedidoCents: pedindoGestor.concedidoCents,
          brutoCents: pedindoGestor.brutoCents,
          reason:
            `Desconto de ${formatCents(pedindoGestor.concedidoCents ?? desconto)} `
            + `na OS #${os.number} (${formatCents(os.total_cents)})`,
          // O PORQUÊ digitado (P0 da Preço Justo); vazio não viaja.
          justificativa: justificativa || undefined,
        });
        const corpo = { ...pedindoGestor.corpo, authorizationId: bilhete.id };
        setPedindoGestor(null);
        await enviar(corpo);
      } catch (err) {
        setErroGestor(err instanceof ApiRequestError ? err.message : 'Não foi possível autorizar.');
      } finally {
        setOcupado(false);
      }
    },
    [pedindoGestor, desconto, os.number, os.total_cents, enviar],
  );

  const gestor = pedindoGestor && (
    <AutorizacaoGerenteDialog
      motivo={pedindoGestor.motivo}
      // O motivo aparece sempre; quem decide se é obrigatório é o servidor, e a
      // recusa dele chega pelo `error` com a frase que diz o que falta.
      justificativa={{ obrigatorio: false }}
      onConfirm={(login, password, justificativa) => void autorizar(login, password, justificativa)}
      onCancel={() => setPedindoGestor(null)}
      busy={ocupado}
      error={erroGestor}
    />
  );

  /*
    A OS QUE ESTA TENTATIVA JÁ RECEBEU, COM OUTRO PAGAMENTO (R2-IDEM).

    A resposta do primeiro envio se perdeu (o servidor recebeu, no PIX) e o
    caixa trocou para dinheiro antes de tentar de novo. Aqui não há "receber
    como novo": o 422 só chega quando a venda da chave é a venda DESTA OS
    (chave de outro documento é 409), a OS já está paga, e uma chave nova daria
    409 "não está aguardando pagamento". Oferecer o botão seria oferecer a porta
    que nunca abre — a tela diz que a OS está paga, e em qual venda.
  */
  const qualVenda = jaRecebida?.saleNumber ? `a venda #${jaRecebida.saleNumber}` : 'a venda desta OS';
  const avisoJaRecebida = jaRecebida && (
    <TentativaJaRegistrada
      titulo="Esta OS já foi recebida"
      rotuloDoVoltar="Fechar o recebimento"
      onVoltar={onCancel}
      testId="os-ja-recebida"
    >
      <p className="m-0">
        <strong>O recebimento desta OS já foi registrado em {qualVenda}, com outra forma de pagamento.</strong>{' '}
        Nada foi cobrado agora.
      </p>
      <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
        Uma OS é recebida uma vez só: confira {qualVenda} e a gaveta antes de cobrar o cliente outra vez. Se a OS
        precisa ser cobrada de outro jeito, o gerente estorna o recebimento e ela volta para a fila do caixa.
      </p>
    </TentativaJaRegistrada>
  );

  if (etapa === 'pagamento') {
    return (
      <>
        <PagamentoDialog
          totalCents={aReceber}
          customerId={os.customer_id}
          customerName={os.customer_display}
          busy={ocupado}
          error={erro}
          onCancel={() => {
            setErro(null);
            setEtapa('resumo');
          }}
          onConfirm={(payments: PaymentLine[], _troco, surchargeCents, customerCreditCents) =>
            void enviar({
              payments,
              discountCents: desconto || undefined,
              surchargeCents: surchargeCents || undefined,
              customerCreditCents: customerCreditCents || undefined,
            })
          }
        />
        {gestor}
        {avisoJaRecebida}
      </>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={`Receber OS #${os.number}`}
    >
      <div className="w-full max-w-xl rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            Receber OS #{os.number}
          </h2>
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            {[os.customer_display ?? 'Sem cliente', os.equipment_display].filter(Boolean).join(' · ')}
          </p>
        </header>

        <div className="px-6 py-5 flex flex-col gap-4">
          <table className="w-full text-[length:var(--gs-text-sm)]">
            <tbody>
              <tr>
                <td>Mão de obra</td>
                <td className="text-right tabular-nums">{formatCents(os.labor_cents)}</td>
              </tr>
              <tr>
                <td>Peças</td>
                <td className="text-right tabular-nums">{formatCents(os.parts_cents)}</td>
              </tr>
              <tr className="font-semibold">
                <td>Total da OS</td>
                <td className="text-right tabular-nums">{formatCents(os.total_cents)}</td>
              </tr>
            </tbody>
          </table>

          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Desconto (R$ ou %)
            </span>
            <input
              aria-label="Desconto da OS"
              value={descontoTexto}
              onChange={(e) => setDescontoTexto(e.target.value)}
              inputMode="decimal"
              placeholder="0,00 ou 5%"
              className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                bg-[var(--gs-surface)] text-[var(--gs-text)]"
            />
            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Passa pela mesma alçada do balcão: acima do limite do caixa, o gestor libera com a
              senha dele.
            </span>
          </label>

          <p className="m-0 flex items-baseline justify-between">
            <span className="font-semibold">A receber</span>
            <strong
              data-testid="os-a-receber-total"
              className="text-[length:var(--gs-text-lg)] tabular-nums text-[var(--gs-purple-900)]"
            >
              {formatCents(aReceber)}
            </strong>
          </p>

          {faturamentoAPrazo?.habilitado && !os.customer_id && (
            <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Faturar a prazo precisa de cliente do cadastro na OS — esta foi aberta com o nome
              digitado.
            </p>
          )}

          {erro && (
            <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
              {erro}
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Voltar (Esc)
            </Button>
            {podeFaturar && (
              <Button
                type="button"
                variant="secondary"
                loading={ocupado}
                disabled={aReceber <= 0}
                onClick={() =>
                  void enviar({ payments: [], discountCents: desconto || undefined })
                }
              >
                Faturar para {os.customer_display ?? 'o cliente'} (vence em{' '}
                {faturamentoAPrazo?.prazoDias ?? 0} dia(s))
              </Button>
            )}
            <Button
              type="button"
              loading={ocupado}
              disabled={aReceber <= 0}
              onClick={() => {
                setErro(null);
                setEtapa('pagamento');
              }}
            >
              Receber {formatCents(aReceber)}
            </Button>
          </div>
        </div>
      </div>
      {gestor}
      {avisoJaRecebida}
    </div>
  );
}
