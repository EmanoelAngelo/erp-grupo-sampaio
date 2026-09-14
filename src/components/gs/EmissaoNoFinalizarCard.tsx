/**
 * A DECISÃO DO DONO: a NFC-e sai sozinha no Finalizar? (GAP-PRD-163)
 *
 * - MANUAL (padrão): o Finalizar não emite; o painel fiscal do PDV oferece
 *   "emitir NFC-e" quando a venda está pronta. É o que a loja opera hoje.
 * - AUTOMÁTICA: ao Finalizar, se a venda está pronta para emitir (a mesma
 *   régua do botão), a NFC-e é emitida sozinha, sem atrasar o balcão. Venda
 *   que não está pronta sai sem nota e o painel diz o que falta.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  emissaoNoFinalizarApi,
  type ModoDaNfceNoFinalizar,
  type PoliticaDeEmissao,
} from '@/lib/api/emissaoNoFinalizar';
import { dataHoraBR } from '@/lib/datas';

export function EmissaoNoFinalizarCard() {
  const [politica, setPolitica] = useState<PoliticaDeEmissao | null>(null);
  const [escolha, setEscolha] = useState<ModoDaNfceNoFinalizar | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [gravando, setGravando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const atual = await emissaoNoFinalizarApi.ler();
      setPolitica(atual);
      setEscolha(atual.modo);
      setErro(null);
    } catch (err) {
      setPolitica(null);
      setErro(
        err instanceof ApiRequestError ? err.message : 'Não foi possível ler como a NFC-e sai no Finalizar.',
      );
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const gravar = useCallback(async () => {
    if (!escolha) return;
    setGravando(true);
    setErro(null);
    setAviso(null);
    try {
      await emissaoNoFinalizarApi.gravar(escolha);
      setAviso(
        escolha === 'AUTOMATICA'
          ? 'Gravado: a NFC-e passa a sair sozinha no Finalizar, quando a venda estiver pronta para emitir.'
          : 'Gravado: a NFC-e sai pelo botão do painel fiscal do PDV, depois do Finalizar.',
      );
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao gravar a escolha.');
    } finally {
      setGravando(false);
    }
  }, [escolha, carregar]);

  const mudou = politica !== null && escolha !== null && escolha !== politica.modo;

  return (
    <Card
      title="NFC-e no Finalizar"
      subtitle="Decisão do dono: a nota da venda sai sozinha ou pelo botão do painel fiscal do PDV."
    >
      <div className="flex flex-col gap-4">
        {politica === null && !erro && (
          <p role="status" className="text-[var(--gs-muted)] m-0">
            Carregando…
          </p>
        )}

        {politica && (
          <>
            <fieldset className="flex flex-col gap-3 border-0 p-0 m-0">
              <legend className="sr-only">Como a NFC-e sai no Finalizar</legend>
              <label className="flex gap-3 items-start cursor-pointer">
                <input
                  type="radio"
                  name="nfce-no-finalizar"
                  checked={escolha === 'MANUAL'}
                  onChange={() => setEscolha('MANUAL')}
                />
                <span className="flex flex-col">
                  <strong>Pelo botão do painel fiscal (padrão)</strong>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                    O Finalizar não emite. Depois de cada venda, o painel do PDV oferece &quot;emitir
                    NFC-e&quot; — ou diz o que falta para emitir.
                  </span>
                </span>
              </label>
              <label className="flex gap-3 items-start cursor-pointer">
                <input
                  type="radio"
                  name="nfce-no-finalizar"
                  checked={escolha === 'AUTOMATICA'}
                  onChange={() => setEscolha('AUTOMATICA')}
                />
                <span className="flex flex-col">
                  <strong>Sozinha, no Finalizar</strong>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                    Se a venda está pronta para emitir, a NFC-e sai sem clique, sem atrasar o
                    balcão. A venda que não está pronta sai sem nota, e o painel diz o que falta.
                  </span>
                </span>
              </label>
            </fieldset>

            {politica.atualizadoEm && (
              <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] m-0">
                Última alteração: {dataHoraBR(politica.atualizadoEm)}
              </p>
            )}

            <div>
              <Button loading={gravando} disabled={!mudou} onClick={() => void gravar()}>
                Gravar escolha
              </Button>
            </div>
          </>
        )}

        {aviso && (
          <p role="status" className="text-[length:var(--gs-text-sm)] text-[var(--gs-success)] m-0">
            {aviso}
          </p>
        )}
        {erro && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] m-0">
            {erro}
          </p>
        )}
      </div>
    </Card>
  );
}
