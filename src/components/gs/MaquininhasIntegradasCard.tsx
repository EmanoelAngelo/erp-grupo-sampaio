/**
 * Maquininhas integradas da operação — ligar e desligar (GAP-PRD-001).
 *
 * O QUE FALTAVA
 *
 * Não existia tela nem rota para desligar uma configuração de maquininha. O
 * banco real da Preço Justo tem uma `mock` (maquininha de TESTE) ligada: fora
 * de produção ela aprova cartão sem dinheiro trocar de mãos; em produção o
 * servidor a ignora e o balcão lança o cartão à mão — mas ela continua
 * gravada. A única saída era alguém abrir o SQLite.
 *
 * O QUE O GESTOR FAZ AQUI
 *
 * - Vê cada maquininha da operação: ligada ou desligada, de TESTE ou não, e se
 *   este ambiente a está ignorando.
 * - Desliga, com motivo — sempre pode, em qualquer ambiente. Desligar tira a
 *   exigência de cobrança aprovada no cartão, e por isso o motivo fica na
 *   auditoria com o nome de quem decidiu.
 * - Religa, com motivo. O servidor recusa religar a de TESTE em produção, e a
 *   mensagem dele aparece aqui como veio.
 *
 * Mora na página da conferência porque é o mesmo público (gerentes) e o mesmo
 * assunto: o que a maquininha diz sobre o dinheiro da loja.
 */
