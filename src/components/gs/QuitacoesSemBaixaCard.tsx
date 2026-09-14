/**
 * QUITAÇÕES ANTIGAS SEM BAIXA — o cartão da decisão (GAP-PRD-171).
 *
 * Antes do V29, o que nascia quitado (a fatia à vista da venda) não ganhava
 * linha de baixa. A conciliação bancária casa extrato com BAIXA, então esses
 * recebimentos ficam invisíveis para ela: o depósito de agosto aparece como
 * "no extrato, sem baixa" e não há o que sugerir.
 *
 * Criar a baixa que falta é DECISÃO — muda o que a conferência de um mês já
 * vivido mostra. O cartão só aparece quando há o que decidir, diz quanto é e
 * desde quando, e cria sob confirmação: com a data da quitação original, sem
 * mexer em saldo, resumo nem resultado do período.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { baixasLegadasApi, type QuitacoesSemBaixa } from '@/lib/api/baixasLegadas';
import { dataBR } from '@/lib/datas';

export function QuitacoesSemBaixaCard({ onCriou }: { onCriou?: () => void | Promise<void> }) {
  const [dados, setDados] = useState<QuitacoesSemBaixa | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      setDados(await baixasLegadasApi.listar());
    } catch {
      // O cartão é auxiliar: sem ele, a conciliação continua inteira.
      setDados(null);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const criar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      const r = await baixasLegadasApi.criarEspelhos();
      setConfirmando(false);
      setAviso(
        r.created > 0
          ? `${r.created} baixa(s)-espelho criada(s), somando ${formatCents(r.totalCents)}. Elas já aparecem nas sugestões da conciliação.`
          : 'Nada a criar: as quitações já tinham baixa.',
      );
      await carregar();
      await onCriou?.();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível criar as baixas-espelho.');
    } finally {
      setOcupado(false);
    }
  };

  if (aviso && dados && dados.count === 0) {
    return (
      <p role="status" className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">
        {aviso}
      </p>
    );
  }
  if (!dados || dados.count === 0) return null;

  const total = dados.inCents + dados.outCents;
  const primeira = dados.items.reduce((m, i) => (i.mirrorDate < m ? i.mirrorDate : m), dados.items[0].mirrorDate);

  return (
    <Card
      title="Quitações antigas sem baixa"
      subtitle="Lançamentos quitados antes de o sistema registrar cada baixa. A conciliação bancária não os enxerga."
    >
      <div className="flex flex-col gap-3 text-[length:var(--gs-text-sm)]">
        <p className="m-0">
          <strong>{dados.count}</strong> lançamento(s) quitado(s) desde {dataBR(primeira)} somam{' '}
          <strong>{formatCents(total)}</strong> ({formatCents(dados.inCents)} recebidos,{' '}
          {formatCents(dados.outCents)} pagos) sem nenhuma baixa. O depósito deles no extrato aparece
          como “no extrato, sem baixa”, e a tela não tem o que sugerir.
        </p>
        <details>
          <summary className="cursor-pointer text-[var(--gs-purple-700)] font-semibold">Ver quais são</summary>
          <ul className="m-0 mt-2 pl-5">
            {dados.items.map((i) => (
              <li key={i.id}>
                {dataBR(i.mirrorDate)} · {i.description} · {i.direction === 'in' ? 'recebido' : 'pago'}{' '}
                {formatCents(i.missingCents)}
                {i.explainedCents > 0 && ` (de ${formatCents(i.settledCents)}; o resto já tem baixa)`}
              </li>
            ))}
          </ul>
        </details>
        <p className="m-0 text-[var(--gs-muted)]">
          Criar a baixa-espelho de cada um é decisão de quem responde pelo caixa: ela nasce com a data
          da quitação original, a forma de pagamento do lançamento e a nota “migração”, e passa a
          aparecer na conciliação dos meses antigos. Saldo das contas, resumo e resultado do período
          não mudam — o dinheiro já estava quitado.
        </p>
        {erro && (
          <p role="alert" className="m-0 text-[var(--gs-danger)]">
            {erro}
          </p>
        )}
        {confirmando ? (
          <div
            role="alertdialog"
            aria-label="Criar as baixas-espelho?"
            className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]"
          >
            <span className="text-[var(--gs-warning)] font-semibold">
              Criar {dados.count} baixa(s)-espelho, somando {formatCents(total)}, com a data da quitação
              original?
            </span>
            <Button size="sm" variant="ghost" onClick={() => setConfirmando(false)}>
              Agora não
            </Button>
            <Button size="sm" loading={ocupado} onClick={() => void criar()}>
              Criar as baixas
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="secondary" size="sm" onClick={() => setConfirmando(true)}>
              Criar as baixas-espelho
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
