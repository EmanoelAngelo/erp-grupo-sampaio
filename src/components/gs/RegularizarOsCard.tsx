/**
 * A OS FORA DAS REGRAS, na ficha — e o conserto dela (GAP-PRD-188).
 *
 * O banco da loja tem OS gravada antes das regras de hoje: sem bancada, ou
 * parada em "em andamento" sem responsável. Ninguém a conclui (não foi
 * assumida) e ninguém a larga ("já está no quadro"); o conserto pedido era SQL.
 * Este cartão é o caminho pela tela: diz o que está fora e oferece à gestão os
 * dois destinos que o servidor aceita — devolver ao quadro, ou encerrar como
 * lançamento indevido (só sem dinheiro envolvido). Motivo sempre, e ele fica na
 * linha do tempo.
 *
 * Quem não é da gestão vê o aviso e a quem pedir; o formulário não aparece,
 * porque o servidor o recusaria.
 */
import { useState } from 'react';
import { Button, Card, Field } from './ui';
import { CampoBancada } from './BancadaDeEntrada';
import { useBancadasDeEntrada } from '@/hooks/useBancadasDeEntrada';
import { precisaEscolherBancada } from '@/lib/api/oficinaEntrada';
import {
  IRREGULARIDADE_DA_OS,
  oficinaQuadroApi,
  type DestinoDaRegularizacao,
} from '@/lib/api/oficinaQuadro';
import { ApiRequestError } from '@/lib/api/client';

export function RegularizarOsCard({
  orderId,
  numero,
  irregularidades,
  semDinheiro,
  naBancada,
  podeRegularizar,
  onRegularizada,
}: {
  orderId: string;
  numero: number;
  irregularidades: string[];
  /** Sem peça, mão de obra nem venda — só assim cabe "lançamento indevido". */
  semDinheiro: boolean;
  /** A OS ainda está na bancada (não foi para o caixa nem finalizou). */
  naBancada: boolean;
  podeRegularizar: boolean;
  onRegularizada: () => void;
}) {
  const [abrindo, setAbrindo] = useState(false);
  const [destino, setDestino] = useState<DestinoDaRegularizacao>('quadro');
  const [motivo, setMotivo] = useState('');
  const [bancada, setBancada] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const semBancada = irregularidades.includes('sem_bancada');
  const bancadas = useBancadasDeEntrada(abrindo && semBancada);
  const podeEncerrar = semDinheiro && naBancada;

  if (irregularidades.length === 0) return null;

  const confirmar = async () => {
    setErro(null);
    if (!motivo.trim()) {
      setErro('Diga o motivo: ele fica na linha do tempo da OS.');
      return;
    }
    if (semBancada && precisaEscolherBancada(bancadas) && !bancada) {
      setErro('Escolha a bancada em que a OS vai ficar.');
      return;
    }
    setOcupado(true);
    try {
      await oficinaQuadroApi.regularizar(orderId, {
        destino,
        motivo: motivo.trim(),
        ...(semBancada && bancada ? { workshopId: bancada } : {}),
      });
      setAbrindo(false);
      setMotivo('');
      onRegularizada();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível regularizar a OS.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Card
      title={`A OS #${numero} está fora das regras atuais`}
      className="mb-5 border-[var(--gs-warning)]"
    >
      <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)]">
        {irregularidades.map((i) => (
          <li key={i}>{IRREGULARIDADE_DA_OS[i] ?? i}</li>
        ))}
      </ul>

      {!podeRegularizar && (
        <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Quem regulariza é a gestão da oficina. Peça ao gerente.
        </p>
      )}

      {podeRegularizar && !abrindo && (
        <Button className="mt-3" variant="secondary" onClick={() => setAbrindo(true)}>
          Regularizar
        </Button>
      )}

      {podeRegularizar && abrindo && (
        <div className="mt-3 flex flex-col gap-3">
          <Field label="O que fazer com a OS" required>
            {({ id, 'aria-describedby': describedBy }) => (
              <div
                id={id}
                role="radiogroup"
                aria-describedby={describedBy}
                className="flex flex-wrap gap-2"
              >
                <Button
                  role="radio"
                  aria-checked={destino === 'quadro'}
                  variant={destino === 'quadro' ? 'primary' : 'ghost'}
                  onClick={() => setDestino('quadro')}
                >
                  Devolver ao quadro
                </Button>
                <Button
                  role="radio"
                  aria-checked={destino === 'encerrar'}
                  variant={destino === 'encerrar' ? 'primary' : 'ghost'}
                  disabled={!podeEncerrar}
                  title={
                    podeEncerrar
                      ? undefined
                      : 'Só OS na bancada e sem peça, mão de obra nem venda é lançamento indevido.'
                  }
                  onClick={() => setDestino('encerrar')}
                >
                  Encerrar como lançamento indevido
                </Button>
              </div>
            )}
          </Field>
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {destino === 'quadro'
              ? 'A OS ganha a bancada e, se estava numa coluna de trabalho sem responsável, volta '
                + 'para "em aberto": o próximo técnico a assume como qualquer outra.'
              : 'A OS fecha como finalizada, sem custo e sem cobrança. Use para OS de teste, '
                + 'duplicada ou aberta por engano. Nada é apagado: número e histórico ficam.'}
          </p>
          {semBancada && (
            <CampoBancada bancadas={bancadas} value={bancada} onChange={setBancada} />
          )}
          <Field label="Motivo" required hint="Fica na linha do tempo e na auditoria.">
            {(p) => (
              <textarea
                {...p}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                rows={2}
                maxLength={500}
                className="w-full px-3 py-2 border border-[var(--gs-border-strong)]
                  rounded-[var(--gs-radius)] text-[length:var(--gs-text-base)]"
              />
            )}
          </Field>
          {erro && (
            <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
          <div className="flex gap-2">
            <Button loading={ocupado} disabled={!motivo.trim()} onClick={() => void confirmar()}>
              Confirmar regularização
            </Button>
            <Button variant="ghost" onClick={() => setAbrindo(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
