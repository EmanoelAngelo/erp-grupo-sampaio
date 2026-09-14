/**
 * A CONTINGÊNCIA DA NFC-e NA TELA DE DOCUMENTOS — GAP-PRD-098.
 *
 * A contingência era "fundação": sem modalidade, sem período, e só saía por
 * uma rota sem botão. Este quadro mostra e decide, cada coisa com quem decide:
 *
 *  - a MODALIDADE (aguardar a SEFAZ, o padrão seguro, ou NFC-e off-line com
 *    tpEmis 9) e o PRAZO de transmissão — decisão do CONTADOR, gravada pelo
 *    dono (para o gerente, a gravação responde 403 e a tela diz por quê);
 *  - o PERÍODO: aberto sozinho quando a SEFAZ cai (ou pela gerência, com a
 *    justificativa que vai no xJust de cada nota), fechado sozinho quando ela
 *    volta (ou pela gerência) — com a última resposta da SEFAZ;
 *  - as notas off-line ainda sem autorização e o prazo mais próximo.
 *
 * O caixa não vê o quadro (403 some com ele): no balcão, ele vê o selo de
 * contingência e o DANFCE de contingência da venda.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Field, Input } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  contingenciaFiscalApi,
  type ModoDeContingencia,
  type PainelDaContingencia,
} from '@/lib/api/contingenciaFiscal';
import { dataHoraBR } from '@/lib/datas';

export function ContingenciaFiscalCard({ onMudou }: { onMudou?: () => void | Promise<void> }) {
  const [painel, setPainel] = useState<PainelDaContingencia | null>(null);
  const [semAcesso, setSemAcesso] = useState(false);
  const [modo, setModo] = useState<ModoDeContingencia>('AGUARDAR');
  const [prazo, setPrazo] = useState('');
  const [observacao, setObservacao] = useState('');
  const [justificativa, setJustificativa] = useState('');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const aplicar = useCallback((p: PainelDaContingencia) => {
    setPainel(p);
    setModo(p.politica.modo);
    setPrazo(p.politica.prazoHoras ? String(p.politica.prazoHoras) : '');
    setObservacao(p.politica.observacao ?? '');
  }, []);

  const carregar = useCallback(async () => {
    try {
      aplicar(await contingenciaFiscalApi.painel());
      setSemAcesso(false);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) {
        setSemAcesso(true);
        return;
      }
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível consultar a contingência.');
    }
  }, [aplicar]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const agir = useCallback(
    async (nome: string, acao: () => Promise<PainelDaContingencia>, sucesso: string) => {
      setOcupado(nome);
      setErro(null);
      setAviso(null);
      try {
        aplicar(await acao());
        setAviso(sucesso);
        await onMudou?.();
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 403 && nome === 'politica') {
          setErro('Só os donos do grupo gravam a modalidade — ela é decisão do contador.');
        } else {
          setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível concluir.');
        }
      } finally {
        setOcupado(null);
      }
    },
    [aplicar, onMudou],
  );

  if (semAcesso) return null;
  if (!painel) {
    return erro ? (
      <Card title="Contingência da NFC-e">
        <p role="alert" className="m-0 text-[var(--gs-danger)]">
          {erro}
        </p>
      </Card>
    ) : null;
  }

  const { politica, periodo, notasOffline } = painel;
  const offline = politica.modo === 'OFFLINE_NFCE';
  const decidida = politica.atualizadoEm !== null;
  const prazoNumero = Number(prazo);
  const politicaMudou =
    modo !== politica.modo
    || (modo === 'OFFLINE_NFCE' && prazoNumero !== (politica.prazoHoras ?? 0))
    || observacao !== (politica.observacao ?? '');
  const prazoValido = modo === 'AGUARDAR' || (Number.isInteger(prazoNumero) && prazoNumero >= 1 && prazoNumero <= 168);

  return (
    <Card
      title="Contingência da NFC-e"
      subtitle={
        offline
          ? `Com a SEFAZ fora, a NFC-e sai em contingência off-line (tpEmis 9) e é transmitida em até ${politica.prazoHoras} h.`
          : 'Com a SEFAZ fora, a NFC-e espera na fila e é transmitida sozinha quando o serviço volta.'
      }
    >
      <div className="flex flex-col gap-4">
        {periodo ? (
          <div
            role="status"
            className="px-4 py-3 rounded-[var(--gs-radius)] border-2 border-[var(--gs-warning)]
              bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] flex flex-col gap-1"
          >
            <strong>EM CONTINGÊNCIA desde {dataHoraBR(periodo.iniciadoEm)}</strong>
            <span className="text-[length:var(--gs-text-sm)]">
              {periodo.motivoRotulo}
              {periodo.codigoDoGatilho ? ` (cStat ${periodo.codigoDoGatilho})` : ''} ·{' '}
              {periodo.origem === 'AUTOMATICA' ? 'aberta automaticamente' : 'aberta pela gerência'}
            </span>
            <span className="text-[length:var(--gs-text-sm)]">Justificativa nas notas: {periodo.justificativa}</span>
            {periodo.ultimaSondagemEm && (
              <span className="text-[length:var(--gs-text-sm)]">
                Última verificação da SEFAZ: {dataHoraBR(periodo.ultimaSondagemEm)}
                {periodo.ultimaSondagemCStat ? ` — cStat ${periodo.ultimaSondagemCStat}` : ''}
                {periodo.ultimaSondagemMotivo ? `: ${periodo.ultimaSondagemMotivo}` : ''}. O período fecha
                sozinho quando ela responder.
              </span>
            )}
            <div className="mt-2">
              <Button
                size="sm"
                variant="ghost"
                loading={ocupado === 'sair'}
                onClick={() =>
                  void agir(
                    'sair',
                    () => contingenciaFiscalApi.sair(),
                    'Contingência encerrada: a próxima NFC-e sai normal, e as off-line vão para a fila.',
                  )
                }
              >
                Encerrar contingência
              </Button>
            </div>
          </div>
        ) : (
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Fora de contingência.</p>
        )}

        {notasOffline.pendentes > 0 && (
          <p className="m-0 text-[length:var(--gs-text-sm)]">
            <Badge tone="warning">{notasOffline.pendentes} NFC-e off-line pendente(s)</Badge>{' '}
            {notasOffline.prazoMaisProximo
              ? `A primeira precisa chegar à SEFAZ até ${dataHoraBR(notasOffline.prazoMaisProximo)}.`
              : ''}
          </p>
        )}

        {offline && !periodo && (
          <div className="flex flex-col gap-2">
            <Field
              label="Justificativa para entrar em contingência"
              hint="15 a 256 caracteres — vai dentro de cada NFC-e do período (xJust)."
            >
              {(p) => (
                <Input {...p} value={justificativa} onChange={(e) => setJustificativa(e.target.value)} />
              )}
            </Field>
            <div>
              <Button
                size="sm"
                variant="ghost"
                disabled={justificativa.trim().length < 15}
                loading={ocupado === 'entrar'}
                onClick={() =>
                  void agir(
                    'entrar',
                    () => contingenciaFiscalApi.entrar(justificativa),
                    'Em contingência: as próximas NFC-e saem off-line, com o DANFCE de contingência.',
                  )
                }
              >
                Entrar em contingência
              </Button>
            </div>
          </div>
        )}

        <fieldset className="flex flex-col gap-3 border-0 p-0 m-0 pt-3 border-t border-[var(--gs-border)]">
          <legend className="font-semibold text-[length:var(--gs-text-sm)] mb-2">
            Modalidade — decisão do contador{decidida ? '' : ' (ainda não decidida)'}
          </legend>
          {!decidida && (
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
              Enquanto o contador não decidir, vale aguardar a SEFAZ: o cliente sai sem DANFCE quando ela cai.
            </p>
          )}
          <label className="flex gap-3 items-start cursor-pointer">
            <input
              type="radio"
              name="modalidade-contingencia"
              checked={modo === 'AGUARDAR'}
              onChange={() => setModo('AGUARDAR')}
            />
            <span className="flex flex-col">
              <strong>Aguardar a SEFAZ (padrão)</strong>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                A nota espera na fila; nada sai com tpEmis 9.
              </span>
            </span>
          </label>
          <label className="flex gap-3 items-start cursor-pointer">
            <input
              type="radio"
              name="modalidade-contingencia"
              checked={modo === 'OFFLINE_NFCE'}
              onChange={() => setModo('OFFLINE_NFCE')}
            />
            <span className="flex flex-col">
              <strong>NFC-e em contingência off-line (tpEmis 9)</strong>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Com a SEFAZ fora, a nota é emitida off-line e o cliente leva o DANFCE de contingência.
              </span>
            </span>
          </label>
          {modo === 'OFFLINE_NFCE' && (
            <Field
              label="Prazo de transmissão (horas)"
              required
              hint="O que o contador confirmou para a UF. Sem prazo, a modalidade não liga."
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={1}
                  max={168}
                  value={prazo}
                  onChange={(e) => setPrazo(e.target.value)}
                />
              )}
            </Field>
          )}
          <Field label="Observação (ex.: quem confirmou e quando)">
            {(p) => <Input {...p} value={observacao} onChange={(e) => setObservacao(e.target.value)} />}
          </Field>
          {politica.atualizadoEm && (
            <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
              Gravado em {dataHoraBR(politica.atualizadoEm)}.
            </p>
          )}
          <div>
            <Button
              size="sm"
              disabled={!politicaMudou || !prazoValido}
              loading={ocupado === 'politica'}
              onClick={() =>
                void agir(
                  'politica',
                  () =>
                    contingenciaFiscalApi.gravarPolitica({
                      modo,
                      prazoHoras: modo === 'OFFLINE_NFCE' ? prazoNumero : null,
                      observacao,
                    }),
                  'Modalidade gravada.',
                )
              }
            >
              Gravar modalidade
            </Button>
          </div>
        </fieldset>

        {aviso && (
          <p
            role="status"
            className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-info)]"
          >
            {aviso}
          </p>
        )}
        {erro && (
          <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {erro}
          </p>
        )}
      </div>
    </Card>
  );
}
