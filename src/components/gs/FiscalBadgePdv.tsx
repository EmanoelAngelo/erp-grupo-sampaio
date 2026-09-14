/**
 * Selo fiscal do balcão: situação da operação e pendências acumuladas.
 *
 * Fica na faixa do PDV porque responde a duas perguntas que o caixa tem antes
 * e depois de cada venda: dá para emitir aqui, e há nota precisando de
 * atenção. Um alerta escondido num menu não é alerta.
 *
 * O CONTADOR SÓ CONTA O QUE PRECISA DE AÇÃO — rejeitada, contingência, envio
 * parado, fila esgotada. Contar nota autorizada transformaria o aviso em
 * ruído, e um alerta sempre aceso deixa de ser lido.
 *
 * NÃO BLOQUEIA A VENDA. A política comercial é do writer de vendas, que já foi
 * validado; mexer nele daqui seria alterar em silêncio o que já funciona.
 * Quando a emissão é impossível, o selo avisa forte — e o operador decide.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { coreApi, type FiscalPdvSummary } from '@/lib/api/core';

const SITUACAO: Record<
  FiscalPdvSummary['situacao'],
  { texto: string; classe: string; explica: string }
> = {
  READY: {
    texto: 'FISCAL OK',
    classe: 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]',
    explica: 'Emissão configurada e homologada.',
  },
  // Fixture não é homologação, e o selo não pode sugerir que seja.
  TEST_ONLY: {
    texto: 'FISCAL — SÓ TESTE',
    classe: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]',
    explica: 'A emissão funciona, mas ainda não foi homologada na SEFAZ.',
  },
  PENDING: {
    texto: 'FISCAL PENDENTE',
    classe: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]',
    explica: 'Faltam dados fiscais em produtos.',
  },
  NOT_CONFIGURED: {
    texto: 'FISCAL NÃO CONFIGURADO',
    classe: 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]',
    explica: 'Esta operação ainda não emite nota.',
  },
};

/**
 * SITUAÇÃO QUE ESTA TELA NÃO CONHECE NÃO PODE APAGAR O BALCÃO.
 *
 * A tabela acima é uma lista por complemento: o dia em que o servidor
 * ganhar uma quinta situação, `SITUACAO[situacao]` devolve `undefined` e o
 * PDV INTEIRO some da tela — o componente quebra no meio da faixa e o React,
 * sem barreira de erro nenhuma, desmonta a árvore toda. O caixa fica com uma
 * tela branca no meio do atendimento por causa de um selo informativo.
 *
 * O selo desconhecido avisa que não sabe, e a venda continua.
 */
const SITUACAO_DESCONHECIDA = {
  texto: 'FISCAL — VERIFICAR',
  classe: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]',
  explica: 'Situação fiscal não reconhecida por esta tela. Confira em Fiscal.',
};

export function FiscalBadgePdv({ recarregarEm }: { recarregarEm?: number }) {
  const [resumo, setResumo] = useState<FiscalPdvSummary | null>(null);
  const [aberto, setAberto] = useState(false);
  const navigate = useNavigate();

  const carregar = useCallback(async () => {
    try {
      setResumo(await coreApi.getFiscalPdvSummary());
    } catch {
      // Sem permissão ou API fora: o selo some em vez de gritar. O caixa não
      // pode ser interrompido por um problema que não é dele.
      setResumo(null);
    }
  }, []);

  // Recarrega quando a venda muda, não em laço próprio: um poll a mais na tela
  // mais usada da loja é custo permanente por informação que muda pouco.
  useEffect(() => {
    void carregar();
  }, [carregar, recarregarEm]);

  if (!resumo) return null;
  const s = SITUACAO[resumo.situacao] ?? SITUACAO_DESCONHECIDA;

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className={`px-2 py-1 rounded-[var(--gs-radius)] text-[length:var(--gs-text-xs)] font-bold ${s.classe}`}
        title={s.explica}
      >
        {s.texto}
      </button>

      {/* EM CONTINGÊNCIA (GAP-PRD-098): o caixa precisa saber que as NFC-e
          estão saindo off-line e que o cliente leva o DANFCE de contingência. */}
      {resumo.contingencia && (
        <span
          role="status"
          title={`${resumo.contingencia.motivoRotulo} — as NFC-e saem em contingência off-line e são transmitidas quando a SEFAZ voltar.`}
          className="px-2 py-1 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
            text-[var(--gs-warning)] text-[length:var(--gs-text-xs)] font-bold"
        >
          EM CONTINGÊNCIA — entregue o DANFCE de contingência
        </span>
      )}

      {resumo.pendencyCount > 0 && (
        <button
          type="button"
          onClick={() => navigate('/sistema/fiscal/documentos')}
          className="px-2 py-1 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[var(--gs-danger)] text-[length:var(--gs-text-xs)] font-bold"
        >
          ⚠ {resumo.pendencyCount} pendência{resumo.pendencyCount > 1 ? 's' : ''} fiscal
          {resumo.pendencyCount > 1 ? 'is' : ''}
        </button>
      )}

      {aberto && (
        <div
          role="dialog"
          aria-label="Situação fiscal da operação"
          className="absolute top-16 right-6 z-30 w-96 p-4 rounded-[var(--gs-radius)]
            bg-[var(--gs-surface)] border border-[var(--gs-border)] shadow-[var(--gs-shadow)]
            text-[var(--gs-text)]"
        >
          <p className="font-semibold m-0 mb-1">{s.texto}</p>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0 mb-3">{s.explica}</p>

          {/* Nunca "erro fiscal" genérico: o operador precisa saber o que pedir
              a quem configura. */}
          {resumo.blocking.length > 0 && (
            <ul className="list-none p-0 m-0 mb-3 flex flex-col gap-1">
              {resumo.blocking.map((b) => (
                <li key={b.key} className="text-[length:var(--gs-text-sm)]">
                  <strong>{b.label}:</strong> {b.detail}
                </li>
              ))}
            </ul>
          )}

          {resumo.pendencies.length > 0 && (
            <>
              <p className="font-semibold text-[length:var(--gs-text-sm)] m-0 mb-1">
                Notas precisando de atenção
              </p>
              <ul className="list-none p-0 m-0 flex flex-col gap-1">
                {resumo.pendencies.slice(0, 5).map((p) => (
                  <li key={p.documentId} className="text-[length:var(--gs-text-sm)]">
                    NFC-e {p.number} — {p.label}
                  </li>
                ))}
              </ul>
            </>
          )}

          <button
            type="button"
            onClick={() => setAberto(false)}
            className="mt-3 text-[length:var(--gs-text-sm)] font-semibold underline"
          >
            fechar
          </button>
        </div>
      )}
    </div>
  );
}
