/**
 * A "VENDA À MÃO" DA PLAQUINHA INTERNA, DESFEITA PELA FICHA — GAP-PRD-189.
 *
 * O registro de dono à mão da moto que ainda estava no pátio deixava a
 * plaquinha vendida sem venda nenhuma no sistema, e a única volta era mexer no
 * banco. Aqui a gestão da oficina desfaz, com motivo: a plaquinha volta a poder
 * ser vinculada à unidade da loja, e a venda sai pelo PDV — com estoque,
 * financeiro e nota. O motivo e o dono anterior ficam no histórico.
 *
 * Se a moto saiu antes do sistema, o registro está certo e deve ficar: por isso
 * o cartão explica antes de oferecer o botão.
 */
import { useState } from 'react';
import { Button, Field, Input } from './ui';
import { ApiRequestError } from '@/lib/api/client';
import { dataBR } from '@/lib/datas';
import { vendaAMaoApi } from '@/lib/api/fronteiraOficina';

export function VendaAMaoCard({
  equipmentId,
  ownerName,
  soldAt,
  podeDesfazer,
  onDesfeita,
}: {
  equipmentId: string;
  ownerName: string | null;
  soldAt: string | null;
  podeDesfazer: boolean;
  onDesfeita: () => void;
}) {
  const [abrindo, setAbrindo] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const desfazer = async () => {
    setOcupado(true);
    setErro(null);
    try {
      await vendaAMaoApi.desfazer(equipmentId, motivo.trim());
      setAbrindo(false);
      setMotivo('');
      onDesfeita();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível desfazer o registro de venda.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <section
      aria-label="Venda registrada à mão"
      className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)] flex flex-col gap-3"
    >
      <p className="m-0">
        <strong>Vendida à mão, sem venda no sistema.</strong> Dono registrado:{' '}
        {ownerName ?? 'sem nome'}
        {soldAt ? ` desde ${dataBR(soldAt)}` : ''}. Se esta moto ainda está no pátio de uma loja do
        grupo, desfaça o registro: a plaquinha volta a poder ser vinculada à unidade, e a venda sai
        pelo PDV — com estoque, financeiro e nota. Se ela saiu antes do sistema, o registro está certo
        e deve ficar.
      </p>
      {podeDesfazer &&
        (abrindo ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Motivo" hint="Fica no histórico da máquina, com o dono anterior.">
              {(p) => <Input {...p} value={motivo} onChange={(e) => setMotivo(e.target.value)} />}
            </Field>
            <Button loading={ocupado} disabled={motivo.trim().length < 3} onClick={() => void desfazer()}>
              Confirmar
            </Button>
            <Button variant="ghost" onClick={() => setAbrindo(false)}>
              Cancelar
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setAbrindo(true)}>
              Desfazer registro de venda
            </Button>
          </div>
        ))}
      {erro && (
        <p role="alert" className="m-0 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
    </section>
  );
}
