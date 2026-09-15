/**
 * A PLAQUINHA DA MÁQUINA, NA FICHA — reimprimir e trocar (GAP-PRD-107).
 *
 * O adesivo descasca no sol. A tela de plaquinhas oferecia "danificar" — e
 * recusava a plaquinha já colada ("use a substituição") —, e a substituição
 * existia só na API: a máquina ficava sem QR legível até alguém chamar o
 * desenvolvedor. Aqui ficam os dois gestos, onde a pessoa está olhando para a
 * máquina:
 *
 *   Reimprimir  o MESMO adesivo (mesmo número, mesmo QR). Serve quando o
 *               papel estragou e o número continua valendo.
 *   Trocar      outra plaquinha do pool (já impressa e liberada) entra na
 *               máquina; a velha é aposentada e o QR dela para de responder.
 *               Serve quando o adesivo se perdeu. Motivo obrigatório: o
 *               número da máquina muda, e o histórico diz por quê.
 *
 * O botão de trocar só aparece quando o servidor diz que a máquina pode (a
 * empresa usa o pool e a bancada dá QR à máquina) e para quem a rota aceita.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Field } from './ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  escreverFolha,
  plaquinhaDaMaquinaApi,
  type PlaquinhaLivre,
} from '@/lib/api/plaquinhaDaMaquina';

export function PlaquinhaDaMaquinaCard({
  equipmentId,
  rotulo,
  empresaUsa,
  bancadaUsa,
  podeImprimir,
  podeTrocar,
  onTrocada,
}: {
  equipmentId: string;
  rotulo: string;
  empresaUsa: boolean;
  bancadaUsa: boolean;
  podeImprimir: boolean;
  podeTrocar: boolean;
  onTrocada: (resultado: { anterior: string; atual: string }) => void;
}) {
  const [trocando, setTrocando] = useState(false);
  const [livres, setLivres] = useState<PlaquinhaLivre[] | null>(null);
  const [escolhida, setEscolhida] = useState('');
  const [motivo, setMotivo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    if (!trocando || livres !== null) return undefined;
    let vivo = true;
    plaquinhaDaMaquinaApi
      .livres()
      .then((r) => {
        if (vivo) setLivres(r.items);
      })
      .catch((err) => {
        if (!vivo) return;
        setLivres([]);
        setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível ler as plaquinhas livres.');
      });
    return () => {
      vivo = false;
    };
  }, [trocando, livres]);

  // Celular não ganha plaquinha: a ficha não fala de adesivo nenhum.
  //
  // E a empresa fora da PJ Motors também não (P0 das plaquinhas). O cartão
  // oferecia "Reimprimir" à Oficina — `POST /labels/equipment/sheet` agora é
  // 403 fora da PJ — e, sem pool, uma frase mandando ligar a plaquinha em
  // Empresas, que também é recusado. O número da máquina continua no topo da
  // ficha, só leitura.
  if (!bancadaUsa || !empresaUsa) return null;

  const reimprimir = async () => {
    setErro(null);
    setAviso(null);
    const janela = window.open('', '_blank');
    setOcupado(true);
    try {
      const folha = await plaquinhaDaMaquinaApi.reimprimir(equipmentId);
      if (!escreverFolha(janela, folha.html)) {
        setErro('O navegador bloqueou a janela da folha. Libere pop-ups para este endereço e tente de novo.');
      } else if (folha.abaixoDoPiso) {
        setAviso('Atenção: neste formato o QR sai pequeno demais para o celular ler com folga.');
      }
    } catch (err) {
      janela?.close();
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível gerar a folha.');
    } finally {
      setOcupado(false);
    }
  };

  const trocar = async () => {
    setErro(null);
    if (!escolhida) {
      setErro('Escolha a plaquinha nova — a que vai ser colada na máquina.');
      return;
    }
    if (!motivo.trim()) {
      setErro('Diga por que a plaquinha está sendo trocada.');
      return;
    }
    setOcupado(true);
    try {
      const resultado = await plaquinhaDaMaquinaApi.trocar({
        equipmentId,
        novaTagId: escolhida,
        motivo: motivo.trim(),
      });
      setTrocando(false);
      setLivres(null);
      setEscolhida('');
      setMotivo('');
      setAviso(
        `A máquina agora é ${resultado.atual}. A ${resultado.anterior} foi aposentada: o QR dela não `
          + 'responde mais — retire o adesivo velho.',
      );
      onTrocada(resultado);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível trocar a plaquinha.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Card title="Plaquinha" className="mb-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[length:var(--gs-text-lg)] font-bold tabular-nums">{rotulo}</span>
        {podeImprimir && (
          <Button variant="secondary" loading={ocupado && !trocando} onClick={() => void reimprimir()}>
            Reimprimir plaquinha
          </Button>
        )}
        {podeTrocar && !trocando && (
          <Button variant="secondary" onClick={() => setTrocando(true)}>
            Trocar plaquinha
          </Button>
        )}
      </div>

      {aviso && (
        <p role="status" className="mt-3 mb-0 text-[length:var(--gs-text-sm)] font-semibold">
          {aviso}
        </p>
      )}

      {trocando && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Use quando o adesivo se perdeu ou o QR não pode mais valer. Se só o papel estragou,
            reimprimir mantém o mesmo número.
          </p>
          {livres === null && (
            <p role="status" className="m-0 text-[var(--gs-muted)]">
              Carregando plaquinhas livres…
            </p>
          )}
          {livres !== null && livres.length === 0 && (
            <p className="m-0 text-[length:var(--gs-text-sm)]">
              Nenhuma plaquinha impressa e liberada esperando máquina.{' '}
              <Link to="/sistema/equipamentos/plaquinhas">Gere e libere um lote em Plaquinhas</Link> e
              volte aqui.
            </p>
          )}
          {livres !== null && livres.length > 0 && (
            <>
              <Field label="Plaquinha nova" required hint="Só as já impressas e liberadas.">
                {(p) => (
                  <select
                    {...p}
                    value={escolhida}
                    onChange={(e) => setEscolhida(e.target.value)}
                    className="h-10 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                  >
                    <option value="">Escolha a plaquinha</option>
                    {livres.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.publicIdLabel}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Motivo da troca" required hint="Fica no histórico da máquina.">
                {(p) => (
                  <textarea
                    {...p}
                    rows={2}
                    maxLength={300}
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="Ex.: adesivo descascou no sol; QR ilegível"
                    className="w-full px-3 py-2 border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)]"
                  />
                )}
              </Field>
            </>
          )}
          <div className="flex gap-2">
            {livres !== null && livres.length > 0 && (
              <Button loading={ocupado} onClick={() => void trocar()}>
                Trocar a plaquinha
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => {
                setTrocando(false);
                setErro(null);
              }}
            >
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {erro && (
        <p role="alert" className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
    </Card>
  );
}
