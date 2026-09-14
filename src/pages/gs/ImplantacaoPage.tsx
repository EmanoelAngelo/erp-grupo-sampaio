/**
 * Implantação — como esta instalação está publicada (GAP-PRD-013).
 *
 * A publicação estava inteira por conta de quem instala, sem exemplo e sem
 * conferência: a única forma de saber se o sistema estava no ar do jeito certo
 * era ler o `DEPLOY.md` e conferir de cabeça. Nesta máquina, a auditoria achou
 * o acesso sem senha ligado e nenhum ambiente declarado.
 *
 * Esta tela pergunta ao servidor e mostra, item por item, com quatro estados:
 *
 *   BLOQUEIA  não vá ao ar assim;
 *   ATENÇÃO   funciona, mas não é o que produção deve ser;
 *   INFO      escolha que não dá para conferir daqui;
 *   OK        conferido.
 *
 * O que só a API no ar sabe também está aqui: se esta página chegou por HTTPS
 * e se há quem levante a API quando ela cair. Nenhum segredo aparece — o
 * servidor manda nomes de variável, nunca valores.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  conferirImplantacao,
  type ConferenciaDaImplantacao,
  type EstadoDaImplantacao,
} from '@/lib/api/implantacao';
import { dataHoraBR } from '@/lib/datas';

const ESTADO: Record<EstadoDaImplantacao, { rotulo: string; tom: 'success' | 'info' | 'warning' | 'danger'; ordem: number }> = {
  BLOQUEIA: { rotulo: 'BLOQUEIA', tom: 'danger', ordem: 0 },
  ATENCAO: { rotulo: 'ATENÇÃO', tom: 'warning', ordem: 1 },
  INFO: { rotulo: 'INFO', tom: 'info', ordem: 2 },
  OK: { rotulo: 'OK', tom: 'success', ordem: 3 },
};

export default function ImplantacaoPage() {
  const [conferencia, setConferencia] = useState<ConferenciaDaImplantacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setConferencia(await conferirImplantacao());
      setErro(null);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao conferir a implantação.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // O que bloqueia vem primeiro: é o que a pessoa veio procurar.
  const itens = conferencia
    ? [...conferencia.itens].sort((a, b) => ESTADO[a.estado].ordem - ESTADO[b.estado].ordem)
    : [];

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Implantação']}
        title="Implantação"
        subtitle="Como esta instalação está publicada: telas, HTTPS, quem levanta a API e onde ficam os dados."
        actions={
          <Button variant="secondary" onClick={() => void carregar()} disabled={carregando}>
            {carregando ? 'Conferindo…' : 'Conferir de novo'}
          </Button>
        }
      />

      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}

      {conferencia && (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <Badge tone={conferencia.pronto ? 'success' : 'danger'}>
                {conferencia.pronto ? 'NADA BLOQUEIA' : 'NÃO VÁ AO AR ASSIM'}
              </Badge>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {conferencia.resumo.BLOQUEIA} bloqueia · {conferencia.resumo.ATENCAO} atenção ·{' '}
                {conferencia.resumo.INFO} informativo(s) · {conferencia.resumo.OK} ok
              </span>
            </div>
            <p className="m-0 text-[length:var(--gs-text-sm)]">
              {conferencia.pronto
                ? conferencia.resumo.ATENCAO > 0
                  ? 'Nada impede a operação. Os itens em atenção são o que falta para a publicação ficar como produção deve ser.'
                  : 'A publicação está como produção deve ser.'
                : 'Há item que impede ir ao ar — ou que faria o servidor recusar subir. Resolva os marcados como BLOQUEIA.'}
            </p>
            <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Conferido em {dataHoraBR(conferencia.conferidoEm)}. A API lê o <code>.env</code> só ao subir:
              depois de mudar o arquivo, reinicie o serviço e confira de novo.
            </p>
          </Card>

          <ul className="list-none p-0 mt-5 mb-0 grid gap-3" aria-label="Itens da conferência">
            {itens.map((item) => (
              <li key={item.id} data-testid={`item-${item.id}`}>
                <Card>
                  <div className="flex flex-wrap items-center gap-3 mb-1">
                    <Badge tone={ESTADO[item.estado].tom}>{ESTADO[item.estado].rotulo}</Badge>
                    <strong>{item.titulo}</strong>
                  </div>
                  <p className="m-0 text-[length:var(--gs-text-sm)]">{item.detalhe}</p>
                  {item.comoResolver && item.estado !== 'OK' && (
                    <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      Como resolver: {item.comoResolver}
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>

          <p className="mt-5 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            O mesmo roteiro roda antes de subir, no servidor:{' '}
            <code>node server/dist/scripts/conferir-implantacao.js</code>. Os exemplos de publicação
            (HTTPS com Caddy ou nginx, serviço do Windows, unidade do Linux) estão na pasta{' '}
            <code>deploy/</code> do sistema.
          </p>
        </>
      )}
    </AppShell>
  );
}
