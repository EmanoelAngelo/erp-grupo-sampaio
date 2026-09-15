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
 *
 * ## O QUE MUDOU NA AUDITORIA P0 DA PREÇO JUSTO
 *
 * "FISCAL NÃO CONFIGURADO — Esta operação ainda não emite nota." era tudo o
 * que o caixa lia. O motivo (A1 sem a senha guardada, CSC não gravado) só
 * aparecia num clique que ninguém sabia que existia, e em texto de quem
 * configura. Agora o selo carrega a frase do servidor — o que falta e quem
 * resolve —, a lista item a item com o lugar onde o administrador resolve, e
 * se confere de novo sozinho: a configuração muda no painel administrativo,
 * fora do balcão, e o selo esperava a próxima venda para descobrir.
 *
 * O PDV SÓ CONSULTA. Nada aqui mostra senha, arquivo, CSC ou titular do
 * certificado: o servidor manda só o texto do balcão.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiRequestError } from '@/lib/api/client';
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

/**
 * O SERVIDOR NÃO RESPONDEU — e isso não é "tudo certo".
 *
 * O selo sumia em qualquer falha, e o balcão sem selo parece o balcão sem
 * problema. Sem resposta, ninguém aqui sabe se a nota vai sair: a venda fica
 * registrada, mas NFC-e só é autorizada com o servidor e a SEFAZ no ar.
 * Venda registrada off-line não é nota autorizada, e o selo diz isso.
 */
const SEM_RESPOSTA = {
  texto: 'FISCAL — SEM RESPOSTA',
  classe: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]',
  explica:
    'Não foi possível consultar a situação fiscal agora. Enquanto isso, nenhuma NFC-e é '
    + 'autorizada: a venda fica registrada e a nota espera a conexão voltar.',
};

/** Em homologação a nota não vale como documento fiscal — o selo não esconde isso. */
const HOMOLOGACAO = {
  texto: 'FISCAL — HOMOLOGAÇÃO',
  classe: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]',
  explica: 'A NFC-e está em HOMOLOGAÇÃO (teste): a nota emitida aqui não tem valor fiscal.',
};

/**
 * De quanto em quanto tempo o selo se confere sozinho.
 *
 * Cinco minutos, e não um laço curto: a tela mais usada da loja não pode
 * carregar um poll caro. O que traz a resposta rápida é conferir de novo
 * quando a janela volta ao foco — que é quando o caixa volta do painel
 * administrativo — e o botão "Conferir de novo".
 */
const INTERVALO_MS = 5 * 60_000;

const QUEM_RESOLVE: Record<string, string> = {
  administrador: 'o administrador',
  contador: 'o contador',
  SEFAZ: 'a SEFAZ',
};

