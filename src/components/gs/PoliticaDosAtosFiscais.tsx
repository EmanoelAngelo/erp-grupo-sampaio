/**
 * A DECISÃO DO DONO: como o certificado entra nos atos com a SEFAZ
 * (GAP-PRD-005).
 *
 * Cancelamento, carta de correção e inutilização usam o A1 da operação. Duas
 * formas são possíveis, e a escolha muda o comportamento da tela de quem
 * cancela — por isso ela é do dono, e mora aqui, junto do certificado:
 *
 *  - COFRE (padrão): o mesmo segredo selado que a emissão usa. A senha do A1
 *    não trafega pelo navegador e não precisa ser conhecida por quem cancela;
 *    quem cancela continua sendo só gerência, com trilha de auditoria.
 *  - SENHA DIGITADA: cada ato pede a senha do certificado. Mais atrito — e o
 *    prazo de cancelamento da NFC-e é curto —, em troca de ninguém cancelar
 *    sem saber a senha.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { fiscalAtosApi, type PlanoDoAtoFiscal } from '@/lib/api/fiscalAtos';
import { dataHoraBR } from '@/lib/datas';

const COFRE_ROTULO: Record<PlanoDoAtoFiscal['cofre'], string> = {
  SELADO: 'Certificado no cofre, com a senha selada.',
  SEM_SENHA_SELADA:
    'Certificado no cofre SEM a senha selada: os atos pedem a senha até o .pfx ser reenviado com ela.',
  AUSENTE: 'Nenhum certificado no cofre: os atos com a SEFAZ ficam bloqueados até o envio do .pfx.',
};

export function PoliticaDosAtosFiscaisCard() {
  const [plano, setPlano] = useState<PlanoDoAtoFiscal | null>(null);
  const [escolha, setEscolha] = useState<boolean | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const atual = await fiscalAtosApi.plano(null);
      setPlano(atual);
      setEscolha(atual.politica.exigirSenhaDigitada);
      setErro(null);
    } catch (err) {
      setPlano(null);
      setErro(
        err instanceof ApiRequestError ? err.message : 'Não foi possível consultar a política dos atos.',
      );
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const gravar = useCallback(async () => {
    if (escolha === null) return;
    setBusy(true);
    setErro(null);
    setAviso(null);
    try {
      await fiscalAtosApi.gravarPolitica(escolha);
      setAviso(
        escolha
          ? 'Gravado: cancelamento, carta de correção, inutilização e a consulta e manifestação das '
            + 'notas destinadas passam a pedir a senha do certificado.'
          : 'Gravado: os atos com a SEFAZ usam o certificado do cofre, sem pedir a senha.',
      );
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao gravar a política.');
    } finally {
      setBusy(false);
    }
  }, [escolha, carregar]);

  const mudou = plano !== null && escolha !== null && escolha !== plano.politica.exigirSenhaDigitada;

  return (
    <Card
      title="Certificado nos atos com a SEFAZ"
      subtitle="Cancelamento, carta de correção, inutilização e a consulta e manifestação das notas destinadas (Entrada de notas). A emissão sempre usa o cofre."
    >
      <div className="flex flex-col gap-4">
        {plano === null && !erro && (
          <p role="status" className="text-[var(--gs-muted)] m-0">
            Carregando…
          </p>
        )}

        {plano && (
          <>
            <fieldset className="flex flex-col gap-3 border-0 p-0 m-0">
              <legend className="sr-only">Como o certificado entra nos atos com a SEFAZ</legend>
              <label className="flex gap-3 items-start cursor-pointer">
                <input
                  type="radio"
                  name="politica-dos-atos"
                  checked={escolha === false}
                  onChange={() => setEscolha(false)}
                />
                <span className="flex flex-col">
                  <strong>Usar o certificado do cofre (padrão)</strong>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                    A senha do A1 não passa pelo navegador nem precisa ser sabida por quem cancela.
                    Só a gerência faz esses atos, e cada um fica registrado com o autor.
                  </span>
                </span>
              </label>
              <label className="flex gap-3 items-start cursor-pointer">
                <input
                  type="radio"
                  name="politica-dos-atos"
                  checked={escolha === true}
                  onChange={() => setEscolha(true)}
                />
                <span className="flex flex-col">
                  <strong>Pedir a senha do certificado a cada ato</strong>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                    Ninguém cancela, corrige, inutiliza, busca ou manifesta as notas destinadas sem
                    digitar a senha do A1. Atenção: o prazo para cancelar a NFC-e é curto.
                  </span>
                </span>
              </label>
            </fieldset>

            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] m-0">
              {COFRE_ROTULO[plano.cofre]}
            </p>

            {plano.politica.atualizadoEm && (
              <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] m-0">
                Última alteração: {dataHoraBR(plano.politica.atualizadoEm)}
              </p>
            )}

            <div>
              <Button loading={busy} disabled={!mudou} onClick={() => void gravar()}>
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
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)] m-0">{erro}</p>
        )}
      </div>
    </Card>
  );
}