import { useCallback, useEffect, useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { Badge, Button, Card, EmptyState, Input } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { dataHoraBR } from '@/lib/datas';
import {
  maquininhasApi,
  type ConfiguracaoDeMaquininha,
  type MaquininhasDaOperacao,
} from '@/lib/api/maquininhas';

type Acao = { config: ConfiguracaoDeMaquininha; ligar: boolean };

export function MaquininhasIntegradasCard() {
  const [dados, setDados] = useState<MaquininhasDaOperacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [acao, setAcao] = useState<Acao | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setDados(await maquininhasApi.listar());
    } catch (err) {
      // Nulo de propósito: "nenhuma maquininha" depois de uma falha faria o
      // gestor concluir que não há nada ligado quando ele só não conseguiu ver.
      setDados(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar as maquininhas.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const ligadasDeTeste = (dados?.items ?? []).filter((c) => c.active && c.simulated);

  return (
    <Card
      title="Maquininhas integradas nesta operação"
      subtitle="Ligada, o cartão passa pelo aparelho e só entra na venda com a cobrança aprovada. Desligada, o cartão volta a ser lançado à mão contra o comprovante da maquininha avulsa."
    >
      {aviso && (
        <div
          role="status"
          className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {aviso}
        </div>
      )}
      {erro && (
        <div
          role="alert"
          className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}

      {ligadasDeTeste.length > 0 && (
        <div
          role="alert"
          aria-label="Maquininha de teste ligada"
          className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] text-[length:var(--gs-text-sm)]"
        >
          <strong>Maquininha de TESTE ligada.</strong>{' '}
          {dados?.environmentBlocksTestProvider
            ? `Este ambiente (${dados.environmentBlocksTestProvider}) a ignora e o balcão lança o cartão à mão — mas ela continua gravada. Desligue antes do go-live.`
            : 'Ela aprova cartão SEM dinheiro trocar de mãos. Use só para ensaio; desligue antes de vender de verdade.'}
        </div>
      )}

      {dados === null ? (
        <p role="status" className="text-[var(--gs-muted)]">
          {erro ? 'Não foi possível listar as maquininhas.' : 'Carregando…'}
        </p>
      ) : dados.items.length === 0 ? (
        <EmptyState
          title="Nenhuma maquininha integrada"
          description="O cartão desta operação é lançado à mão, contra o comprovante da maquininha avulsa da adquirente."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[length:var(--gs-text-sm)]">
            <thead>
              <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                <th className="py-2.5 pr-4 font-semibold">Maquininha</th>
                <th className="py-2.5 pr-4 font-semibold">Provedor</th>
                <th className="py-2.5 pr-4 font-semibold">Situação</th>
                <th className="py-2.5 font-semibold text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              {dados.items.map((c) => (
                <tr key={c.id} className="border-b border-[var(--gs-border)] last:border-0 align-top">
                  <td className="py-3 pr-4">
                    <div className="font-semibold">{c.displayName || c.terminalIdentifier || c.id}</div>
                    <div className="font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{c.id}</div>
                  </td>
                  <td className="py-3 pr-4">
                    <span className="mr-2">{c.provider}</span>
                    {c.simulated && <Badge tone="warning">TESTE — simulada</Badge>}
                  </td>
                  <td className="py-3 pr-4">
                    {c.active ? (
                      c.blockedInThisEnvironment ? (
                        <Badge tone="warning">Ligada, ignorada neste ambiente</Badge>
                      ) : (
                        <Badge tone="success">Ligada</Badge>
                      )
                    ) : (
                      <Badge tone="neutral">Desligada</Badge>
                    )}
                    {!c.active && c.deactivationReason && (
                      <div className="mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                        Desligada em {dataHoraBR(c.deactivatedAt)} — {c.deactivationReason}
                      </div>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    {c.active ? (
                      <Button size="sm" variant="danger" onClick={() => setAcao({ config: c, ligar: false })}>
                        Desligar
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => setAcao({ config: c, ligar: true })}>
                        Religar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {acao && (
        <DialogoDeMotivo
          acao={acao}
          onClose={() => setAcao(null)}
          onDone={(texto) => {
            setAcao(null);
            setAviso(texto);
            void carregar();
          }}
        />
      )}
    </Card>
  );
}

function DialogoDeMotivo({
  acao,
  onClose,
  onDone,
}: {
  acao: Acao;
  onClose: () => void;
  onDone: (texto: string) => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const nome = acao.config.displayName || acao.config.terminalIdentifier || acao.config.id;

  const confirmar = useCallback(async () => {
    setOcupado(true);
    setErro(null);
    try {
      if (acao.ligar) await maquininhasApi.religar(acao.config.id, motivo);
      else await maquininhasApi.desligar(acao.config.id, motivo);
      onDone(
        acao.ligar
          ? `Maquininha "${nome}" religada. O cartão volta a exigir a cobrança aprovada no aparelho.`
          : `Maquininha "${nome}" desligada. O cartão passa a ser lançado à mão contra o comprovante.`,
      );
    } catch (err) {
      // A recusa do servidor (religar a de TESTE em produção, motivo vazio,
      // já desligada) aparece como veio — é ela que diz o que fazer.
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao registrar.');
    } finally {
      setOcupado(false);
    }
  }, [acao, motivo, nome, onDone]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={acao.ligar ? 'Religar maquininha' : 'Desligar maquininha'}
    >
      <div className="w-full max-w-xl rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            {acao.ligar ? 'Religar' : 'Desligar'} — {nome}
          </h2>
        </header>
        <div className="px-6 py-5 flex flex-col gap-4">
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            {acao.ligar
              ? 'Religada, o cartão desta operação volta a passar pelo aparelho e só entra na venda com a cobrança aprovada.'
              : 'Desligada, o cartão desta operação deixa de exigir a cobrança no aparelho e volta a ser lançado à mão. O registro fica na auditoria com o seu nome.'}
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Motivo
            </span>
            <Input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={
                acao.ligar ? 'Ex.: aparelho novo instalado e testado' : 'Ex.: maquininha de teste esquecida no cadastro'
              }
            />
          </label>
          {erro && (
            <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              variant={acao.ligar ? 'primary' : 'danger'}
              loading={ocupado}
              disabled={!motivo.trim()}
              onClick={() => void confirmar()}
            >
              {acao.ligar ? 'Religar' : 'Desligar'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