function horaDe(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function FiscalBadgePdv({ recarregarEm }: { recarregarEm?: number }) {
  const [resumo, setResumo] = useState<FiscalPdvSummary | null>(null);
  const [semResposta, setSemResposta] = useState(false);
  const [conferindo, setConferindo] = useState(false);
  const [aberto, setAberto] = useState(false);
  const navigate = useNavigate();

  const carregar = useCallback(async () => {
    setConferindo(true);
    try {
      setResumo(await coreApi.getFiscalPdvSummary());
      setSemResposta(false);
    } catch (err) {
      setResumo(null);
      // Sem permissão: o assunto não é deste perfil, e o selo some. Qualquer
      // outra falha é "não sei" — e o selo diz que não sabe.
      const semPermissao = err instanceof ApiRequestError && (err.status === 401 || err.status === 403);
      setSemResposta(!semPermissao);
    } finally {
      setConferindo(false);
    }
  }, []);

  // Recarrega quando a venda muda.
  useEffect(() => {
    void carregar();
  }, [carregar, recarregarEm]);

  // E quando a janela volta ao foco, e a cada cinco minutos: a configuração
  // fiscal muda no painel administrativo, fora do balcão.
  useEffect(() => {
    const aoVoltar = () => {
      if (document.visibilityState !== 'hidden') void carregar();
    };
    window.addEventListener('focus', aoVoltar);
    document.addEventListener('visibilitychange', aoVoltar);
    const relogio = window.setInterval(() => void carregar(), INTERVALO_MS);
    return () => {
      window.removeEventListener('focus', aoVoltar);
      document.removeEventListener('visibilitychange', aoVoltar);
      window.clearInterval(relogio);
    };
  }, [carregar]);

  if (!resumo && !semResposta) return null;

  if (!resumo) {
    return (
      <button
        type="button"
        onClick={() => void carregar()}
        disabled={conferindo}
        className={`px-2 py-1 rounded-[var(--gs-radius)] text-[length:var(--gs-text-xs)] font-bold ${SEM_RESPOSTA.classe}`}
        title={SEM_RESPOSTA.explica}
      >
        {SEM_RESPOSTA.texto}
      </button>
    );
  }

  const base = SITUACAO[resumo.situacao] ?? SITUACAO_DESCONHECIDA;
  const emHomologacao =
    resumo.ambiente === 'homologation' && (resumo.situacao === 'READY' || resumo.situacao === 'TEST_ONLY');
  const s = emHomologacao ? HOMOLOGACAO : base;
  const explica = resumo.resumo ?? s.explica;

  // O formato antigo (sem `faltas`) continua sendo lido: servidor e tela não
  // sobem sempre juntos, e um selo que quebra por campo ausente derruba o PDV.
  const faltas =
    resumo.faltas
    ?? (resumo.blocking ?? []).map((b) => ({
      key: b.key,
      label: b.label,
      texto: b.detail ?? '',
      quemResolve: null as string | null,
      onde: null as string | null,
    }));
  const pendencias = resumo.pendencies ?? [];
  const pendencyCount = resumo.pendencyCount ?? pendencias.length;
  const conferidoAs = horaDe(resumo.verificadoEm);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className={`px-2 py-1 rounded-[var(--gs-radius)] text-[length:var(--gs-text-xs)] font-bold ${s.classe}`}
        title={explica}
        aria-expanded={aberto}
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

      {pendencyCount > 0 && (
        <button
          type="button"
          onClick={() => navigate('/sistema/fiscal/documentos')}
          className="px-2 py-1 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[var(--gs-danger)] text-[length:var(--gs-text-xs)] font-bold"
        >
          ⚠ {pendencyCount} pendência{pendencyCount > 1 ? 's' : ''} fiscal
          {pendencyCount > 1 ? 'is' : ''}
        </button>
      )}

      {aberto && (
        <div
          role="dialog"
          aria-label="Situação fiscal da operação"
          className="absolute top-16 right-6 z-30 w-96 max-w-[calc(100vw-2rem)] p-4 rounded-[var(--gs-radius)]
            bg-[var(--gs-surface)] border border-[var(--gs-border)] shadow-[var(--gs-shadow)]
            text-[var(--gs-text)]"
        >
          <p className="font-semibold m-0 mb-1">{s.texto}</p>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0 mb-3">{explica}</p>

          {/* Nunca "erro fiscal" genérico: o operador precisa saber o que pedir
              e a quem. */}
          {faltas.length > 0 && (
            <ul className="list-none p-0 m-0 mb-3 flex flex-col gap-2">
              {faltas.map((f) => (
                <li key={f.key} className="text-[length:var(--gs-text-sm)]">
                  <strong>{f.label}:</strong> {f.texto}
                  {f.quemResolve && (
                    <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                      Quem resolve: {QUEM_RESOLVE[f.quemResolve] ?? f.quemResolve}
                      {f.onde ? ` — ${f.onde}` : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {pendencias.length > 0 && (
            <>
              <p className="font-semibold text-[length:var(--gs-text-sm)] m-0 mb-1">
                Notas precisando de atenção
              </p>
              <ul className="list-none p-0 m-0 flex flex-col gap-1">
                {pendencias.slice(0, 5).map((p) => (
                  <li key={p.documentId} className="text-[length:var(--gs-text-sm)]">
                    NFC-e {p.number} — {p.label}
                  </li>
                ))}
              </ul>
            </>
          )}

          {conferidoAs && (
            <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] m-0 mt-3">
              Conferido às {conferidoAs}.
            </p>
          )}

          <div className="mt-3 flex gap-4">
            <button
              type="button"
              onClick={() => void carregar()}
              disabled={conferindo}
              className="text-[length:var(--gs-text-sm)] font-semibold underline"
            >
              {conferindo ? 'Conferindo…' : 'Conferir de novo'}
            </button>
            <button
              type="button"
              onClick={() => setAberto(false)}
              className="text-[length:var(--gs-text-sm)] font-semibold underline"
            >
              fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
